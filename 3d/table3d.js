/*
 * table3d.js — a live WebGL replacement for the flat felt image.
 *
 * Renders a 3D poker table (felt + a raised, beveled rail) and slots it UNDER
 * the game's 2D pieces (seats, cards, chips, pot, button) inside
 * .iogc-GameWindow-table. The camera matches the painted art's slight backward
 * tilt (same framing chips3d uses for the chip portal), so the felt projects to
 * exactly the on-screen region the flat art occupied — every card and chip that
 * the site positions in that (already foreshortened) space stays aligned, while
 * the tilt + rail bevel + lighting give real 3D depth.
 *
 * Loaded as a content script after vendor/three.iife.js (THREE) and chips3d.js;
 * exposes window.GPE_TABLE3D = { enable, disable, isOn }. content.js drives it
 * from the "3D table" setting. Opt-in; fully disposed when off (no context leak).
 */
(function () {
    "use strict";

    // ---------- where our own files live ----------
    // Two very different answers depending on how we were loaded, which is why
    // this can't just be chrome.runtime.getURL:
    //   - as an extension content script there is no currentScript, and assets
    //     resolve against the extension root;
    //   - in the site-hosted build we're a plain <script> under
    //     tools.gpokr.com/<version>/3d/, so assets are one level up from us.
    // Same trick content.js uses for SELF_SRC. This existing as a helper is what
    // fixed the felt watermark, which had never once rendered on the site build:
    // the old code called chrome.runtime.getURL inside a try/catch and silently
    // returned when it threw.
    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function assetUrl(path) {
        if (SELF_SRC) {
            try { return new URL("../" + path, SELF_SRC).href; } catch (e) { /* fall through */ }
        }
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    // ---------- felt geometry, measured off the 790px art (see chips3d.js) ----------
    const ART_W = 790;
    const FELT_CX_PX = 395;      // felt center x, element space
    const FELT_CY_PX = 190;      // felt center y (220 in art, less the 30px bg offset)
    const FELT_HALF_W_PX = 290;  // felt half-length, as painted
    const FELT_HALF_D_PX = 102;  // felt half-depth, as painted (already foreshortened)
    const FELT_Y_NUDGE = -9;     // shift the whole render up (art px) to sit on the old felt

    // ---------- camera (matches the art's tilt) ----------
    const ELEV_DEG = 64;         // 90 = straight down; lower tilts the table back more
    const FOV = 42;
    const VIEW_W = 40;           // world units spanning the table width

    // ---------- look (tuning knobs) ----------
    // The painted rail is a thin (~20px art), low-profile band; keep it slim.
    const RAIL_W = 0.92;         // rail band width, world units (~18 art px)
    const RAIL_H = 0.42;         // rail height above the felt (low, like the art)
    const RAIL_BEVEL = 0.16;     // subtle rounded lip on the rail's top
    const FELT_DROP = 0.1;       // felt sits a hair below the rail base

    const COL_FELT = 0x2f6360;   // gpokr's teal-green felt
    const COL_FELT_EDGE = 0x213f40;
    const COL_RAIL = 0x211d15;   // warm dark leather (a touch lighter so the grain reads)
    // Outside the rail. Black matches the DARK art's corners, which is where this
    // came from — and it is wrong in light mode, where the site's own felt art has
    // pale corners and a black surround reads as a hole punched in the page. So
    // black is only the fallback: sampleSurround() below takes the colour from
    // whatever art the page actually has behind the table, and the user can
    // override it outright.
    const COL_SURROUND = 0x000000;

    const AMBIENT = 0.46;        // low, so the felt keeps a center-bright pool
    const KEY = 0.5;             // directional key (shapes the rail bevel)
    const KEY_POS = [-6, 15, 11]; // upper, slightly left, toward the viewer
    const FILL = 0.16;
    // Overhead "table light": a point light over the felt center with real
    // distance falloff (decay 2), so the felt is brightest in the middle and
    // softly darkens toward the edges — the painted felt's radial vignette.
    // Tuned so the far ends sit ~60% of center brightness, like the art.
    const OVERHEAD = 680;        // candela-ish (large because decay 2 divides by d^2)
    const OVERHEAD_H = 18;       // higher = gentler/broader pool
    const OVERHEAD_DECAY = 2;
    const OVERHEAD_COL = 0xfff2df;

    // gpokr logo watermark on the felt center.
    const LOGO_OPACITY = 0.2;
    const LOGO_W = 13;           // logo width, world units (centered on the felt)

    // Base texture tiling, in *tile counts* across the felt width (UVs are
    // normalized to 0..1 by normalizeUV, so these are literal repeats). The
    // vertical repeat is derived from the felt aspect so tiles stay ~square.
    // feltZoom / leatherZoom scale them live from the tools-tab editor: >1 zooms
    // IN (bigger threads/grain), <1 zooms out. Applied via applyTexZoom().
    const FELT_COLOR_REPEAT = 1.7;   // few color tiles -> magnified, crisp, visible cloth
    const FELT_NORMAL_REPEAT = 4.2;  // relief bumps: finer felt nap
    const RAIL_REPEAT = 6;           // leather grain tiles around the rail
    let feltZoom = 0.5, leatherZoom = 10;
    // Relief depth (normal-map strength) and felt/leather tints — all driven live
    // from the tools-tab editor.
    let feltDepth = 0, leatherDepth = 0.1;
    let feltColorHex = "#2f6360";    // COL_FELT as a hex tint for the felt material
    let leatherColorHex = "#1d1a16"; // near-black brown tint for the rail material
    let logoOpacity = LOGO_OPACITY;  // felt-center watermark opacity (editor)

    function tableEl() { return document.querySelector(".iogc-GameWindow-table"); }

    let session = null;
    let broken = false;

    // ---------- a rounded "stadium" outline (rectangle with fully-round ends) ----------
    function stadium(T, Ctor, halfW, halfD) {
        const s = new Ctor();
        const r = Math.min(halfD, halfW);
        const x = halfW - r;
        s.moveTo(-x, -halfD);
        s.lineTo(x, -halfD);
        s.absarc(x, 0, r, -Math.PI / 2, Math.PI / 2, false);
        s.lineTo(-x, halfD);
        s.absarc(-x, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
        return s;
    }

    // A cloth normal map built from the gradient of smoothed noise (with a
    // slight directional stretch = fiber grain), so the felt has visible relief
    // that catches the light. Must be tiled at a scale where the bumps are a few
    // px on screen (see repeat below) or they mipmap away to flat.
    function feltNormalTexture(T) {
        const N = 256;
        const a = makeNoise(24), b = makeNoise(60), c = makeNoise(150);
        const height = (u, v) => 0.5 * a(u, v * 1.4) + 0.32 * b(u, v * 1.8) + 0.18 * c(u, v * 2.2);
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const img = ctx.createImageData(N, N);
        const e = 1.5 / N, STR = 3.0;
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const dx = (height(u + e, v) - height(u - e, v)) * STR;
                const dy = (height(u, v + e) - height(u, v - e)) * STR;
                const len = Math.hypot(dx, dy, 1);
                const i = (y * N + x) * 4;
                img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
                img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
                img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const tex = new T.CanvasTexture(cv);
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex; // repeat set centrally in applyTexZoom()
    }

    // Rewrite a geometry's UVs to a clean 0..1 range over its own extent.
    // ShapeGeometry / ExtrudeGeometry emit UVs in raw *world units* (here ±14.7),
    // so a small texture repeat never tiled — the map minified to its average and
    // read as a flat color. Normalizing lets repeat mean literal tile counts.
    function normalizeUV(geo) {
        const uv = geo && geo.attributes && geo.attributes.uv;
        if (!uv) return;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i < uv.count; i++) {
            const x = uv.getX(i), y = uv.getY(i);
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
        const dx = (maxx - minx) || 1, dy = (maxy - miny) || 1;
        for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, (uv.getX(i) - minx) / dx, (uv.getY(i) - miny) / dy);
        }
        uv.needsUpdate = true;
    }

    // Tileable value noise (smoothstep-interpolated grid), for procedural grain.
    function makeNoise(cells) {
        const g = new Float32Array(cells * cells);
        for (let i = 0; i < g.length; i++) g[i] = Math.random();
        const sm = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
        return (u, v) => {
            const x = u * cells, y = v * cells;
            const x0 = ((Math.floor(x) % cells) + cells) % cells, y0 = ((Math.floor(y) % cells) + cells) % cells;
            const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
            const fx = x - Math.floor(x), fy = y - Math.floor(y);
            return sm(sm(g[y0 * cells + x0], g[y0 * cells + x1], fx),
                      sm(g[y1 * cells + x0], g[y1 * cells + x1], fx), fy);
        };
    }

    // A procedural felt LUMINANCE map (grayscale cloth variation: soft cloud
    // mottling + fiber grain + speckle). The felt COLOR lives on the material
    // (feltMat.color) so the editor can recolor it live — result = tint x this.
    function feltColorTexture(T) {
        const N = 512;
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const lo = makeNoise(6), mid = makeNoise(22), fib = makeNoise(90), speck = makeNoise(210);
        const img = ctx.createImageData(N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const cloud = 0.6 * lo(u, v) + 0.4 * mid(u, v);        // soft unevenness
                const fiber = fib(u, v * 3.4);                          // stretched -> fiber streaks
                const sp = speck(u, v);                                 // fine speckle
                const k = 0.86 + 0.22 * (cloud - 0.5) + 0.26 * (fiber - 0.5) + 0.16 * (sp - 0.5);
                const g = Math.max(0, Math.min(255, 255 * k));
                const i = (y * N + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.LinearSRGBColorSpace; // a multiplier, not sRGB color data
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex; // repeat set centrally in applyTexZoom()
    }

    // A leather LUMINANCE map (grayscale pebble grain: lighter crowns, darker
    // crevices). The leather COLOR lives on the material (railMat.color) so the
    // editor can recolor it live — result = tint x this luminance.
    function leatherColorTexture(T) {
        const N = 256;
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const peb = makeNoise(14), grain = makeNoise(40), fine = makeNoise(110);
        const img = ctx.createImageData(N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const p = peb(u, v), g = grain(u, v), f = fine(u, v);
                const k = 0.72 + 0.5 * (p - 0.5) + 0.28 * (g - 0.5) + 0.16 * (f - 0.5);
                const val = Math.max(0, Math.min(255, 255 * k));
                const i = (y * N + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.LinearSRGBColorSpace; // a multiplier, not sRGB color data
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex; // repeat set centrally in applyTexZoom()
    }

    // A leather normal map (gradient of the same pebble height field) so the
    // grain catches the light with real relief.
    function leatherNormalTexture(T) {
        const N = 256;
        const a = makeNoise(14), b = makeNoise(40), c = makeNoise(110);
        const height = (u, v) => 0.55 * a(u, v) + 0.3 * b(u, v) + 0.15 * c(u, v);
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const img = ctx.createImageData(N, N);
        const e = 1.5 / N, STR = 2.6;
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const dx = (height(u + e, v) - height(u - e, v)) * STR;
                const dy = (height(u, v + e) - height(u, v - e)) * STR;
                const len = Math.hypot(dx, dy, 1);
                const i = (y * N + x) * 4;
                img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
                img.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
                img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const tex = new T.CanvasTexture(cv);
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex; // repeat set centrally in applyTexZoom()
    }

    // Apply the current felt/leather zoom to the live textures (repeat = base /
    // zoom, so higher zoom = fewer tiles = bigger features). UVs are normalized
    // 0..1, so we scale the vertical repeat by the felt aspect to keep tiles
    // ~square. updateMatrix() forces the change into the sampled UV transform.
    function bumpTex(tex, rx, ry) {
        if (!tex) return;
        tex.repeat.set(rx, ry);
        tex.matrixAutoUpdate = true;
        tex.updateMatrix();
    }
    function applyTexZoom(s) {
        const asp = s.feltAspect || 2.5;               // width / depth of the felt
        bumpTex(s.feltColor, FELT_COLOR_REPEAT / feltZoom, (FELT_COLOR_REPEAT / feltZoom) / asp);
        bumpTex(s.feltNormal, FELT_NORMAL_REPEAT / feltZoom, (FELT_NORMAL_REPEAT / feltZoom) / asp);
        bumpTex(s.railColor, RAIL_REPEAT / leatherZoom, (RAIL_REPEAT / leatherZoom) / asp);
        bumpTex(s.railNormal, RAIL_REPEAT / leatherZoom, (RAIL_REPEAT / leatherZoom) / asp);
    }
    function setTexZoom(fz, lz) {
        if (typeof fz === "number" && isFinite(fz) && fz > 0) feltZoom = fz;
        if (typeof lz === "number" && isFinite(lz) && lz > 0) leatherZoom = lz;
        if (session) { applyTexZoom(session); session.needsRender = Math.max(session.needsRender, 2); }
    }

    // Relief depth = normal-map strength (0 = flat, higher = deeper texture).
    function applyDepth(s) {
        if (s.feltMat) s.feltMat.normalScale.set(feltDepth, feltDepth);
        if (s.railMat) s.railMat.normalScale.set(leatherDepth, leatherDepth);
    }
    function setTexDepth(fd, ld) {
        if (typeof fd === "number" && isFinite(fd) && fd >= 0) feltDepth = fd;
        if (typeof ld === "number" && isFinite(ld) && ld >= 0) leatherDepth = ld;
        if (session) { applyDepth(session); session.needsRender = Math.max(session.needsRender, 2); }
    }
    // Live felt tint (a hex string). The felt map is grayscale, so this recolors
    // the whole felt instantly with no texture regeneration.
    // ---------- surround ----------
    let surroundHex = "";   // "" = follow the page's art

    function applySurround(s) {
        if (!s || !s.renderer) return;
        const T = window.THREE;
        try {
            s.renderer.setClearColor(surroundHex ? new T.Color(surroundHex) : COL_SURROUND, 1);
            s.needsRender = Math.max(s.needsRender, 2);
        } catch (e) {}
    }

    function setSurroundColor(hex) {
        surroundHex = (typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex)) ? hex : "";
        if (session) {
            applySurround(session);
            if (!surroundHex) sampleSurround();   // back to following the art
        }
    }

    // Read the corner pixel of the felt art the page is showing and use that as the
    // surround, so the canvas blends into the page instead of announcing itself.
    // This is what makes light mode work without a hardcoded colour: dark mode
    // swaps in our dark table.png (black corners), light mode keeps the site's own
    // pale jpg, and both are sampled the same way. Same-origin art, so the canvas
    // read is clean; anything unexpected leaves the fallback in place.
    function sampleSurround() {
        if (surroundHex) return;   // an explicit choice wins
        let url = null;
        try {
            const host = document.querySelector(".iogc-GameWindow-table");
            const bg = host && getComputedStyle(host).backgroundImage;
            const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
            url = m && m[1];
        } catch (e) { return; }
        if (!url) return;
        const img = new Image();
        img.onload = () => {
            try {
                const cv = document.createElement("canvas");
                cv.width = cv.height = 1;
                // Top-left corner: outside the painted oval in both variants.
                cv.getContext("2d").drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
                const d = cv.getContext("2d").getImageData(0, 0, 1, 1).data;
                if (surroundHex) return;      // the user chose while we were loading
                const T = window.THREE;
                if (session && session.renderer) {
                    session.renderer.setClearColor(new T.Color(d[0] / 255, d[1] / 255, d[2] / 255), 1);
                    session.needsRender = Math.max(session.needsRender, 2);
                }
            } catch (e) { /* tainted or decoded oddly: keep the fallback */ }
        };
        img.onerror = () => {};
        img.src = url;
    }

    function setFeltColor(hex) {
        if (typeof hex === "string" && hex) feltColorHex = hex;
        if (session && session.feltMat) {
            session.feltMat.color.set(feltColorHex);
            session.needsRender = Math.max(session.needsRender, 2);
        }
    }
    // Live leather tint (the rail map is grayscale, so this recolors instantly).
    function setLeatherColor(hex) {
        if (typeof hex === "string" && hex) leatherColorHex = hex;
        if (session && session.railMat) {
            session.railMat.color.set(leatherColorHex);
            session.needsRender = Math.max(session.needsRender, 2);
        }
    }
    // Live gpokr-logo watermark opacity (0 = hidden, 1 = solid).
    function setLogoOpacity(v) {
        if (typeof v === "number" && isFinite(v) && v >= 0) logoOpacity = Math.min(1, v);
        if (session && session.logoMat) {
            session.logoMat.opacity = logoOpacity;
            session.needsRender = Math.max(session.needsRender, 2);
        }
    }

    // Load the bundled gpokr logo (one of our own resources either way, so no
    // cross-origin taint) and hand back a CanvasTexture + its aspect ratio.
    function loadLogoTexture(T, onReady) {
        const url = assetUrl("assets/gpokr-logo.svg");
        if (!url) return;
        const img = new Image();
        img.onload = () => {
            const w = 512, h = Math.max(1, Math.round(512 * (img.naturalHeight || 74) / (img.naturalWidth || 184)));
            const cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            cv.getContext("2d").drawImage(img, 0, 0, w, h);
            let tex;
            try {
                tex = new T.CanvasTexture(cv);
                tex.colorSpace = T.SRGBColorSpace;
                tex.anisotropy = 4;
            } catch (e) { return; }
            onReady(tex, w / h);
        };
        img.onerror = () => {};
        img.src = url;
    }

    // ---------- layer: an absolute canvas pinned behind the game pieces ----------
    function makeLayer(el) {
        const canvas = document.createElement("canvas");
        canvas.id = "gpe-table3d";
        canvas.style.position = "absolute";
        canvas.style.left = "0";
        canvas.style.top = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.zIndex = "-1";        // under the static seat table, over the host bg
        canvas.style.pointerEvents = "none";
        const saved = { position: el.style.position, zIndex: el.style.zIndex };
        el.style.position = "relative";    // stacking context for the z-index:-1 child
        el.style.zIndex = "0";
        el.insertBefore(canvas, el.firstChild);
        return { canvas, host: el, saved };
    }

    // Frame the camera so world origin (felt center) projects to the art's felt
    // center at the art's scale — identical to chips3d, minus its portal padding.
    function syncToTable(s) {
        const el = tableEl();
        if (!el) return "gone";
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        const p = s.placed;
        if (p && p.w === r.width && p.h === r.height) return false;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = Math.round(r.width), ch = Math.round(r.height);
        s.renderer.setPixelRatio(dpr);
        s.renderer.setSize(cw, ch, false);

        const wpp = VIEW_W / r.width;      // world units per css px
        const scale = r.width / ART_W;     // css px per art px
        const d = (ch * wpp) / (2 * Math.tan((FOV * Math.PI) / 180 / 2));
        const tx = -(FELT_CX_PX * scale - cw / 2) * wpp;
        const tz = -((FELT_CY_PX + FELT_Y_NUDGE) * scale - ch / 2) * wpp / s.sinE;

        const cam = s.camera;
        cam.fov = FOV;
        cam.aspect = cw / ch;
        cam.position.set(tx, d * s.sinE, tz + d * s.cosE);
        cam.lookAt(tx, 0, tz);
        cam.updateProjectionMatrix();

        s.placed = { w: r.width, h: r.height };
        return true;
    }

    function buildScene(s) {
        const T = window.THREE;
        s.scene = new T.Scene();

        s.scene.add(new T.AmbientLight(0xffffff, AMBIENT));
        const key = new T.DirectionalLight(0xffffff, KEY);
        key.position.set(KEY_POS[0], KEY_POS[1], KEY_POS[2]);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        const sc = key.shadow.camera;
        sc.left = -22; sc.right = 22; sc.top = 16; sc.bottom = -16;
        sc.near = 1; sc.far = 80;
        sc.updateProjectionMatrix();
        s.scene.add(key);
        const fill = new T.DirectionalLight(0xbfd0d8, FILL);
        fill.position.set(8, 9, -6);
        s.scene.add(fill);

        // Overhead table light with falloff -> center-bright felt (see notes).
        const overhead = new T.PointLight(OVERHEAD_COL, OVERHEAD, 0, OVERHEAD_DECAY);
        overhead.position.set(0, OVERHEAD_H, 2);
        s.scene.add(overhead);

        const A = FELT_HALF_W_PX * (VIEW_W / ART_W);           // felt half-width, world
        const B = FELT_HALF_D_PX * (VIEW_W / ART_W) / s.sinE;  // felt half-depth (un-foreshortened)
        s.feltA = A; s.feltB = B;
        s.feltAspect = A / B;                                   // for ~square texture tiles

        // ---- felt surface ----
        s.feltNormal = feltNormalTexture(T);
        s.feltColor = feltColorTexture(T);
        s.feltGeo = new T.ShapeGeometry(stadium(T, T.Shape, A, B), 40);
        normalizeUV(s.feltGeo);
        s.feltMat = new T.MeshStandardMaterial({
            color: new T.Color(feltColorHex), roughness: 0.82, metalness: 0.0,
            map: s.feltColor, normalMap: s.feltNormal,
        });
        // normalScale (relief depth) set centrally in applyDepth()
        const felt = new T.Mesh(s.feltGeo, s.feltMat);
        felt.rotation.x = -Math.PI / 2;      // lie flat (XY shape -> XZ ground)
        felt.position.y = -FELT_DROP;
        felt.receiveShadow = true;
        s.scene.add(felt);

        // ---- rail: extruded stadium ring with a beveled top ----
        const ring = stadium(T, T.Shape, A + RAIL_W, B + RAIL_W);
        ring.holes.push(stadium(T, T.Shape, A, B));
        s.railGeo = new T.ExtrudeGeometry(ring, {
            depth: RAIL_H - RAIL_BEVEL, bevelEnabled: true,
            bevelThickness: RAIL_BEVEL, bevelSize: RAIL_BEVEL, bevelSegments: 4,
            curveSegments: 40,
        });
        normalizeUV(s.railGeo);
        s.railColor = leatherColorTexture(T);
        s.railNormal = leatherNormalTexture(T);
        s.railMat = new T.MeshStandardMaterial({
            color: new T.Color(leatherColorHex), roughness: 0.6, metalness: 0.1,
            map: s.railColor, normalMap: s.railNormal,
        });
        // normalScale (relief depth) set centrally in applyDepth()
        const rail = new T.Mesh(s.railGeo, s.railMat);
        rail.rotation.x = -Math.PI / 2;      // extrude (local +z) -> world +y (up)
        rail.castShadow = true;
        rail.receiveShadow = true;
        s.scene.add(rail);

        // ---- felt-edge wall: a THIN RING at the rim between the recessed felt
        // and the rail's inner face. Must be a ring (with a hole) — a solid
        // stadium here extrudes into a slab whose top face covers the whole felt.
        const wallShape = stadium(T, T.Shape, A, B);
        wallShape.holes.push(stadium(T, T.Shape, A - 0.45, B - 0.45));
        s.wallGeo = new T.ExtrudeGeometry(wallShape, {
            depth: FELT_DROP + 0.05, bevelEnabled: false, curveSegments: 40,
        });
        normalizeUV(s.wallGeo);
        s.wallMat = new T.MeshStandardMaterial({ color: COL_FELT_EDGE, roughness: 0.85 });
        const wall = new T.Mesh(s.wallGeo, s.wallMat);
        wall.rotation.x = -Math.PI / 2;
        wall.position.y = -FELT_DROP;
        wall.receiveShadow = true;
        s.scene.add(wall);

        applyTexZoom(s); // set all texture repeats from the current zoom
        applyDepth(s);   // set relief depth (normal-map strength)

        // ---- gpokr logo watermark on the felt center (loads async) ----
        loadLogoTexture(T, (tex, aspect) => {
            if (!s.enabled) { tex.dispose(); return; }
            s.logoTex = tex;
            s.logoGeo = new T.PlaneGeometry(LOGO_W, LOGO_W / aspect);
            // depthTest:false + renderOrder so it always composites onto the felt
            // (a plane at felt height otherwise loses the depth test against it).
            s.logoMat = new T.MeshBasicMaterial({
                map: tex, transparent: true, opacity: logoOpacity,
                depthWrite: false, depthTest: false,
            });
            const logo = new T.Mesh(s.logoGeo, s.logoMat);
            logo.renderOrder = 10;
            logo.rotation.x = -Math.PI / 2;
            logo.position.set(0, 0.05, 0);  // just above the felt, centered
            s.scene.add(logo);
            s.needsRender = Math.max(s.needsRender, 2); // redraw now it's in
        });
    }

    // ---------- lifecycle ----------
    function loop(s) {
        if (!s.enabled) return;
        s.raf = requestAnimationFrame(() => loop(s));
        const r = syncToTable(s);
        if (r === "gone") { disable(); return; }
        if (r) s.needsRender = Math.max(s.needsRender, 2);
        if (s.needsRender > 0) { s.renderer.render(s.scene, s.camera); s.needsRender--; }
    }

    function bail(why, err) { console.warn("[gpe] table3d: " + why, err || ""); return false; }

    function enable() {
        if (session) return true;
        if (broken) return false;
        const T = window.THREE;
        if (!T) return bail("three.js missing");
        const el = tableEl();
        if (!el) return bail("no .iogc-GameWindow-table");

        const { canvas, host, saved } = makeLayer(el);
        const e = (ELEV_DEG * Math.PI) / 180;
        const s = {
            canvas, host, saved, placed: null, enabled: true, raf: 0, needsRender: 3,
            sinE: Math.sin(e), cosE: Math.cos(e),
        };
        try {
            s.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
            s.renderer.setClearColor(COL_SURROUND, 1);
            applySurround(s);
            sampleSurround();   // then match the page's own art, if we can read it
            s.renderer.shadowMap.enabled = true;
            s.renderer.shadowMap.type = T.PCFShadowMap;
            s.renderer.outputColorSpace = T.SRGBColorSpace;
            s.camera = new T.PerspectiveCamera(FOV, 1, 0.5, 400);
            buildScene(s);
            syncToTable(s);
        } catch (err) {
            dispose(s); broken = true;
            return bail("init failed", err);
        }
        session = s;
        s.raf = requestAnimationFrame(() => loop(s));
        return true;
    }

    function restoreHost(host, saved) {
        if (!host) return;
        host.style.position = saved.position || "";
        host.style.zIndex = saved.zIndex || "";
    }

    function dispose(s) {
        if (s.raf) cancelAnimationFrame(s.raf);
        s.enabled = false;
        [s.feltGeo, s.railGeo, s.wallGeo, s.logoGeo].forEach((g) => g && g.dispose());
        [s.feltMat, s.railMat, s.wallMat, s.logoMat].forEach((m) => m && m.dispose());
        if (s.feltNormal) s.feltNormal.dispose();
        if (s.feltColor) s.feltColor.dispose();
        if (s.railColor) s.railColor.dispose();
        if (s.railNormal) s.railNormal.dispose();
        if (s.logoTex) s.logoTex.dispose();
        if (s.renderer) {
            s.renderer.dispose();
            if (s.renderer.forceContextLoss) s.renderer.forceContextLoss();
        }
        if (s.canvas && s.canvas.parentNode) s.canvas.remove();
        restoreHost(s.host, s.saved);
        if (session === s) session = null;
    }

    function disable() { if (session) dispose(session); }

    window.GPE_TABLE3D = { enable, disable, setTexZoom, setTexDepth, setFeltColor, setLeatherColor, setLogoOpacity, setSurroundColor, isOn: () => !!session, _session: () => session };
})();
