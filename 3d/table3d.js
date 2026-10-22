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
 * exposes window.GPE_TABLE3D = { enable, disable, isOn, projectAbove, ... }.
 * content.js drives it
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
    // 90 = straight down; lower tilts the table back more. THE parameter that
    // decides how anything lying on the felt reads.
    //
    // It is adjustable because it is very nearly free. The felt's own silhouette
    // does not move: its world half-depth is FELT_HALF_D_PX/sinE, so what reaches
    // the screen is FELT_HALF_D_PX — the sinE cancels, by construction, because
    // the painted art's half-depth is already foreshortened. Lower the elevation
    // and the felt simply becomes DEEPER in world space and more foreshortened, to
    // exactly the same outline.
    //
    // What does change is everything standing on or lying in it. At 64 a flat card
    // is squashed 10%, which is barely a cue that it is lying down at all — it
    // reads as propped up. At 45 it is 29%, at 30 it is 50%. The cost is the other
    // direction: the rail has real height, so it grows from 0.18 to 0.36 apparent
    // as the elevation drops. That trade is a matter of taste, hence a slider.
    const ELEV_DEG_0 = 64;
    let ELEV_DEG = ELEV_DEG_0;
    // The angle the table's own geometry is built at. Fixed on purpose: the world
    // table keeps one set of dimensions whatever the camera does.
    const REF_SIN = Math.sin((ELEV_DEG_0 * Math.PI) / 180);
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
    // How far past the felt stadium another renderer should mask to, in world
    // units, to cover the raised felt-edge ring. See feltMaskParams.
    const FELT_BLEED = 0.30;
    const COL_RAIL = 0x211d15;   // warm dark leather (a touch lighter so the grain reads)
    // Outside the rail. Black matches the DARK art's corners, which is where this
    // came from — and it is wrong in light mode, where the site's own felt art has
    // pale corners and a black surround reads as a hole punched in the page. So
    // black is only the fallback: sampleSurround() below takes the color from
    // whatever art the page actually has behind the table, and the user can
    // override it outright.
    const COL_SURROUND = 0x000000;

    const AMBIENT = 0.46;        // low, so the felt keeps a center-bright pool
    const KEY = 0.5;             // directional key (shapes the rail bevel)
    // Upper, slightly left, toward the viewer. Mutable: setKeyLight moves it so
    // the shadows can be aimed by eye. It is a directional light, so this is a
    // direction rather than a place — only the ratio between the three matters.
    const KEY_POS0 = [-6, 15, 11];
    let KEY_POS = KEY_POS0.slice();
    const FILL = 0.16;
    // Where the fill hangs, and how hard each lamp is driven. The intensities are
    // MULTIPLIERS on the tuned constants above rather than absolute values: 1 is
    // the look the table ships with, and one slider can then scale coin3d's and
    // chips3d's rigs by the same proportion even though they were tuned to
    // completely different numbers.
    const FILL_POS0 = [8, 9, -6];
    let FILL_POS = FILL_POS0.slice();
    let KEY_I = 1, FILL_I = 1, AMB_I = 1, LAMP_I = 1;
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
    let backdropStyle = "";          // "" = none, the flat surround color as before
    let seatStyle = "";              // "" = bare floor, "stool" or "chair" at every seat

    // The floor is a real table height below the top. The scale is fixed by the
    // felt: the table spans ~31 world units and reads as a 2.4m poker table, so
    // one unit is ~7.7cm and 75cm of table leg is 9.8 units. This started at 3.2
    // (25cm — a coffee table) which was fine for a backdrop but made nonsense of
    // anything standing on the floor, stools included. 150 units of plane is well
    // past the frustum's reach, so no edge is ever visible.
    const FLOOR_Y = -9.8;
    const FLOOR_SIZE = 150;

    // ---------- seats: a stool or a chair at every place ----------
    // Avatar centres, in the art's element space (the same 790-wide frame
    // FELT_CX_PX/FELT_CY_PX are measured in), read off a live 9-seat table:
    // two at the top, two down each side, three across the near edge. Aligned to
    // the AVATAR rather than the seat card, because the card's internal layout is
    // not mirrored left-to-right — the left column's avatars sit at x=33 while
    // the right column's sit at x=737, which is not a mirror of it.
    //
    // Empty seats are static GWT grid cells that collapse to nothing, so their
    // positions cannot be read at runtime; these are fixed on purpose so a seat
    // stands at every place whether or not anyone is on it.
    const SEATS_ART = [
        [246, 38], [449, 38],                 // far side
        [737, 73], [737, 253],                // right
        [531, 346], [346, 346], [161, 346],   // near side
        [33, 253], [33, 73],                  // left
    ];
    const STOOL_SEAT_R = 2.3;        // 35cm across
    const STOOL_SEAT_H = 0.5;        // 4cm of cushion
    const STOOL_SEAT_FILLET = 0.19;  // rounded top edge, rather than a cut cylinder
    const STOOL_SEAT_TOP = -1.3;     // 65cm seat, i.e. 10cm under the table top
    // Strongly tapered: thick where it meets the seat, whittled to a point at the
    // floor. That taper is the whole signature of the style — a straight dowel
    // reads as flat-pack, not mid-century.
    const STOOL_LEG_TOP_R = 0.23, STOOL_LEG_BOT_R = 0.075;
    const STOOL_LEG_IN = 1.45, STOOL_LEG_OUT = 2.45;        // splay, top to floor
    const STOOL_STRETCH_T = 0.60;    // stretchers this far down the legs
    const STOOL_STRETCH_R = 0.10;    // chunky enough to read at this size
    const STOOL_COL_SEAT = 0x141414;
    const STOOL_COL_WOOD = 0x8f5f36;

    // The other option: the black padded folding chair every card room owns —
    // vinyl pads on a black steel tube frame. Everything below is in the same
    // units as the stool (1 unit ~ 7.7cm) and shares its seat height, so the two
    // styles land identically under the avatars and swap without re-aiming.
    const CHAIR_SEAT_TOP = STOOL_SEAT_TOP;   // sit at the stool's height, 10cm under the top
    const CHAIR_SEAT_H = 0.62;               // 5cm of cushion
    const CHAIR_SEAT_HW = 2.85;              // 44cm across
    const CHAIR_SEAT_HD = 2.6;               // 40cm deep
    const CHAIR_SEAT_FILLET = 0.55;          // corner radius of the cushion
    // The back is a touch wider than the frame it hangs on, so the uprights
    // disappear behind it and show only below, between the pads.
    const CHAIR_BACK_HW = 2.85, CHAIR_BACK_HH = 2.1;
    const CHAIR_BACK_FILLET = 1.05;          // near-oval: the back is a rounded slab
    const CHAIR_BACK_T = 0.5;                // 4cm of padding
    const CHAIR_BACK_Y = 2.4;                // centre of the back, ~28cm above the seat
    const CHAIR_TUBE_R = 0.19;               // 1.5cm steel tube
    // Side profile, per side, mirrored across x=0. The back frame is one bent
    // tube: rear foot -> seat pivot -> up behind the shoulder. The front leg runs
    // from a forward foot up to the seat's rear underside, crossing it just below
    // the cushion — that near-the-seat crossing, not a mid-height X, is what a
    // real folding chair does.
    const CHAIR_X_REAR = 2.6, CHAIR_X_FRONT = 2.32;
    const CHAIR_REAR_FOOT_Z = 4.2;           // rear feet splay well behind the back
    const CHAIR_PIVOT_Z = 2.8;               // where the back frame passes the seat
    const CHAIR_BACK_TOP_Z = 3.5, CHAIR_BACK_TOP_Y = 4.35;
    const CHAIR_FRONT_FOOT_Z = -2.7;         // front feet, toward the table
    const CHAIR_FRONT_TOP_Z = 2.75;
    // Both are "black" in the room, but not the same black on screen: the cloth
    // is a shade lighter and much duller than the tube, which is left glossier
    // and slightly metallic so the frame glints against the pads instead of
    // merging with them into one dark blob.
    const CHAIR_COL_PAD = 0x26262b;          // charcoal upholstery cloth
    const CHAIR_COL_TUBE = 0x2b2b30;         // black steel
    // Weave scale, in tiles per world unit. Set by what survives on screen, not
    // by the real thread count: a unit is ~19px at the table's own size, and the
    // texture carries 16 threads per tile, so this puts a thread at about two
    // pixels. Anything finer mipmaps away and the cloth reads as flat paint.
    const CHAIR_WEAVE_REPEAT = 0.6;
    // Print scale, same units. Four diamonds to a tile, so this is a ~11cm
    // diamond: four or so across a seat, which is upholstery scale rather than
    // the ~32cm one the floor is laid at.
    const CHAIR_PRINT_REPEAT = 0.18;
    // The printed faces are lifted a little because the motif is greyscale and
    // multiplies the tint down; without it the seat top reads darker than the
    // black sides it is supposed to be brighter than.
    const CHAIR_COL_PRINT = 0x3a3a42;

    // The element the table is drawn into and framed by: the classic client's
    // .iogc-GameWindow-table, or whatever setHost() was handed — ui2 has no
    // such element (and uses the class name for something else), so GPokr
    // Tools v3 gives it one sized to the classic art frame over ui2's felt.
    let hostOverride = null;
    function tableEl() { return hostOverride || document.querySelector(".iogc-GameWindow-table"); }
    function setHost(el) { hostOverride = el || null; }

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

    // ---------- backdrop: the floor the table stands on ----------
    // The camera sits 64 degrees above horizontal with a 42 degree FOV, so every
    // ray in frame points at least 43 degrees DOWN: the horizon can never come
    // into view, and one big plane fills the picture with no edge to hide. That
    // is why this is a floor and not a skybox or a screen-space quad.
    //
    // Each style declares how it wants to be laid down. `tile` styles repeat a
    // seamless swatch; "glow" does not, because the pool of light it bakes is a
    // single gradient centred on the table and repeating it would print a grid
    // of suns. color is the material tint, so a style's map only carries
    // luminance and pattern — the same split the felt uses.
    const BACKDROPS = {
        // Two tints per style. `color` is dark mode's, and is deliberately darker
        // than a real carpet or floor: it sits UNDER the seat cards, chips and bet
        // controls, and anything brighter competes with the pieces being read.
        //
        // `light` is the same material in a bright room. Without it the play area
        // became a heavy dark block punched into a pale page — the floor is by far
        // the largest surface here, so it sets the weight of the whole thing. The
        // motif canvas is greyscale either way; only this tint changes.
        grain:  { color: "#15171c", light: "#cfd3da", repeat: 7, rough: 0.95 },
        glow:   { color: "#232833", light: "#dfe3ea", repeat: 0, rough: 0.9 },   // repeat 0 = stretch once
        carpet: { color: "#5c1722", light: "#a8515c", repeat: 9, rough: 0.98 },  // diamonds
        clover: { color: "#3f2145", light: "#8f6c98", repeat: 8, rough: 0.98 },  // quatrefoil lattice
        deco:   { color: "#1f3a46", light: "#6f97a5", repeat: 7, rough: 0.98 },  // scalloped fans
        // repeat is set by real proportion, not by eye. The table spans ~31 world
        // units and reads as a ~2.4m poker table, so a unit is ~7.7cm. Four boards
        // per tile over a 150-unit floor puts a board at 150/repeat/4 units: at
        // repeat 20 that is ~1.9 units, ~14cm — a floorboard. At repeat 5 it was
        // 58cm, which is why the floor looked like a close-up of a deck.
        wood:   { color: "#4a3220", light: "#a87c50", repeat: 20, rough: 0.72 },
    };

    // Fine, near-black tarmac grain: the "it should not look like a flat fill"
    // option. Two noise octaves, kept low-contrast so it never reads as texture.
    function grainCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const lo = makeNoise(8), hi = makeNoise(64);
        const img = ctx.createImageData(N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const n = 0.62 + 0.26 * lo(u, v) + 0.12 * hi(u, v);
                const c = Math.max(0, Math.min(255, Math.round(n * 255)));
                const i = (y * N + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return cv;
    }

    // A pool of light: radial falloff baked into the map, brightest under the
    // table. The scene's overhead lamp already does some of this, but light
    // alone falls off with distance squared and goes flat black at the corners;
    // baking it keeps a readable floor out to the edges of the frame.
    function glowCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const g = ctx.createRadialGradient(N / 2, N / 2, N * 0.04, N / 2, N / 2, N * 0.52);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.45, "#8e8e8e");
        g.addColorStop(1, "#101010");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, N, N);
        // Grain on top, or the gradient bands on an 8-bit canvas.
        const n = makeNoise(140);
        const img = ctx.getImageData(0, 0, N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const i = (y * N + x) * 4;
                const d = (n(x / N, y / N) - 0.5) * 14;
                img.data[i] = Math.max(0, Math.min(255, img.data[i] + d));
                img.data[i + 1] = img.data[i + 2] = img.data[i];
            }
        }
        ctx.putImageData(img, 0, 0);
        return cv;
    }

    // Casino carpet: a diamond lattice with an inner motif, offset every other
    // row. The cell divides the canvas and the offset is half a cell, so the
    // whole thing is seamless at 512 — no motif is ever clipped by the edge.
    function carpetCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, N, N);

        const cell = N / 4;
        const diamond = (cx, cy, r, fill, w) => {
            ctx.beginPath();
            ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
            ctx.closePath();
            if (w) { ctx.lineWidth = w; ctx.strokeStyle = fill; ctx.stroke(); }
            else { ctx.fillStyle = fill; ctx.fill(); }
        };
        for (let row = -1; row <= 4; row++) {
            for (let col = -1; col <= 4; col++) {
                const cx = col * cell + (row % 2 ? cell : cell / 2);
                const cy = row * cell + cell / 2;
                diamond(cx, cy, cell * 0.46, "#c8c8c8", 0);
                diamond(cx, cy, cell * 0.30, "#8f8f8f", 0);
                diamond(cx, cy, cell * 0.46, "#e8e8e8", 2);
                diamond(cx, cy, cell * 0.13, "#ffffff", 0);
            }
        }
        // Break up the flatness — real carpet is never one clean tone.
        const n = makeNoise(120);
        const img = ctx.getImageData(0, 0, N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const i = (y * N + x) * 4;
                const d = (n(x / N, y / N) - 0.5) * 34;
                for (let k = 0; k < 3; k++) {
                    img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] + d));
                }
            }
        }
        ctx.putImageData(img, 0, 0);
        return cv;
    }

    // Grain overlay shared by the carpets: real carpet is never one flat tone, and
    // without this the motifs read as printed vinyl.
    function carpetGrain(ctx, N, amount) {
        const n = makeNoise(120);
        const img = ctx.getImageData(0, 0, N, N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const i = (y * N + x) * 4;
                const d = (n(x / N, y / N) - 0.5) * amount;
                for (let k = 0; k < 3; k++) {
                    img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] + d));
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    // Quatrefoil lattice — four overlapping lobes per cell, rows offset by half a
    // cell. Cell divides the canvas and the offset repeats every two rows, so the
    // y period is 2 cells and still divides 512: seamless both ways.
    function cloverCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, N, N);

        const cell = N / 4;
        const lobes = (cx, cy, r, fill) => {
            ctx.fillStyle = fill;
            ctx.beginPath();
            for (let k = 0; k < 4; k++) {
                const a = k * Math.PI / 2;
                ctx.moveTo(cx + Math.cos(a) * r * 0.55 + r * 0.55, cy + Math.sin(a) * r * 0.55);
                ctx.arc(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, r * 0.55, 0, Math.PI * 2);
            }
            ctx.fill();
        };
        for (let row = -1; row <= 4; row++) {
            const odd = ((row % 2) + 2) % 2;
            for (let col = -1; col <= 4; col++) {
                const cx = col * cell + (odd ? cell / 2 : 0);
                const cy = row * cell;
                lobes(cx, cy, cell * 0.62, "#c4c4c4");
                lobes(cx, cy, cell * 0.40, "#8b8b8b");
                ctx.fillStyle = "#efefef";
                ctx.beginPath();
                ctx.arc(cx, cy, cell * 0.10, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        carpetGrain(ctx, N, 32);
        return cv;
    }

    // Deco fan: rows of scallops, each ribbed with concentric arcs. Alternate rows
    // step half a cell, so like the clover it repeats every two rows.
    function decoCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, N, N);

        const cell = N / 8;
        ctx.lineCap = "round";
        for (let row = -1; row <= 8; row++) {
            const odd = ((row % 2) + 2) % 2;
            for (let col = -1; col <= 9; col++) {
                const cx = col * cell + (odd ? cell / 2 : 0);
                const cy = row * cell;
                ctx.beginPath();
                ctx.arc(cx, cy, cell * 0.5, 0, Math.PI);
                ctx.fillStyle = odd ? "#bdbdbd" : "#cfcfcf";
                ctx.fill();
                ctx.strokeStyle = "#7d7d7d";
                ctx.lineWidth = 1.6;
                ctx.stroke();
                for (let k = 1; k <= 3; k++) {          // the ribs
                    ctx.beginPath();
                    ctx.arc(cx, cy, cell * 0.5 * (k / 4), 0, Math.PI);
                    ctx.strokeStyle = "#9a9a9a";
                    ctx.lineWidth = 1.2;
                    ctx.stroke();
                }
            }
        }
        carpetGrain(ctx, N, 26);
        return cv;
    }

    // Plank flooring: continuous boards with dark seams, grain stretched along
    // the board. Board height divides the canvas, so the seams line up on wrap.
    function woodCanvas(N) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const board = N / 4;
        const grain = makeNoise(40), fig = makeNoise(9), speck = makeNoise(200);
        const img = ctx.createImageData(N, N);
        for (let y = 0; y < N; y++) {
            const b = Math.floor(y / board);
            const shade = 0.86 + 0.14 * ((b * 0.37) % 1);      // per-board tone
            const edge = Math.min(y % board, board - 1 - (y % board));
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                // Stretch the noise along x so it reads as grain, not clouds.
                // The multipliers MUST be whole numbers: makeNoise wraps over
                // 0..1, so a fractional scale samples a partial period and the
                // tile stops matching its own edge — which printed a hard seam
                // straight down the middle of the floor.
                let n = 0.62 + 0.30 * grain(u * 1, v * 6) + 0.14 * fig(u * 1, v * 2);
                n += (speck(u, v) - 0.5) * 0.05;
                n *= shade;
                if (edge < 1.5) n *= 0.45;                     // the seam between boards
                const c = Math.max(0, Math.min(255, Math.round(n * 255)));
                const i = (y * N + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return cv;
    }

    function backdropTexture(T, style) {
        const N = 512;
        const cv = style === "carpet" ? carpetCanvas(N)
            : style === "clover" ? cloverCanvas(N)
                : style === "deco" ? decoCanvas(N)
                    : style === "wood" ? woodCanvas(N)
                        : style === "glow" ? glowCanvas(N)
                            : grainCanvas(N);
        const tex = new T.CanvasTexture(cv);
        const spec = BACKDROPS[style] || BACKDROPS.grain;
        if (spec.repeat > 0) {
            tex.wrapS = tex.wrapT = T.RepeatWrapping;
            tex.repeat.set(spec.repeat, spec.repeat);
        } else {
            tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
        }
        tex.colorSpace = T.SRGBColorSpace;
        // The floor is seen at a grazing angle and tiles many times across it, so
        // it needs more anisotropic filtering than the felt to stop the far end
        // smearing into mush.
        tex.anisotropy = 8;
        return tex;
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
    // This is what makes light mode work without a hardcoded color: dark mode
    // swaps in our dark table.png (black corners), light mode keeps the site's own
    // pale jpg, and both are sampled the same way. Same-origin art, so the canvas
    // read is clean; anything unexpected leaves the fallback in place.
    function sampleSurround() {
        if (surroundHex) return;   // an explicit choice wins
        let url = null;
        try {
            const host = tableEl();
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

    // Build, replace or remove the floor. Called on scene build and whenever the
    // editor picks a different style; tears the old one down first, since these
    // maps are 512x512 canvases and swapping styles a few times would otherwise
    // leak one per switch.
    // How far the light reaches across the floor, as multiples of the table's own
    // extent: full brightness out to LIT, fading to FADE by DARK.
    //
    // FADE is the AMOUNT of brightness lost out at the edges, not the brightness
    // left behind — the knob you actually want when this reads too heavy or too
    // flat. At 0.94 (a near-black edge) it swallowed the corners; half that is
    // enough to feel like a lit table in a dim room without losing the floor.
    const FLOOR_LIT = 1.3, FLOOR_DARK = 4.2;
    // Less fade in a bright room: the same drop that reads as a lit table in
    // the dark just turns a pale floor muddy grey at the edges.
    const FLOOR_FADE_DARK = 0.47, FLOOR_FADE_LIGHT = 0.26;

    // content.js puts gpe-dark on <html> for its dark theme; the surround
    // sampler already leans on the page this way.
    function isDarkTheme() {
        return document.documentElement.classList.contains("gpe-dark");
    }

    // Darken the floor with distance from the table, baked into vertex colors.
    //
    // Lighting alone will not do this. The overhead lamp does fall off with
    // distance, but ambient and the key/fill directionals are uniform everywhere,
    // so the far boards stay as bright as the ones under the rail and the room
    // reads as an infinite lit plane. Baking it also keeps it independent of the
    // texture, which tiles many times over and so cannot carry a single gradient.
    //
    // Elliptical rather than circular: the table is nearly three times wider than
    // it is deep, and a round pool of light around it looks wrong at the ends.
    function shadeFloorFalloff(T, geo, A, B, fade) {
        const pos = geo.attributes.position;
        const col = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            // PlaneGeometry is built in XY and later rotated flat, so its local
            // y is the world's z.
            const r = Math.hypot(pos.getX(i) / A, pos.getY(i) / B);
            const t = Math.min(1, Math.max(0, (r - FLOOR_LIT) / (FLOOR_DARK - FLOOR_LIT)));
            const smooth = t * t * (3 - 2 * t);
            const v = 1 - smooth * fade;
            col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
        }
        geo.setAttribute("color", new T.BufferAttribute(col, 3));
    }

    function applyBackdrop(s) {
        if (s) s.shadowDirty = true;   // geometry moved: the shadow map is stale
        if (!s || !s.scene) return;
        const T = window.THREE;
        if (s.floor) {
            s.scene.remove(s.floor);
            if (s.floorMat) { if (s.floorMat.map) s.floorMat.map.dispose(); s.floorMat.dispose(); }
            if (s.floorGeo) s.floorGeo.dispose();
            s.floor = s.floorMat = s.floorGeo = null;
        }
        const spec = BACKDROPS[backdropStyle];
        // The overhead lamp only pays for its cube shadow map when there is a
        // floor underneath to catch the table's shadow.
        if (s.overhead) s.overhead.castShadow = !!spec;
        if (!spec) { s.needsRender = Math.max(s.needsRender || 0, 2); return; }

        // Segmented, because the falloff below is baked per VERTEX: a two-triangle
        // plane has nothing to interpolate across.
        s.floorGeo = new T.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 72, 72);
        const dark = isDarkTheme();
        s.floorDark = dark;   // so loop() can notice a theme flip
        shadeFloorFalloff(T, s.floorGeo, s.feltA || 14.7, s.feltB || 5.7,
            dark ? FLOOR_FADE_DARK : FLOOR_FADE_LIGHT);
        s.floorMat = new T.MeshStandardMaterial({
            color: new T.Color((!dark && spec.light) ? spec.light : spec.color),
            roughness: spec.rough,
            metalness: 0,
            map: backdropTexture(T, backdropStyle),
            vertexColors: true,
        });
        s.floor = new T.Mesh(s.floorGeo, s.floorMat);
        s.floor.rotation.x = -Math.PI / 2;   // XY plane -> XZ ground
        s.floor.position.y = FLOOR_Y;
        s.floor.receiveShadow = true;        // the table drops a shadow onto it
        s.scene.add(s.floor);
        s.needsRender = Math.max(s.needsRender || 0, 2);
    }

    // One mid-century stool: a round black seat on four splayed, tapered wood
    // legs. Built once and cloned per seat — clone() shares geometry and
    // materials, so nine stools cost one of each and dispose once.
    // The seat as a lathed profile rather than a cylinder, so its top edge is a
    // rounded-over lip: centre, out across the top, round the corner, down the
    // side, and back in underneath. A hard cylinder edge catches the key light as
    // a bright rim and reads as a stamped disc.
    // Listed BOTTOM to TOP, which is not cosmetic: LatheGeometry takes its winding
    // from the profile's direction, and a top-down list turns the seat inside out.
    // The symptom is subtle and easy to misread — the seat still looks like a solid
    // disc (you are seeing its underside faces) but its top surface is culled, so it
    // writes no depth and the leg tops buried inside it show straight through as
    // four wooden dots.
    function stoolSeatProfile(T) {
        const R = STOOL_SEAT_R, half = STOOL_SEAT_H / 2, f = STOOL_SEAT_FILLET;
        const pts = [
            new T.Vector2(0, -half),            // underside centre
            new T.Vector2(R - 0.07, -half),     // out across the underside
            new T.Vector2(R, -half + 0.07),     // slight under-bevel
            new T.Vector2(R, half - f),         // up the side wall
        ];
        const STEPS = 6;
        for (let i = 1; i <= STEPS; i++) {      // round the top edge over
            const a = (i / STEPS) * (Math.PI / 2);
            pts.push(new T.Vector2(R - f + Math.cos(a) * f, half - f + Math.sin(a) * f));
        }
        pts.push(new T.Vector2(0, half));       // in to the top centre
        return pts;
    }

    function buildStoolTemplate(T, s) {
        s.stoolSeatGeo = new T.LatheGeometry(stoolSeatProfile(T), 30);
        s.stoolSeatMat = new T.MeshStandardMaterial({
            color: STOOL_COL_SEAT, roughness: 0.55, metalness: 0.05,
        });
        s.stoolWoodMat = new T.MeshStandardMaterial({
            color: STOOL_COL_WOOD, roughness: 0.62, metalness: 0.0,
        });

        const seatY = STOOL_SEAT_TOP - STOOL_SEAT_H / 2;
        // Up INSIDE the seat, not flush with its underside: flush leaves the
        // leg's top cap coplanar with the seat's bottom face, and the two
        // z-fight into speckles that read as leg ends poking through the top.
        const legTopY = STOOL_SEAT_TOP - STOOL_SEAT_H + 0.18;
        // Every leg is the same length, so one geometry serves all four: build it
        // from the first leg's endpoints and then just re-aim the copies.
        const a0 = Math.PI / 4;
        const top0 = new T.Vector3(Math.cos(a0) * STOOL_LEG_IN, legTopY, Math.sin(a0) * STOOL_LEG_IN);
        const bot0 = new T.Vector3(Math.cos(a0) * STOOL_LEG_OUT, FLOOR_Y, Math.sin(a0) * STOOL_LEG_OUT);
        const legLen = top0.distanceTo(bot0);
        s.stoolLegGeo = new T.CylinderGeometry(STOOL_LEG_TOP_R, STOOL_LEG_BOT_R, legLen, 10);

        const stool = new T.Group();
        const seat = new T.Mesh(s.stoolSeatGeo, s.stoolSeatMat);
        seat.position.y = seatY;
        seat.castShadow = true;
        seat.receiveShadow = true;
        stool.add(seat);

        const UP = new T.Vector3(0, 1, 0);
        const knees = [];   // where each leg passes the stretcher height
        for (let i = 0; i < 4; i++) {
            const a = a0 + i * Math.PI / 2;
            const top = new T.Vector3(Math.cos(a) * STOOL_LEG_IN, legTopY, Math.sin(a) * STOOL_LEG_IN);
            const bot = new T.Vector3(Math.cos(a) * STOOL_LEG_OUT, FLOOR_Y, Math.sin(a) * STOOL_LEG_OUT);
            const leg = new T.Mesh(s.stoolLegGeo, s.stoolWoodMat);
            leg.position.copy(top).add(bot).multiplyScalar(0.5);
            // Aim +Y UP the leg. CylinderGeometry's first radius is its +Y end,
            // so pointing +Y down the leg put the fat end on the floor and
            // tapered it the wrong way — wide at the foot, thin at the seat.
            leg.quaternion.setFromUnitVectors(UP, top.clone().sub(bot).normalize());
            leg.castShadow = true;
            stool.add(leg);
            knees.push(top.clone().lerp(bot, STOOL_STRETCH_T));
        }

        // Stretchers: a rod between each neighbouring pair of legs. All four are
        // the same length and sit level with one another, so one geometry does.
        const span = knees[0].distanceTo(knees[1]);
        s.stoolStretchGeo = new T.CylinderGeometry(STOOL_STRETCH_R, STOOL_STRETCH_R, span, 8);
        for (let i = 0; i < 4; i++) {
            const a = knees[i], b = knees[(i + 1) % 4];
            const rod = new T.Mesh(s.stoolStretchGeo, s.stoolWoodMat);
            rod.position.copy(a).add(b).multiplyScalar(0.5);
            rod.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
            rod.castShadow = true;
            stool.add(rod);
        }
        return stool;
    }

    // A rounded rectangle, the outline of both vinyl pads.
    function roundedRect(T, hw, hh, r) {
        const sh = new T.Shape();
        r = Math.min(r, hw, hh);
        sh.moveTo(-hw + r, -hh);
        sh.lineTo(hw - r, -hh);
        sh.quadraticCurveTo(hw, -hh, hw, -hh + r);
        sh.lineTo(hw, hh - r);
        sh.quadraticCurveTo(hw, hh, hw - r, hh);
        sh.lineTo(-hw + r, hh);
        sh.quadraticCurveTo(-hw, hh, -hw, hh - r);
        sh.lineTo(-hw, -hh + r);
        sh.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
        return sh;
    }

    // One padded slab, extruded along +Z and centred on the origin through its
    // thickness. The bevel is the point of it: a flat extrusion reads as cut
    // plywood, while a rounded-over edge catches the key light the way stuffed
    // vinyl does. The shape is inset by the bevel so the finished slab measures
    // the size asked for rather than that plus two bevels.
    //
    // `faceDir` is which lid the sitter touches (+1 or -1 along the extrusion):
    // that one is material 0 and gets the printed cloth, everything else —
    // the far lid, the bevel, the sides — is material 1 and stays plain black.
    function padGeometry(T, hw, hh, r, thick, faceDir) {
        const bevel = Math.min(0.16, thick * 0.35);
        const depth = thick - 2 * bevel;
        const geo = new T.ExtrudeGeometry(
            roundedRect(T, hw - bevel, hh - bevel, Math.max(0.05, r - bevel)),
            {
                depth, bevelEnabled: true, bevelThickness: bevel,
                bevelSize: bevel, bevelSegments: 3, curveSegments: 12,
            });
        geo.translate(0, 0, -depth / 2);
        splitLids(geo, faceDir);
        return geo;
    }

    // ExtrudeGeometry files BOTH lids under one group and every side/bevel face
    // under another, so "print the top only" needs the lid group broken in two.
    // Walk its triangles, sort each by which side of the slab it sits on, and
    // re-emit them as runs — which is exact rather than an assumption about the
    // order the lids happen to be built in. The geometry is non-indexed, so a
    // group's start/count count vertices directly.
    function splitLids(geo, faceDir) {
        const pos = geo.attributes.position;
        const groups = geo.groups.slice();
        geo.clearGroups();
        groups.forEach((g) => {
            if (g.materialIndex !== 0) { geo.addGroup(g.start, g.count, 1); return; }
            const end = g.start + g.count;
            let runStart = g.start, runMat = -1;
            for (let i = g.start; i < end; i += 3) {
                const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
                const m = (z * faceDir > 0) ? 0 : 1;
                if (m === runMat) continue;
                if (runMat >= 0) geo.addGroup(runStart, i - runStart, runMat);
                runStart = i; runMat = m;
            }
            if (runMat >= 0) geo.addGroup(runStart, end - runStart, runMat);
        });
    }

    // A woven-cloth normal map for the pads: a plain weave, where the warp is on
    // top in one cell and the weft in the next, checkerboard fashion. Each thread
    // is a half-sine ridge across its own short axis, which is also why the tile
    // is seamless — every thread falls to zero at the cell edge it shares with
    // its neighbour. A little noise on top keeps it from looking machined.
    //
    // Same gradient-of-a-heightfield trick as the felt, and it is a normal map
    // rather than a color map on purpose: the weave should show as relief that
    // moves with the light, not as a pattern printed on the cloth.
    function fabricNormalTexture(T) {
        const N = 256, K = 16;          // K threads across the tile
        const fuzz = makeNoise(96);
        const prof = (t) => Math.sin(Math.PI * t);
        const height = (u, v) => {
            const fx = u * K, fy = v * K;
            const ix = Math.floor(fx), iy = Math.floor(fy);
            const warpOver = ((ix + iy) & 1) === 0;
            const h = warpOver ? prof(fx - ix) : prof(fy - iy);
            return h * 0.86 + fuzz(u, v) * 0.14;
        };
        const cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const ctx = cv.getContext("2d");
        const img = ctx.createImageData(N, N);
        const e = 1.2 / N, STR = 2.4;
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
        // ExtrudeGeometry's UVs are raw world units (see normalizeUV), which is
        // exactly what a repeating weave wants: one setting covers the seat, the
        // back and their bevelled edges at the same thread size, with no seam
        // where a face changes direction.
        tex.repeat.set(CHAIR_WEAVE_REPEAT, CHAIR_WEAVE_REPEAT);
        return tex;
    }

    // The print on the cloth: the same diamond lattice the carpet floor is woven
    // from, because it is the same room — card-room upholstery and card-room
    // carpet come off the same loom. Greyscale, like every other motif here, so
    // the material tint decides how dark the fabric actually is.
    function chairPrintTexture(T) {
        const tex = new T.CanvasTexture(carpetCanvas(256));
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.repeat.set(CHAIR_PRINT_REPEAT, CHAIR_PRINT_REPEAT);
        tex.colorSpace = T.SRGBColorSpace;
        tex.anisotropy = 4;
        return tex;
    }

    // One black folding chair: two cloth pads on a bent steel tube frame, facing
    // -Z (the table). Built once and cloned per seat, like the stool.
    function buildChairTemplate(T, s) {
        s.chairGeos = [];      // every geometry this template owns, for dispose()
        s.chairWeave = fabricNormalTexture(T);
        s.chairPrint = chairPrintTexture(T);
        // Cloth, so: no metal, and rough enough that the pads never take the hard
        // specular a vinyl seat would. The weave does the work instead, and both
        // materials carry it — the print sits ON the same fabric, it is not a
        // different one.
        const cloth = { roughness: 0.88, metalness: 0, normalMap: s.chairWeave };
        s.chairPadMat = new T.MeshStandardMaterial(
            Object.assign({ color: CHAIR_COL_PAD }, cloth));
        s.chairPrintMat = new T.MeshStandardMaterial(
            Object.assign({ color: CHAIR_COL_PRINT, map: s.chairPrint }, cloth));
        const pads = [s.chairPrintMat, s.chairPadMat];   // [printed lid, all the rest]
        s.chairTubeMat = new T.MeshStandardMaterial({
            color: CHAIR_COL_TUBE, roughness: 0.34, metalness: 0.7,
        });

        const chair = new T.Group();
        const UP = new T.Vector3(0, 1, 0);
        const V = (x, y, z) => new T.Vector3(x, y, z);
        const tube = (a, b) => {
            const geo = new T.CylinderGeometry(CHAIR_TUBE_R, CHAIR_TUBE_R, a.distanceTo(b), 8);
            s.chairGeos.push(geo);
            const m = new T.Mesh(geo, s.chairTubeMat);
            m.position.copy(a).add(b).multiplyScalar(0.5);
            m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
            m.castShadow = true;
            chair.add(m);
        };

        const botY = CHAIR_SEAT_TOP - CHAIR_SEAT_H;   // underside of the cushion
        for (const sx of [1, -1]) {
            const rearFoot = V(sx * CHAIR_X_REAR, FLOOR_Y, CHAIR_REAR_FOOT_Z);
            const pivot = V(sx * CHAIR_X_REAR, botY, CHAIR_PIVOT_Z);
            const backTop = V(sx * CHAIR_X_REAR, CHAIR_BACK_TOP_Y, CHAIR_BACK_TOP_Z);
            const frontFoot = V(sx * CHAIR_X_FRONT, FLOOR_Y, CHAIR_FRONT_FOOT_Z);
            const frontTop = V(sx * CHAIR_X_FRONT, botY, CHAIR_FRONT_TOP_Z);
            tube(rearFoot, pivot);      // rear leg
            tube(pivot, backTop);       // ...bending up into the back upright
            tube(frontFoot, frontTop);  // front leg, crossing it under the seat
            if (sx > 0) {
                // Stretchers, low on each pair of legs. Taken by lerp along the
                // legs themselves so they stay welded to them if the splay moves.
                [[rearFoot, pivot, 0.22], [frontFoot, frontTop, 0.26]].forEach(([a, b, f]) => {
                    const p = a.clone().lerp(b, f);
                    tube(p, V(-p.x, p.y, p.z));
                });
            }
        }

        // +Z is the lid the sitter lands on: for the seat that is the face which
        // rotates up to become the top, for the back it is the one turned toward
        // the table, so the back prints on its -Z lid instead.
        s.chairSeatGeo = padGeometry(T, CHAIR_SEAT_HW, CHAIR_SEAT_HD, CHAIR_SEAT_FILLET, CHAIR_SEAT_H, 1);
        s.chairGeos.push(s.chairSeatGeo);
        const seat = new T.Mesh(s.chairSeatGeo, pads);
        seat.rotation.x = -Math.PI / 2;   // lay the slab flat, thickness upright
        seat.position.y = CHAIR_SEAT_TOP - CHAIR_SEAT_H / 2;
        seat.castShadow = true;
        seat.receiveShadow = true;
        chair.add(seat);

        // The back rides on the FRONT face of the uprights (tube radius + half
        // its own thickness clear of them), tilted with the frame — so it leans
        // back with the uprights instead of floating parallel to the floor.
        s.chairBackGeo = padGeometry(T, CHAIR_BACK_HW, CHAIR_BACK_HH, CHAIR_BACK_FILLET, CHAIR_BACK_T, -1);
        s.chairGeos.push(s.chairBackGeo);
        const back = new T.Mesh(s.chairBackGeo, pads);
        const lean = Math.atan2(CHAIR_BACK_TOP_Z - CHAIR_PIVOT_Z, CHAIR_BACK_TOP_Y - botY);
        const t = (CHAIR_BACK_Y - botY) / (CHAIR_BACK_TOP_Y - botY);
        const onTube = CHAIR_PIVOT_Z + t * (CHAIR_BACK_TOP_Z - CHAIR_PIVOT_Z);
        const off = CHAIR_TUBE_R + CHAIR_BACK_T / 2;
        back.rotation.x = lean;
        back.position.set(0, CHAIR_BACK_Y + Math.sin(lean) * off, onTube - Math.cos(lean) * off);
        back.castShadow = true;
        back.receiveShadow = true;
        chair.add(back);

        return chair;
    }

    function seatTemplate(T, s) {
        s.seatTemplates = s.seatTemplates || {};
        if (!s.seatTemplates[seatStyle]) {
            s.seatTemplates[seatStyle] = seatStyle === "chair"
                ? buildChairTemplate(T, s) : buildStoolTemplate(T, s);
        }
        return s.seatTemplates[seatStyle];
    }

    function applySeats(s) {
        if (s) s.shadowDirty = true;   // geometry moved: the shadow map is stale
        if (!s || !s.scene) return;
        const T = window.THREE;
        if (s.seats) {
            s.scene.remove(s.seats);
            s.seats = null;
        }
        if (seatStyle !== "stool" && seatStyle !== "chair") {
            // Geometry and materials are kept: toggling is common and rebuilding
            // nine of anything per flick is wasted work. dispose() frees them.
            s.needsRender = Math.max(s.needsRender || 0, 2);
            return;
        }
        const template = seatTemplate(T, s);
        const group = new T.Group();
        for (let i = 0; i < SEATS_ART.length; i++) group.add(template.clone());
        s.seats = group;
        s.scene.add(group);
        placeSeats(s);
        s.needsRender = Math.max(s.needsRender || 0, 2);
    }

    // Put each stool/chair where its SEAT lands on the seat's avatar.
    //
    // The obvious mapping — art x/y straight onto the felt plane, the way the
    // felt itself is placed — is wrong here, and visibly so: that maps points at
    // TABLE height, while a seat is 1.3 units below it. Under a 64-degree
    // perspective a point that low projects well off the felt-plane answer, and
    // every stool landed pulled in toward the middle of the table.
    //
    // So instead of mapping, unproject: fire the pixel's own ray and intersect it
    // with the horizontal plane the seat lives on. That is exact by construction
    // and needs no correction term. It does need the camera to be placed first,
    // which is why loop() re-runs this whenever syncToTable reframes.
    // A camera at the reference angle, framed exactly as syncToTable frames the
    // live one. Cached per table size, because it only depends on the element's box.
    function seatRefCamera(s, r) {
        const T = window.THREE;
        const key = Math.round(r.width) + "x" + Math.round(r.height);
        if (s.refCam && s.refCamKey === key) return s.refCam;
        const cw = Math.round(r.width), ch = Math.round(r.height);
        const wpp = VIEW_W / r.width, scale = r.width / ART_W;
        const cosRef = Math.cos((ELEV_DEG_0 * Math.PI) / 180);
        const d = (ch * wpp) / (2 * Math.tan((FOV * Math.PI) / 180 / 2));
        const tx = -(FELT_CX_PX * scale - cw / 2) * wpp;
        const tz = -((FELT_CY_PX + FELT_Y_NUDGE) * scale - ch / 2) * wpp / REF_SIN;
        const cam = s.refCam || new T.PerspectiveCamera(FOV, 1, 0.5, 400);
        cam.fov = FOV;
        cam.aspect = cw / ch;
        cam.position.set(tx, d * REF_SIN, tz + d * cosRef);
        cam.up.set(0, cosRef, -REF_SIN);
        cam.lookAt(tx, 0, tz);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        s.refCam = cam;
        s.refCamKey = key;
        return cam;
    }

    function placeSeats(s) {
        if (s) s.shadowDirty = true;   // geometry moved: the shadow map is stale

        if (!s.seats || !s.camera || !s.placed) return;
        const T = window.THREE;
        // Aim at the middle of a stool cushion; the chair's is within 5mm of it,
        // and this only picks the depth at which each seat's ray is intersected.
        const seatY = STOOL_SEAT_TOP - STOOL_SEAT_H / 2;
        const el = tableEl();
        if (!el) return;
        const r = el.getBoundingClientRect();
        const scale = r.width / ART_W;          // element px per art px
        // syncToTable has just moved the camera, and position/lookAt only touch
        // its local transform — matrixWorld is not refreshed until the renderer
        // walks the scene. Raycasting off the stale matrix unprojects through
        // wherever the camera used to be: half the rays came out near-horizontal
        // and missed the seat plane outright (leaving those stools stacked at the
        // origin, under the felt), and the rest landed hundreds of units away.
        s.camera.updateMatrixWorld(true);

        // Raycast through a REFERENCE camera, not the live one.
        //
        // The seats are part of the table's furniture, so where they sit is a fact
        // about the table, not about where you are standing. Through the live
        // camera a shallow view angle sends each ray a long way before it reaches
        // the seat plane — at 25 degrees the back seats landed 60+ units out and
        // read as being in another room. Built at the reference angle they stay
        // put, and the view angle does what a view angle should: move the camera.
        const refCam = seatRefCamera(s, r);
        const ray = new T.Raycaster();
        const plane = new T.Plane(new T.Vector3(0, 1, 0), -seatY);
        const ndc = new T.Vector2();
        const hit = new T.Vector3();
        SEATS_ART.forEach(([ax, ay], i) => {
            const seat = s.seats.children[i];
            if (!seat) return;
            ndc.set((ax * scale) / r.width * 2 - 1, -((ay * scale) / r.height * 2 - 1));
            ray.setFromCamera(ndc, refCam);
            if (!ray.ray.intersectPlane(plane, hit)) return;
            // The group's origin is at table height, so only x/z come from the hit.
            seat.position.set(hit.x, 0, hit.z);
            // Face the table: +Z points radially outward, which is where a chair's
            // back goes. Cosmetic on the stool's four symmetric legs, not on this.
            seat.rotation.y = Math.atan2(hit.x, hit.z);
        });
    }

    // "" / unknown -> no furniture, as before.
    function setSeats(style) {
        seatStyle = (style === "stool" || style === "chair") ? style : "";
        if (session) applySeats(session);
    }

    // "" / unknown -> no floor, back to the flat surround color.
    function setBackdrop(style) {
        backdropStyle = (typeof style === "string" && BACKDROPS[style]) ? style : "";
        if (session) applyBackdrop(session);
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

    // Load the bundled gpokr logo and hand back a CanvasTexture + its aspect
    // ratio. Asked for with CORS: our files are same-origin with the classic
    // page, but not with ui2's, where an extension or CDN URL drawn into the
    // canvas would taint it and WebGL would refuse the texture.
    function loadLogoTexture(T, onReady) {
        const url = assetUrl("assets/gpokr-logo.svg");
        if (!url) return;
        const img = new Image();
        img.crossOrigin = "anonymous";
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
        // Give lookAt an up vector that is already perpendicular to the view
        // direction, instead of leaving it at the default (0,1,0).
        //
        // This is what lets the elevation reach a true 90. lookAt builds its basis
        // as x = cross(up, z), and at straight-down z IS (0,1,0) — so with the
        // default hint the cross product is zero and the orientation is undefined.
        // (0, cosE, -sinE) is perpendicular to the view at every angle, and at 90
        // it is (0,0,-1), which is a perfectly good "up" for a bird's-eye view. The
        // basis it produces below 90 is identical to what the default hint gave,
        // so nothing about the existing angles changes.
        cam.up.set(0, s.cosE, -s.sinE);
        cam.lookAt(tx, 0, tz);
        cam.updateProjectionMatrix();

        s.placed = { w: r.width, h: r.height };
        return true;
    }

    // Where a point sitting `hCss` css px above the felt, at page position
    // (pageX, pageY), lands on screen — in page css px. Null when the table is
    // not rendering.
    //
    // This exists so another renderer can borrow the table's perspective instead
    // of approximating it. props3d's river faked height with a linear shear (its
    // LEAN): every face projected into the same plane, so a wall had no
    // convergence and the whole landform read as paint on the felt however it was
    // coloured. Going through this camera instead gives it the projection the felt
    // and the rail were actually drawn with — FOV degrees of perspective at
    // ELEV_DEG of elevation — so a raised bank foreshortens and converges the way
    // the table does.
    //
    // The inverse of syncToTable's placement: world origin is the felt's centre,
    // x maps straight through, and z is stretched by 1/sinE because the plane is
    // seen at an angle (which is why FELT_HALF_D_PX is described as already
    // foreshortened).
    // Everything another renderer needs to mask itself to the felt EXACTLY.
    //
    // A screen-space stadium is not good enough. The felt is a stadium on the
    // ground plane, and this camera is perspective — so its outline on screen is
    // NOT a stadium: the near end is larger than the far one. Clipping to a
    // symmetric screen shape therefore misses the rail on one side and crosses it
    // on the other, which is exactly the "not perfect to the rail" you can see.
    //
    // The fix is to do the test on the ground plane instead. Projection restricted
    // to y=0 is a homography, so it inverts exactly: `inv` takes (ndc.x, ndc.y, 1)
    // to (X, Z, w) on the felt, and a stadium test there is exact at any angle.
    // A, B and the arc radius are the same numbers the felt geometry is built from.
    function feltMaskParams() {
        const s = session;
        if (!s || !s.camera || !s.placed || !s.feltA) return null;
        const el = tableEl();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return null;
        const T = window.THREE;
        if (!T) return null;
        s.camera.updateMatrixWorld(true);
        const M = new T.Matrix4().multiplyMatrices(s.camera.projectionMatrix,
            s.camera.matrixWorldInverse);
        const m = M.elements;   // column-major: element[col * 4 + row]
        // Rows 0, 1 and 3 of M, keeping only the X and Z columns plus translation:
        // the Y column drops out because the plane is y = 0.
        const H = new T.Matrix3().set(
            m[0], m[8], m[12],
            m[1], m[9], m[13],
            m[3], m[11], m[15]);
        const inv = H.clone().invert();
        // Expanded outward by BLEED. The playing surface is not only the felt
        // stadium: there is a felt-edge wall ring just inside the rail, from A in
        // to A - 0.45 (see the wall geometry below), and it is EXTRUDED, so its top
        // face sits a hair above the felt plane. Anything above the plane projects
        // slightly outside its own footprint on it, so a mask computed exactly at A
        // leaves that rim showing as a thin dark crescent hugging the rail —
        // strongest at the caps, where the outline curves fastest.
        //
        // Growing the stadium is the honest fix: the visible surface really does
        // reach past A once the rim is raised. BLEED is well under the ring's own
        // width, so it closes the crescent without climbing the rail's inner face.
        const rad = Math.min(s.feltB, s.feltA);
        return {
            inv: inv,
            rect: [r.left, r.top, r.width, r.height],
            // Only the radius grows: halfRun is A - rad, so holding it fixed while
            // rad increases moves the whole outline out by the same amount.
            radius: rad + FELT_BLEED,
            halfRun: Math.max(0, s.feltA - rad),
        };
    }

    // ---------- page space <-> felt space ----------
    // One conversion, in one place. It was written three times — the caster
    // filter, the caster placement and projectAbove — and every future piece that
    // moves into this scene needs the same four lines, so they live here now.
    //
    // The frame is read ONCE per call and passed down: getBoundingClientRect is
    // the expensive part and a sweep placing twenty chips must not pay for it
    // twenty times.
    function feltFrame() {
        const el = tableEl();
        const r = el && el.getBoundingClientRect();
        if (!r || r.width < 40 || r.height < 40) return null;
        return { r: r, wpp: VIEW_W / r.width, scale: r.width / ART_W };
    }

    // A viewport point onto the felt plane. Z carries the 1/sinE stretch because
    // a plane seen at an angle covers more world per screen pixel than a plane
    // seen square on.
    function toFelt(f, clientX, clientY) {
        const s = session;
        return {
            X: (clientX - f.r.left - FELT_CX_PX * f.scale) * f.wpp,
            Z: (clientY - f.r.top - (FELT_CY_PX + FELT_Y_NUDGE) * f.scale) * f.wpp / s.sinE,
        };
    }

    // ...and a viewport RECT onto it: centre plus the extents it covers on the
    // felt. Same stretch on the depth axis, for the same reason.
    function rectToFelt(f, rect) {
        const c = toFelt(f, rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
            X: c.X, Z: c.Z,
            sx: Math.max(0.01, rect.width * f.wpp),
            sz: Math.max(0.01, rect.height * f.wpp / session.sinE),
        };
    }

    // Is this point on the cloth?
    //
    // This is the pivot the whole layer turns on. It used to answer only "should
    // a shadow caster go here?"; it now answers "which BASIS does this object
    // live in?" — on the felt means real geometry on the felt plane that casts a
    // real shadow, off it means a camera-facing billboard that does not.
    //
    // The felt is a STADIUM and this now tests one exactly, where it used to test
    // an ellipse through the same half-extents. That approximation is inscribed:
    // near the two ends it falls well short of the cloth, so it called perfectly
    // good positions off-felt — seats at the far left and right lost their cards
    // to it, and stacks out there were nudged inward that never needed to move.
    // A stadium is a straight section of half-length A-B capped by two circles of
    // radius B, which is three comparisons, so there was never much to trade.
    function onFelt(X, Z, k) {
        const s = session;
        if (!s || !s.feltA || !s.feltB) return true;
        const m = k == null ? 0.98 : k;
        const A = s.feltA * m, B = s.feltB * m;
        const ax = Math.abs(X), az = Math.abs(Z);
        if (az > B) return false;
        const straight = Math.max(0, A - B);
        if (ax <= straight) return true;
        const dx = ax - straight;
        return dx * dx + az * az <= B * B;
    }

    // A stack the site placed flush with the felt's edge no longer fits there: our
    // chips are drawn WIDER than the 24px sprite they stand for, and each one also
    // gets a silhouette proud of that, so the footprint laps onto the rail.
    //
    // Returns the screen-space nudge that brings the footprint back onto the cloth —
    // applied by the caller to the chips AND their plate together, so they move as
    // one and stay registered.
    //
    // The footprint is sampled as an ELLIPSE inscribed in the padded rect, not as
    // that rect's corners. Chips are round and their silhouette is a stadium, and a
    // bounding box's corner sticks out well past both — testing corners against the
    // felt's own ellipse demanded 40-60px of correction on the diagonals, which does
    // not move a bet off the rail so much as move it somewhere else entirely.
    //
    // Capped, for the same reason: past MAX the site has genuinely put the stack
    // where it wants it, and a small overlap is a better answer than teleporting
    // somebody's bet. The partial nudge is kept — less lap is still less lap.
    //
    // `overhang` alone is the pad — the silhouette is deliberately NOT included. It
    // is a soft dark shape and nobody minds it kissing the rail, whereas including
    // it added 4px to every side and pushed the correction into the cap for most of
    // the felt's rim, which is a worse answer than a slightly wide silhouette.
    const FIT_STEP = 1.5, FIT_MAX = 12;
    function feltFit(rect, overhang) {
        const f = feltFrame(), s = session;
        const zero = { dx: 0, dy: 0 };
        if (!f || !s || !s.feltA || !s.feltB || !rect || !rect.width) return zero;
        const pad = Math.max(0, overhang || 0);
        const rx = rect.width / 2 + pad, rz = rect.height / 2 + pad;
        const to = { x: f.r.left + FELT_CX_PX * f.scale,
            y: f.r.top + (FELT_CY_PX + FELT_Y_NUDGE) * f.scale };
        const off = (cx, cy) => {
            let worst = 0;
            for (let i = 0; i < 12; i++) {
                const a = (i / 12) * Math.PI * 2;
                const q = toFelt(f, cx + Math.cos(a) * rx, cy + Math.sin(a) * rz);
                if (!onFelt(q.X, q.Z, 0.99)) worst = 2;
            }
            return worst;
        };
        let dx = 0, dy = 0;
        const cx0 = rect.left + rect.width / 2, cy0 = rect.top + rect.height / 2;
        while (Math.hypot(dx, dy) < FIT_MAX) {
            if (off(cx0 + dx, cy0 + dy) <= 1) break;
            const vx = to.x - (cx0 + dx), vy = to.y - (cy0 + dy);
            const len = Math.hypot(vx, vy) || 1;
            dx += (vx / len) * FIT_STEP;
            dy += (vy / len) * FIT_STEP;
        }
        return { dx: dx, dy: dy };
    }

    // Is this viewport point on the cloth? The one question callers outside this
    // file keep needing, and the only honest place to answer it.
    function feltHas(clientX, clientY, k) {
        const f = feltFrame();
        if (!f || !session) return false;
        const q = toFelt(f, clientX, clientY);
        return onFelt(q.X, q.Z, k == null ? 1 : k);
    }

    // ---------- chips on the felt ----------
    // The site draws every bet and the pot as a stack of flat 24x21 sprites. This
    // stands one of them up as a real disc in this scene, which means it is lit by
    // the same lamp as the rail and drops its shadow on the same felt — no catcher
    // plane, no proxy, no second light rig.
    //
    // Note what ISN'T here any more. coin3d had to lean each chip by acos(21/24)
    // to fake the table's viewing angle, and stack them up-screen by
    // thickness*sin(lean) to fake the height. Here the camera IS the angle and +Y
    // IS up, so a chip is a cylinder lying on the felt plane and a stack is
    // addition. That lean constant was a fake object too.
    // How a chip arrives when it is dropped rather than placed. 34px is high enough
    // to read as a fall at this camera without leaving the frame at the far rail.
    const DROP_RISE = 34;      // css px above the resting height
    const DROP_FALL = 0.17;    // s to fall it

    function chipArt(s, denom) {
        const T = window.THREE;
        // Keyed by value: an unknown value gets art with its own number on it
        // rather than the first chip in the list (which put "1" on $1,000s).
        if (!s.chipArt) s.chipArt = new Map();
        if (s.chipArt.has(denom)) return s.chipArt.get(denom);
        const art = window.GPE_CHIPS.art;
        const { face, rim } = art.texturesFor ? art.texturesFor(T, denom)
            : art.textures(T, Math.max(0, art.types.findIndex((t) => t.denom === denom)));
        const a = {
            face, rim,
            faceMat: new T.MeshStandardMaterial({ map: face, roughness: 0.5, metalness: 0.06 }),
            // Same finish as the face: a rounded edge runs into the face, and a
            // different sheen either side of the join shows the join.
            rimMat: new T.MeshStandardMaterial({ map: rim, roughness: 0.5, metalness: 0.06 }),
        };
        s.chipArt.set(denom, a);
        return a;
    }

    // How much of the chip's edge is rounded off, as a fraction of its half
    // thickness. 0 is the square-edged disc it has always been.
    let CHIP_ROUND = 0;

    // The unit chip — radius 0.5, height 1, axis +Y — as three shared geometries
    // rather than one cylinder, so each gets the UVs it actually wants: the caps
    // radial for the denomination, the rim wrapping for the edge spots. A single
    // ExtrudeGeometry with a bevel would have been fewer parts, but it puts both
    // caps and the wall through one UV generator and the face art comes out
    // smeared. Same split cardMesh makes, for the same reason.
    //
    // With a fillet the caps shrink by it and the rim bulges out to the full radius
    // at mid-height, so the silhouette stays exactly 0.5 whatever the rounding —
    // the chip does not change size as you round it.
    function chipParts(s, diam, thick) {
        const T = window.THREE;
        const R = 0.5, HH = 0.5;
        // The fillet is a fraction of the chip's real HALF-THICKNESS, which is the
        // only sane reading of "round the edge": a chip is a thin disc, and its
        // edge is as deep as it is thick.
        //
        // The unit chip is then scaled anisotropically — (diam, thick, diam) — so a
        // fillet that is circular on screen must be an ELLIPSE here: fa*thick has
        // to equal fr*diam, hence fr = fa * thick/diam. Getting this wrong is what
        // made a rounded chip lose its face: with fr = fa the fillet ate half the
        // radius and the denomination disappeared under the rim.
        const aspect = (diam > 0 ? Math.max(0.01, thick / diam) : 0.25);
        const fa = Math.max(0, Math.min(1, CHIP_ROUND)) * HH;
        const fr = fa * aspect;
        const key = fa.toFixed(4) + "|" + fr.toFixed(4);
        // One set per shape, kept: chips of two sizes on the felt at once used to
        // throw each other's geometry away on every park.
        if (!s.chipParts) s.chipParts = new Map();
        const have = s.chipParts.get(key);
        if (have) return have;
        const capR = Math.max(0.05, R - fr);

        // Rim profile in the (radius, height) half-plane, bottom to top.
        const pts = [];
        if (fa <= 1e-6) {
            pts.push(new T.Vector2(R, -HH), new T.Vector2(R, HH));
        } else {
            const SEG = 8;
            for (let i = 0; i <= SEG; i++) {           // bottom fillet
                const a2 = -Math.PI / 2 + (i / SEG) * (Math.PI / 2);
                pts.push(new T.Vector2(capR + fr * Math.cos(a2), -HH + fa + fa * Math.sin(a2)));
            }
            for (let i = 0; i <= SEG; i++) {           // top fillet
                const a2 = (i / SEG) * (Math.PI / 2);
                pts.push(new T.Vector2(capR + fr * Math.cos(a2), HH - fa + fa * Math.sin(a2)));
            }
        }
        const rim = new T.LatheGeometry(pts, 48);
        // The rim art carries painted shading, dark at its top and bottom edges,
        // to make a square edge look turned. On a real fillet the lamp does that,
        // and the painted dark band landed right against the face as a seam: the
        // edge read as a separate ring sitting proud of the chip. So a rounded
        // rim samples only the art's flat middle.
        if (fa > 1e-6) {
            const uv = rim.attributes.uv;
            for (let i = 0; i < uv.count; i++) uv.setY(i, 0.5);
            uv.needsUpdate = true;
        }
        const cap = new T.CircleGeometry(capR, 48);
        const parts = { rim: rim, cap: cap, capY: HH };
        s.chipParts.set(key, parts);
        return parts;
    }

    function disposeChipParts(s) {
        if (!s.chipParts) return;
        for (const p of s.chipParts.values()) { p.rim.dispose(); p.cap.dispose(); }
        s.chipParts = null;
    }

    // Rebuild the shared chip geometry at a new rounding and hand it to every chip
    // already on the felt.
    function setChipRound(v) {
        const n = parseFloat(v);
        const q = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
        if (q === CHIP_ROUND) return;
        CHIP_ROUND = q;
        const s = session;
        if (!s) return;
        for (const g of s.chips || []) {
            const u = g.userData || {};
            // Each chip carries the size it was built at, so the fillet is rebuilt
            // against the real proportions rather than a guess.
            const parts = chipParts(s, u.gpeDiam || 26, u.gpeThick || 4);
            if (u.gpeRim) u.gpeRim.geometry = parts.rim;
            if (u.gpeTop) { u.gpeTop.geometry = parts.cap; u.gpeTop.position.y = parts.capY; }
            if (u.gpeBot) { u.gpeBot.geometry = parts.cap; u.gpeBot.position.y = -parts.capY; }
        }
        s.needsRender = Math.max(s.needsRender, 2);
        s.shadowDirty = true;
    }

    // ---------- the plate under a chip stack ----------
    // A faded white silhouette on the felt around a stack, with a tab off the near
    // side carrying the stack's value in black. It replaces gpokr's own label — a
    // black box with white text sitting ON the chips — which read as a sticker
    // stuck to the table rather than part of it.
    //
    // Drawn as a canvas on a quad lying on the felt, UNDER the chips: the chips
    // then stand on their own silhouette, which is what makes it read as a coaster
    // rather than an outline. The text foreshortens with everything else, which at
    // this camera costs 10% of its height and is the point — a label that ignored
    // the perspective would be the sticker again.
    const PLATE = {
        OUT: 4,           // css px of silhouette proud of the stack, all the way round
        PAD: 7,           // the ONLY padding number: air between the value and the
                          // tab's edge, the same on all four sides. The tab is sized
                          // from the glyphs plus this, so nothing can drift.
        TAB_MIN_W: 40,    // ...unless the label is so short the tab would be a lozenge
        TAB_R: 7,         // the tab's corner radius — always applied, see below
        JOIN: 5,          // how far the tab reaches UP into the silhouette, so the
                          // two are one shape with one continuous outline. Small on
                          // purpose: the silhouette lies on the felt and the chips
                          // STAND on it, so anything the tab slides under the stack
                          // is occluded by the chips — enough to fuse, no more. At a
                          // stack this size it fuses over a ~22px neck. Capped at PAD
                          // at the point of use, so the overlap can never reach the
                          // text — what slides under the chips is padding, not value.
        MARGIN: 3,        // canvas margin, so a corner radius never clips at the edge
        FILL: "rgba(0,0,0,0.42)",
        TEXT: "#f4f7fa",
    };

    // Measured off-screen: the canvas has to be sized before there is a canvas to
    // measure on.
    let plateFont = "600 13px Arial, Helvetica, sans-serif";
    let plateMeasure = null;
    function plateCtx() {
        if (!plateMeasure) {
            const c = document.createElement("canvas").getContext("2d");
            if (!c) return null;
            plateMeasure = c;
        }
        plateMeasure.font = plateFont;
        return plateMeasure;
    }
    // Cap height of a FIXED reference, not of the label: measuring the label itself
    // would make the tab a different height for "$25" than for "$1,375" (the comma
    // descends), and the plate would jiggle every time the amount changed.
    function plateAscent() {
        const c = plateCtx();
        if (!c) return 9.5;
        const m = c.measureText("$0");
        return m.actualBoundingBoxAscent || 9.5;
    }
    function plateTabWidth(label) {
        const c = plateCtx();
        if (!c) return PLATE.TAB_MIN_W;
        return Math.max(PLATE.TAB_MIN_W,
            Math.ceil(c.measureText(label).width) + PLATE.PAD * 2);
    }
    // Digits sit PAD from the top and PAD from the bottom of the tab, which is the
    // same PAD they get left and right. Descenders (the comma) eat into the bottom
    // padding rather than adding to the height — centring on the comma instead of on
    // the figures would leave the digits looking high.
    const plateTabHeight = () => plateAscent() + PLATE.PAD * 2;

    function plateTexture(T, w, h, box, tab, label) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2) * 2;   // crisp text
        const cv = document.createElement("canvas");
        cv.width = Math.max(8, Math.round(w * dpr));
        cv.height = Math.max(8, Math.round(h * dpr));
        const g = cv.getContext("2d");
        if (!g) return null;
        g.scale(dpr, dpr);
        // Appends a rounded rect as a SUBPATH — no beginPath of its own, so several
        // can be unioned inside one fill().
        const path = (x, y, ww, hh, r) => {
            const rr = Math.min(r, ww / 2, hh / 2);
            g.moveTo(x + rr, y);
            g.arcTo(x + ww, y, x + ww, y + hh, rr);
            g.arcTo(x + ww, y + hh, x, y + hh, rr);
            g.arcTo(x, y + hh, x, y, rr);
            g.arcTo(x, y, x + ww, y, rr);
            g.closePath();
        };
        // ONE continuous outline. The silhouette and the tab are two subpaths of a
        // SINGLE fill(), so they union: the boundary runs unbroken from around the
        // stack down around the value, with no seam where they meet. Filling them
        // separately would not do — the fill is translucent, so the overlap would
        // composite twice and draw a bright bar across the join.
        //
        // The silhouette's corner radius is half its short side, so it is a stadium
        // around the stack rather than a rounded box — a chip is round, and a boxy
        // outline round a round thing reads as a mistake. The tab is fully rounded
        // on all four corners, always, and the canvas is sized to fit whichever of
        // the two is wider so a long value can never clip its corners flat.
        g.fillStyle = PLATE.FILL;
        g.beginPath();
        path(box.x, box.y, box.w, box.h, Math.min(box.w, box.h) / 2);
        path(tab.x, tab.y, tab.w, tab.h, Math.min(PLATE.TAB_R, tab.h / 2));
        g.fill();
        g.fillStyle = PLATE.TEXT;
        g.font = plateFont;
        g.textAlign = "center";
        g.textBaseline = "alphabetic";
        g.fillText(label, tab.x + tab.w / 2, tab.y + PLATE.PAD + plateAscent());

        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = T.LinearFilter;
        tex.magFilter = T.LinearFilter;
        return tex;
    }

    // rect is the stack's footprint in viewport px. opts.diameter is what the chips
    // are actually DRAWN at, which is not the sprite's 24px — the plate has to hug
    // the geometry, not the artwork it replaced.
    function parkStackPlate(rect, amount, opts) {
        const s = session;
        if (!s || !rect || !rect.width) return null;
        const T = window.THREE;
        if (!T) return null;
        if (!s.plateGeo) s.plateGeo = new T.PlaneGeometry(1, 1);
        const mat = new T.MeshBasicMaterial({ transparent: true, depthWrite: false });
        const mesh = new T.Mesh(s.plateGeo, mat);
        mesh.rotation.x = -Math.PI / 2;      // lie on the felt
        mesh.renderOrder = 2;                // over the felt, under the chips
        s.scene.add(mesh);
        if (!s.plates) s.plates = new Set();
        s.plates.add(mesh);

        let at = rect, amt = amount, gone = false, tabAt = null;
        let diam = (opts && opts.diameter) || 26;
        let avoid = (opts && opts.avoid) || [];
        const mine = s.epoch;
        // Cheap signature, so a poll that hands us the same cards is not a re-render.
        const sig = (list) => (list || []).map((a) =>
            Math.round(a.left) + "," + Math.round(a.top) + "," +
            Math.round(a.width) + "," + Math.round(a.height) + "," + (a.w || 1)).join(";");
        let avoidSig = sig(avoid);

        const place = () => {
            const f = feltFrame();
            if (!f) return;
            const label = "$" + Math.round(amt).toLocaleString();
            const tw = plateTabWidth(label);
            // The silhouette hugs the chips: the sprite footprint grown by however
            // much wider the drawn chip is than the 24px sprite it stands for, plus
            // the outline itself.
            const grow = Math.max(0, (diam - 24) / 2) + PLATE.OUT;
            const sw = at.width + grow * 2, sh = at.height + grow * 2;
            // The tab starts INSIDE the silhouette by `join`, which is what fuses
            // the two into one shape. Clamped so a short stack cannot be swallowed.
            const th = plateTabHeight();
            const join = Math.min(PLATE.JOIN, sh / 2, PLATE.PAD);
            const cx = at.left + at.width / 2, cy = at.top + at.height / 2;

            // WHERE THE TAB GOES. Straight below is the nicest, but a stack near
            // the felt's edge hangs its tab off the cloth — and because the canvas
            // is the table element, off the cloth eventually means off the CANVAS,
            // where it is cut in half by nothing at all. So the tab leans toward
            // the middle of the table instead.
            //
            // Candidates in order of preference, each still fused to the silhouette
            // by `join`: straight below, diagonally in-board, then squarely beside.
            // NOT above — the silhouette lies on the felt and the chips STAND on it,
            // so up-screen of a stack is exactly where the chips are.
            const D = (sh + th) / 2 - join;             // clear below
            const S = (sw + tw) / 2 - join;             // clear to one side
            const inward = f.r.left + FELT_CX_PX * f.scale >= cx ? 1 : -1;
            // Both ways round, inward first: a card sitting where the value wants to
            // go is common enough that having only one alternative is not enough.
            // Below first, then below-but-tucked-closer, and only then out to a
            // side. Values scattered left, right and under around one table read as
            // mess even when each one is individually correct, so the order buys
            // consistency: sideways is a last resort, not an equal option.
            // Last, at a price: up-screen but well off to the side, clear of the
            // chips. For a stack with its pair on one side, the rail below and a
            // neighbour's value on the other, it is the one spot that is free.
            const UP_COST = 600;
            const tries = [[0, D], [0, D * 0.72], [inward * S * 0.7, D * 0.75],
                [-inward * S * 0.7, D * 0.75], [inward * S, 0], [-inward * S, 0],
                [inward * S, -D * 0.55, UP_COST], [-inward * S, -D * 0.55, UP_COST]];
            let ox = 0, oy = D, best = -Infinity;
            for (const t of tries) {
                const l = cx + t[0] - tw / 2, tp = cy + t[1] - th / 2;
                // Score by how many of the tab's corners land on the cloth. The
                // ellipse test is the same one that decides felt membership
                // everywhere else, so "fits" means the same thing here as there.
                let n = 0;
                for (const qx of [l, l + tw]) {
                    for (const qy of [tp, tp + th]) {
                        const q = toFelt(f, qx, qy);
                        if (onFelt(q.X, q.Z, 0.99)) n++;
                    }
                }
                // ...then by what would sit ON TOP of it. The plate lies on the felt,
                // under everything, so a card over the value hides the value — being
                // on the cloth is worth more than being unobstructed, but only just.
                let hidden = 0;
                for (const a of avoid) {
                    const ow = Math.min(l + tw, a.left + a.width) - Math.max(l, a.left);
                    const oh = Math.min(tp + th, a.top + a.height) - Math.max(tp, a.top);
                    // w: how much worse than hidden this overlap is (another
                    // value too close reads as one figure).
                    if (ow > 0 && oh > 0) hidden += ow * oh * (a.w || 1);
                }
                const score = n * 4000 - hidden - (t[2] || 0);
                if (score > best) { best = score; ox = t[0]; oy = t[1]; }
                if (n === 4 && !hidden) break;
            }

            // Canvas = the union's bounding box. The silhouette sits at the stack,
            // the tab at (ox, oy) from it; both are laid out relative to whichever
            // corner the box starts at, so an offset tab grows the canvas on its own
            // side rather than dragging the silhouette off the chips.
            tabAt = { left: cx + ox - tw / 2, top: cy + oy - th / 2, width: tw, height: th };
            const bx = -sw / 2, by = -sh / 2, txo = ox - tw / 2, tyo = oy - th / 2;
            const minX = Math.min(bx, txo), maxX = Math.max(bx + sw, txo + tw);
            const minY = Math.min(by, tyo), maxY = Math.max(by + sh, tyo + th);
            const w = maxX - minX + PLATE.MARGIN * 2;
            const h = maxY - minY + PLATE.MARGIN * 2;
            const box = { x: bx - minX + PLATE.MARGIN, y: by - minY + PLATE.MARGIN,
                w: sw, h: sh };
            const tab = { x: txo - minX + PLATE.MARGIN, y: tyo - minY + PLATE.MARGIN,
                w: tw, h: th };
            const tex = plateTexture(T, w, h, box, tab, label);
            if (tex) {
                if (mat.map) mat.map.dispose();
                mat.map = tex;
                mat.needsUpdate = true;
            }
            // Place the QUAD so that the silhouette's centre lands on the stack's.
            // A canvas px is a screen px here: the felt's depth carries 1/sinE and
            // the camera foreshortens it straight back out again.
            const p = toFelt(f, cx + (w / 2 - (box.x + sw / 2)),
                cy + (h / 2 - (box.y + sh / 2)));
            mesh.position.set(p.X, -FELT_DROP + 0.02, p.Z);
            mesh.scale.set(w * f.wpp, h * f.wpp / s.sinE, 1);
        };
        place();
        s.needsRender = Math.max(s.needsRender, 2);

        return {
            move(r, newAmount, newDiam, newAvoid) {
                if (gone || session !== s || s.epoch !== mine) return;
                let dirty = false;
                if (newDiam != null && newDiam !== diam) { diam = newDiam; dirty = true; }
                if (newAvoid) {
                    const ns = sig(newAvoid);
                    if (ns !== avoidSig) { avoid = newAvoid; avoidSig = ns; dirty = true; }
                }
                if (r && r.width && (Math.abs(r.left - at.left) > 0.5 ||
                    Math.abs(r.top - at.top) > 0.5 || Math.abs(r.width - at.width) > 0.5 ||
                    Math.abs(r.height - at.height) > 0.5)) { at = r; dirty = true; }
                if (newAmount != null && newAmount !== amt) { amt = newAmount; dirty = true; }
                if (!dirty) return;
                place();
                s.needsRender = Math.max(s.needsRender, 2);
            },
            remove() {
                if (gone) return;
                gone = true;
                if (session === s) {
                    s.plates.delete(mesh);
                    s.scene.remove(mesh);
                    s.needsRender = Math.max(s.needsRender, 2);
                }
                if (mat.map) mat.map.dispose();
                mat.dispose();
            },
            // Where the value tab went, in viewport px, so other plates can keep
            // their distance.
            tab: () => (gone ? null : tabAt),
            isGone: () => gone || session !== s || s.epoch !== mine,
        };
    }

    // rect is the site's own chip sprite, in viewport px. diameter/thickness are
    // in CSS px, as the sliders set them. row is the chip's height in its stack,
    // which the site tells us through its cs-pos<col>-<row> class.
    function parkChip(rect, denom, opts) {
        const s = session;
        if (!s || !rect || !rect.width) return null;
        const T = window.THREE;
        if (!T || !window.GPE_CHIPS) return null;
        const o = opts || {};
        const a = chipArt(s, denom);
        const parts = chipParts(s, o.diameter || 26, o.thickness || 4);
        const rim = new T.Mesh(parts.rim, a.rimMat);
        const top = new T.Mesh(parts.cap, a.faceMat);
        const bot = new T.Mesh(parts.cap, a.faceMat);
        top.rotation.x = -Math.PI / 2; top.position.y = parts.capY;
        bot.rotation.x = Math.PI / 2;  bot.position.y = -parts.capY;
        const mesh = new T.Group();
        mesh.add(rim, top, bot);
        mesh.userData.gpeRim = rim;
        mesh.userData.gpeTop = top;
        mesh.userData.gpeBot = bot;
        mesh.userData.gpeDiam = o.diameter || 26;
        mesh.userData.gpeThick = o.thickness || 4;
        // The cap's UVs run along local x/z, and this camera looks down the felt
        // at an angle — so the denomination comes out lying on its side unless the
        // disc is turned a quarter. Measured against the four rotations on screen,
        // not derived: +90 is the one that reads.
        mesh.rotation.y = Math.PI / 2;
        // castShadow is per-object and not inherited from a group.
        for (const m of mesh.children) { m.castShadow = true; m.receiveShadow = true; }
        s.scene.add(mesh);
        if (!s.chips) s.chips = new Set();
        s.chips.add(mesh);

        let at = rect, row = Math.max(0, (o.row | 0));
        let diam = o.diameter || 26, thick = o.thickness || 4;
        let gone = false;
        let lift = 0;                        // css px above its resting height

        const place = () => {
            const f = feltFrame();
            if (!f) return;
            const p = toFelt(f, at.left + at.width / 2, at.top + at.height / 2);
            const d = diam * f.wpp, h = Math.max(0.01, thick * f.wpp);
            // On the felt, and stacked straight up it — the whole point of being
            // in this scene rather than over it.
            mesh.position.set(p.X, -FELT_DROP + h / 2 + row * h + lift * f.wpp, p.Z);
            mesh.scale.set(d, h, d);
            // Deliberately NOT gated on onFelt. That test exists to stop a shadow
            // PROXY being planted on the leather or the floor; a real chip is
            // different — a bet that the site drew near the rail belongs where the
            // site drew it, and its shadow landing on the rail is correct, because
            // the rail receives shadows too.
        };
        place();
        s.needsRender = Math.max(s.needsRender, 2);
        s.shadowDirty = true;

        // Falls in, if asked. o.drop = { delay, rise, onLand }: a chip enters above
        // its resting height and accelerates down onto the stack, and onLand fires
        // the instant it arrives — which is what a per-chip sound has to key off,
        // since the whole point is that you hear each one hit rather than one noise
        // for the bet.
        //
        // The fall is quadratic, so it arrives at its fastest rather than easing to
        // a stop: a chip dropped on a stack does not decelerate politely. There is
        // no bounce because a clay chip landing flat on cloth does not bounce.
        if (o.drop) {
            lift = o.drop.rise == null ? DROP_RISE : o.drop.rise;
            let dt0 = -Math.max(0, o.drop.delay || 0);
            const dur = Math.max(0.02, o.drop.fall || DROP_FALL);
            let landed = false;
            place();
            mesh.visible = false;
            const fall = {
                object3D: new T.Group(),      // empty stand-in; the chip is not the actor's
                step(dt) {
                    if (gone) return false;
                    dt0 += dt;
                    if (dt0 < 0) return true;
                    mesh.visible = true;
                    const q = Math.min(1, dt0 / dur);
                    lift = (o.drop.rise == null ? DROP_RISE : o.drop.rise) * (1 - q * q);
                    place();
                    s.shadowDirty = true;
                    if (q < 1) return true;
                    lift = 0;
                    place();
                    if (!landed) {
                        landed = true;
                        if (o.drop.onLand) { try { o.drop.onLand(); } catch (e) { /* not ours */ } }
                    }
                    return false;
                },
            };
            if (!addActor(fall)) { lift = 0; mesh.visible = true; place(); }
        }

        return {
            move(r, newRow, size) {
                if (gone) return;
                if (r && r.width) at = r;
                if (newRow != null) row = Math.max(0, newRow | 0);
                if (size) {
                    diam = size.diameter || diam; thick = size.thickness || thick;
                    // The fillet is a proportion of the thickness, so a size change
                    // is a geometry change.
                    mesh.userData.gpeDiam = diam; mesh.userData.gpeThick = thick;
                    const q = chipParts(s, diam, thick);
                    rim.geometry = q.rim;
                    top.geometry = q.cap; top.position.y = q.capY;
                    bot.geometry = q.cap; bot.position.y = -q.capY;
                }
                place();
                s.needsRender = Math.max(s.needsRender, 2);
                s.shadowDirty = true;
            },
            remove() {
                if (gone) return;
                gone = true;
                s.chips.delete(mesh);
                s.scene.remove(mesh);
                // The materials and textures are shared per denomination and freed
                // with the session, not with the chip.
                s.needsRender = Math.max(s.needsRender, 2);
                s.shadowDirty = true;
            },
            isGone: () => gone,
        };
    }

    // ---------- cards on the felt ----------
    // A community card, as a real slab lying on the real cloth.
    //
    // This replaced setCardCasters, which used to plant an invisible box in this
    // scene at the card's projected position purely so the felt had something to
    // shadow — the card itself being in another WebGL context, and shadows not
    // crossing contexts. The card IS in this scene now, so the felt shadows the
    // card. That box was the clearest example of the fake objects this migration
    // exists to delete: right size, right place, wrong object, square corners, no
    // lean, and nothing at all while the card was in flight.
    //
    // Everything coin3d had to fake for an orthographic camera falls out. There
    // is no lean (the camera is the angle), no GROW on the way in (coming in
    // higher and further back puts the card nearer, and the camera does the rest),
    // and no fudge lift during the flip (the card pivots on its own edge, so the
    // geometry lifts it). Same note parkChip records about the chip lean.
    const CARD_RX = 12 / 210, CARD_RY = 12 / 280;   // corner radii, unit card
    const CARD_RADIUS = 0.07;                       // ...as a fraction of the width, for the back art
    const CARD_EDGE = 0xf6f2e9;                     // paper, before any light touches it
    const CARD_BACK_TINTS = {
        rosette: "#8d2230", lattice: "#1f4f86", fan: "#1f6b45", deco: "#8a6a1e",
        "": "#8d2230",           // gpokr's own back is red, so the default matches
    };
    const DEAL = {
        FLY: 0.28, HOLD: 0.04, FLIP: 0.18, REST: 0.05,   // s — 0.55 total, a budget not a taste:
        LEAD: 26,                                        // it is how long the site's card is covered
        ENTER_LIFT: 60,          // css px above the felt it starts
        ENTER_BACK: 72,          // ...and behind it, which is what carries it up-screen
        SPIN: 0.55,              // rad of spin about the card's own normal, unwinding to 0
        THICK: 2,
    };



    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    // The back is DRAWN, not shipped: assets/backs/*.png are the pair still-life
    // gpokr puts at a seat, the wrong shape for one card. Cached as a CANVAS at
    // module scope but minted into a texture per session — this context is thrown
    // away and recreated on every GWT re-render, and a texture from a dead context
    // is a black card.
    let backCanvasCache = Object.create(null);

    function cardBackCanvas(style) {
        const key = style || "";
        if (backCanvasCache[key]) return backCanvasCache[key];
        const w = 106, h = 138;                  // 2x the card, for a HiDPI display
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const g = cv.getContext("2d");
        if (!g) return null;
        const tint = CARD_BACK_TINTS[key] || CARD_BACK_TINTS[""];
        const r = w * CARD_RADIUS * 2;
        const round = (x, y, ww, hh, rr) => {
            g.beginPath();
            g.moveTo(x + rr, y);
            g.arcTo(x + ww, y, x + ww, y + hh, rr);
            g.arcTo(x + ww, y + hh, x, y + hh, rr);
            g.arcTo(x, y + hh, x, y, rr);
            g.arcTo(x, y, x + ww, y, rr);
            g.closePath();
        };
        g.fillStyle = "#f4f1ea";                 // the paper edge, as on a real back
        round(0, 0, w, h, r); g.fill();
        g.fillStyle = tint;
        round(3, 3, w - 6, h - 6, r * 0.8); g.fill();
        g.save();
        round(7, 7, w - 14, h - 14, r * 0.6); g.clip();
        g.strokeStyle = "rgba(255,255,255,0.20)";
        g.lineWidth = 1.5;
        for (let i = -h; i < w + h; i += 9) {
            g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
            g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke();
        }
        g.restore();
        backCanvasCache[key] = cv;
        return cv;
    }

    function cardBackTexture(T, s, style) {
        const key = style || "";
        if (!s.backTex) s.backTex = Object.create(null);
        if (s.backTex[key]) return s.backTex[key];
        const cv = cardBackCanvas(key);
        if (!cv) return null;
        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
        tex.anisotropy = 4;
        s.backTex[key] = tex;
        return tex;
    }

    // Mipmaps stay OFF with LinearFilter. This is the standing fix for a blur bug
    // with four separate causes in its history — turning them on would re-open the
    // WebGL1 NPOT resize hazard, and anisotropy without a mip chain does nothing.
    function cardTexture(T, src) {
        const tex = new T.Texture(src);
        tex.colorSpace = T.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = T.LinearFilter;
        tex.magFilter = T.LinearFilter;
        tex.needsUpdate = true;
        return tex;
    }

    // A rounded slab plus two rounded caps, unit-sized and shared. The caps are
    // separate meshes because an ExtrudeGeometry puts BOTH ends in one material
    // group, and a card needs a different picture on each.
    function cardGeo(s) {
        if (s.cardGeo) return s.cardGeo;
        const T = window.THREE;
        const rx = CARD_RX, ry = CARD_RY;
        const sh = new T.Shape();
        sh.moveTo(rx, 0);
        sh.lineTo(1 - rx, 0);
        sh.quadraticCurveTo(1, 0, 1, ry);
        sh.lineTo(1, 1 - ry);
        sh.quadraticCurveTo(1, 1, 1 - rx, 1);
        sh.lineTo(rx, 1);
        sh.quadraticCurveTo(0, 1, 0, 1 - ry);
        sh.lineTo(0, ry);
        sh.quadraticCurveTo(0, 0, rx, 0);
        const body = new T.ExtrudeGeometry(sh, { depth: 0.995, bevelEnabled: false, curveSegments: 8 });
        body.translate(-0.5, -0.5, -0.4975);
        const cap = new T.ShapeGeometry(sh, 8);
        cap.translate(-0.5, -0.5, 0);
        s.cardGeo = { body: body, cap: cap };
        return s.cardGeo;
    }

    function cardMesh(T, s, faceImg, backStyle) {
        let faceTex = null;
        try { faceTex = cardTexture(T, faceImg); } catch (e) { return null; }
        const backTex = cardBackTexture(T, s, backStyle);
        if (!backTex) return null;
        const geo = cardGeo(s);
        // alphaTest, not transparent. The card's rounded corners come from the
        // GEOMETRY here, so the only thing the face's alpha still has to do is cut
        // the site PNG's own transparent corners — which alphaTest does in the
        // OPAQUE pass, so the card writes depth and sorts against the felt, the
        // logo and every other card by the depth buffer rather than by distance.
        const faceMat = new T.MeshLambertMaterial({ map: faceTex, alphaTest: 0.5 });
        const backMat = new T.MeshLambertMaterial({ map: backTex, alphaTest: 0.5 });
        const slab = new T.Mesh(geo.body, new T.MeshLambertMaterial({ color: CARD_EDGE }));
        const front = new T.Mesh(geo.cap, faceMat);
        front.position.z = 0.5;
        const back = new T.Mesh(geo.cap, backMat);
        back.position.z = -0.5;
        back.rotation.y = Math.PI;   // faces outward, and mirrors the back's art
        // The slab casts, the face receives — which shadows a card by the card
        // lying on it, for nothing, out of the same shadow map.
        slab.castShadow = true;
        slab.receiveShadow = true;
        front.receiveShadow = true;
        // Deliberately NOT on a private layer. coin3d needed one to keep its chip
        // rig off the cards; here there is one rig and being lit by it is the point.
        const group = new T.Group();
        group.add(slab, front, back);
        group.userData.gpeFaceTex = faceTex;
        group.userData.gpeFaceMat = faceMat;
        return group;
    }

    // The other players' hole cards. The site draws these as a small flat sprite
    // standing upright against the cloth, which is the one thing left on the felt
    // that does not share the table's perspective — a card on a table you are
    // looking down at should be lying down.
    //
    // Same slab as a dealt card, with no flight and no flip: it arrives face-down
    // and stays that way, so there is nothing to animate. It casts into the same
    // shadow map as everything else, which is the whole point of one scene.
    //
    // The one thing NOT taken from the sprite is its aspect. gpokr's back asset is
    // 23x26 — nearly square, because it is drawn as a flat upright tile rather than
    // as a card in perspective. Laid flat, 23x26 foreshortens to about 23x23 and
    // reads as a coaster, so the length is the card's own proportion off the width.
    //
    // Gentler than a real card's 1.4, deliberately: the PAIR has to end up in the
    // sprite's footprint, and two cards offset by REAR already spend some of it.
    // At 1.4 the pair came out half again as tall as the tile it replaced, which
    // next to the seats still showing the site's own tile read as a mistake.
    const CARD_ASPECT = 1.25;
    // The thickness slider is set against a BOARD card, whose slot is 53px wide. A
    // seat's card is 23px, and 8px of edge on a 23px card is a block of wood, not a
    // card — so the same setting is applied in proportion rather than literally.
    const CARD_THICK_REF = 53;
    function parkCardBack(rect, opts) {
        const s = session;
        if (!s || !rect || !rect.width) return null;
        const T = window.THREE;
        if (!T) return null;
        const o = opts || {};
        const backTex = cardBackTexture(T, s, o.backStyle);
        if (!backTex) return null;
        const geo = cardGeo(s);
        // One material for both caps of both cards: the back's art is the same either
        // way up, and the session owns the texture, so nothing here disposes it.
        const face = new T.MeshLambertMaterial({ map: backTex, alphaTest: 0.5 });
        const edge = new T.MeshLambertMaterial({ color: CARD_EDGE });
        // TWO cards, because that is what the sprite is. gpokr's 23x26 asset is a
        // whole little still life — the pair, the rear card peeking out up-and-left,
        // and the halo under them — so drawing one slab would turn a hand of two
        // into a hand of one. The rear is offset and the front sits ON it, which is
        // what the art depicts and what a real pair does.
        const REAR = 3;                       // css px the rear card peeks, up and left
        const cards = [];
        for (let i = 0; i < 2; i++) {
            const slab = new T.Mesh(geo.body, edge);
            const up = new T.Mesh(geo.cap, face);
            up.position.z = 0.5;
            const down = new T.Mesh(geo.cap, face);
            down.position.z = -0.5;
            down.rotation.y = Math.PI;
            slab.castShadow = true;
            slab.receiveShadow = true;
            up.receiveShadow = true;
            const g = new T.Group();
            g.add(slab, up, down);
            s.scene.add(g);
            s.cards.add(g);
            cards.push(g);
        }
        const mine = s.epoch;

        let at = rect, gone = false, thick = clampCardThick(o.thickness);
        let spin = o.spin || 0;

        const place = () => {
            const f = feltFrame();
            if (!f) return;
            // Each card is the tile MINUS the offset, so the two of them together
            // occupy the footprint the site's single tile did.
            const w = Math.max(6, at.width - REAR);
            const scale = Math.min(1, at.width / CARD_THICK_REF);
            const h = Math.max(0.02, thick * scale * f.wpp);
            const L = w * CARD_ASPECT * f.wpp;
            for (let i = 0; i < cards.length; i++) {
                const rear = i === 0;
                const r = { left: at.left + (rear ? 0 : REAR),
                    top: at.top + (rear ? 0 : REAR), width: w, height: at.height };
                const q = rectToFelt(f, r);
                // The front card stands on the rear one, so the pair is a stack of
                // two rather than two slabs fighting for the same plane.
                cards[i].position.set(q.X, -FELT_DROP + h / 2 + (rear ? 0 : h), q.Z);
                cards[i].rotation.set(-Math.PI / 2, 0, spin);   // lie flat, back art up
                cards[i].scale.set(q.sx, L, h);
            }
            s.needsRender = Math.max(s.needsRender, 2);
            s.shadowDirty = true;
        };
        place();

        return {
            move(r, newThick) {
                if (gone || session !== s || s.epoch !== mine) return;
                let dirty = false;
                if (newThick != null) {
                    const t = clampCardThick(newThick);
                    if (t !== thick) { thick = t; dirty = true; }
                }
                if (r && r.width && (Math.abs(r.left - at.left) > 0.5 ||
                    Math.abs(r.top - at.top) > 0.5 || Math.abs(r.width - at.width) > 0.5 ||
                    Math.abs(r.height - at.height) > 0.5)) { at = r; dirty = true; }
                if (dirty) place();
            },
            setThickness(t) { this.move(null, t); },
            remove() {
                if (gone) return;
                gone = true;
                for (const g of cards) {
                    if (session === s) { s.cards.delete(g); s.scene.remove(g); }
                    disposeCard(g);
                }
                if (session === s) {
                    s.needsRender = Math.max(s.needsRender, 2);
                    s.shadowDirty = true;
                }
            },
            isGone: () => gone || session !== s || s.epoch !== mine,
        };
    }

    // rect is the site's own card slot in viewport px; faceImg its decoded <img>.
    // The card STAYS when the flight ends — it is the board from then on, with the
    // site's image covered behind it — so the mesh lives in the scene and the
    // actor only drives it from outside.
    // opts.faceDown deals a card nobody has seen yet: it flies in and stays face
    // down on its spot until reveal(face) turns it over. That is how the site
    // deals the board, a back in each slot first and the face a beat later, and
    // following it means one card per slot from the deal to the end of the hand.
    function dealCard(rect, faceImg, opts) {
        const s = session;
        const o = opts || {};
        if (!s || !rect || !rect.width || (!faceImg && !o.faceDown)) return null;
        const T = window.THREE;
        if (!T) return null;
        if (!faceImg) {
            // The face is unknown until reveal(); something has to be on it.
            faceImg = document.createElement("canvas");
            faceImg.width = faceImg.height = 4;
        }
        const group = cardMesh(T, s, faceImg, o.backStyle);
        if (!group) return null;
        s.scene.add(group);
        s.cards.add(group);
        const mine = s.epoch;

        let at = rect, gone = false, parked = false, facedUp = false;
        let revealed = !o.faceDown;
        const rest = () => place(null, null, null, facedUp ? 0 : Math.PI, 0);
        let thick = clampCardThick(o.thickness);
        const delay = Math.max(0, o.delay || 0);
        let t = o.instant ? (DEAL.FLY + DEAL.HOLD + DEAL.FLIP + DEAL.REST) : -delay;

        // theta: PI face-down, 0 face-up. The tumble is about world X — over the
        // card's SHORT edge, forward into empty felt. Not Z: rolling over the long
        // edge sweeps half the card's width each side, and board cards are ~8px
        // apart, so it would sweep straight through its neighbours.
        //
        // The card goes edge-on at theta ~= 116deg, about 64% through the flip, so
        // the order is back -> one-frame sliver -> face standing upright and square
        // to the camera -> flat. The reveal lands where the card is most legible,
        // and a card standing on the felt mid-flip rakes a long shadow across the
        // cloth, which is the frame that proves this whole thing.
        const place = (X, Y, Z, theta, spin) => {
            const f = feltFrame();
            if (!f) return;
            const q = rectToFelt(f, at);
            const h = Math.max(0.02, thick * f.wpp);   // floor in WORLD units: 0.2 css px is
            const phi = -Math.PI / 2 + theta;          // scale-dependent and lands under the
                                                       // key light's 0.02 normalBias -> acne
            // The card's length is its REAL proportion — rect.height * wpp — and
            // deliberately NOT rectToFelt's sz, which carries a 1/sinE stretch.
            //
            // That stretch exists to make a rectangle project back onto exactly the
            // slot the site laid out, which is right for a shadow proxy (what used
            // it before) and wrong for the card itself: cancelling the
            // foreshortening cancels the only cue that the card is lying down. A
            // stretched card fills its slot perfectly and reads as standing upright
            // facing the camera — next to a chip, whose round top foreshortens into
            // an ellipse, it looks like it is on a different plane. Unstretched it
            // covers 53x62 of the slot's 53x69 instead, which costs nothing: the
            // site's own image is visibility:hidden, so there is nothing underneath
            // for it to fail to line up with.
            const L = at.height * f.wpp;
            // Lowest vertex grazes the felt: h/2 lying flat at either end, L/2
            // stood on edge at 90 degrees. That IS a card pivoting on its edge, so
            // the contact shadow tucks under it without being told to.
            const lift = (L / 2) * Math.abs(Math.cos(phi)) + (h / 2) * Math.abs(Math.sin(phi));
            group.position.set(X == null ? q.X : X, (Y == null ? 0 : Y) - FELT_DROP + lift,
                Z == null ? q.Z : Z);
            group.rotation.set(phi, 0, spin || 0);
            group.scale.set(q.sx, L, h);
        };

        // Where it comes in from: up and back, both of which move a point up-screen
        // under this camera. Clamped to the canvas so it never enters off the top —
        // which keeps this step independent of the canvas-size work.
        const entry = () => {
            const f = feltFrame();
            if (!f) return null;
            const q = rectToFelt(f, at);
            const cy = at.top + at.height / 2;
            const avail = Math.max(0, cy - f.r.top - 6);
            const k = Math.min(1, avail / 98);          // 98px is what lift+back buy up-screen
            return {
                X: q.X + DEAL.LEAD * f.wpp,
                Y: DEAL.ENTER_LIFT * k * f.wpp,
                Z: q.Z - DEAL.ENTER_BACK * k * f.wpp / s.sinE,
            };
        };

        // So a tilt change can reach a card that is already lying there.
        group.userData.gpeReplace = () => { if (parked && !gone) rest(); };
        if (o.instant && !revealed) {
            place(null, null, null, Math.PI, 0);
            parked = true;
        }
        else if (o.instant) {
            place(null, null, null, 0, 0);
            parked = true;
            facedUp = true;
            // Report it face-up NOW. There is no actor on this path (see below), so
            // nothing else ever will — and the caller's watchdog unparks a card that
            // never reported landing, which adoptBoardCards then re-parks instantly,
            // which never reports either: the board is torn down and rebuilt every
            // 1.5s, forever, and any frame caught mid-cycle shows a card that has not
            // landed properly. coin3d never had this because it registers its actor
            // even when instant, so its step() runs once and does the reporting.
            if (o.onFaceUp) { try { o.onFaceUp(); } catch (err) { /* not ours */ } }
        }
        else { place(null, null, null, Math.PI, DEAL.SPIN); group.visible = false; }
        s.needsRender = Math.max(s.needsRender, 2);
        s.shadowDirty = true;

        const actor = {
            // An empty stand-in on purpose: addActor puts this in the scene and
            // removeActor takes it out, and neither must touch the card.
            object3D: new T.Group(),
            step(dt) {
                if (gone) return false;
                t += dt;
                if (t < 0) return true;
                group.visible = true;
                const e = entry();
                if (!e) return true;
                if (t < DEAL.FLY) {
                    const p = easeOutCubic(t / DEAL.FLY);
                    const f = feltFrame();
                    const q = f ? rectToFelt(f, at) : null;
                    if (q) {
                        place(e.X + (q.X - e.X) * p, e.Y * (1 - p), e.Z + (q.Z - e.Z) * p,
                            Math.PI, DEAL.SPIN * (1 - p));
                    }
                    return true;
                }
                // Face down and waiting: lie there, off the actor list, until
                // reveal() puts it back on for the flip.
                if (!revealed) { place(null, null, null, Math.PI, 0); parked = true; return false; }
                const afterFly = t - DEAL.FLY;
                if (afterFly < DEAL.HOLD) { place(null, null, null, Math.PI, 0); return true; }
                const fp = (afterFly - DEAL.HOLD) / DEAL.FLIP;
                if (fp < 1) {
                    place(null, null, null, Math.PI * (1 - easeInOutCubic(fp)), 0);
                    return true;
                }
                place(null, null, null, 0, 0);
                if (!facedUp) {
                    facedUp = true;
                    if (o.onFaceUp) { try { o.onFaceUp(); } catch (err) { /* not ours */ } }
                }
                if (afterFly - DEAL.HOLD - DEAL.FLIP < DEAL.REST) return true;
                parked = true;
                return false;   // NOTE: stepActors keeps an actor only on === true
            },
        };
        if (!o.instant && !addActor(actor)) { s.scene.remove(group); s.cards.delete(group); return null; }

        const live = () => !gone && session === s && s.epoch === mine;
        const handle = {
            move(r) {
                if (!live() || !r || !r.width) return;
                at = r;
                if (parked) rest();
                s.needsRender = Math.max(s.needsRender, 2);
                s.shadowDirty = true;
            },
            remove() {
                if (gone) return;
                gone = true;
                if (session === s) {
                    s.cards.delete(group);
                    s.scene.remove(group);
                    s.needsRender = Math.max(s.needsRender, 2);
                    s.shadowDirty = true;
                }
                disposeCard(group);
            },
            retexture(src) {
                if (!live() || !src) return false;
                const mat = group.userData.gpeFaceMat;
                if (!mat) return false;
                let tex;
                try { tex = cardTexture(T, src); } catch (e) { return false; }
                const old = group.userData.gpeFaceTex;
                mat.map = tex;
                mat.needsUpdate = true;
                group.userData.gpeFaceTex = tex;
                if (old) { try { old.dispose(); } catch (e) {} }
                s.needsRender = Math.max(s.needsRender, 2);
                return true;
            },
            setThickness(v) {
                if (!live()) return;
                const n = clampCardThick(v);
                if (n === thick) return;
                thick = n;
                if (parked) rest();
                s.needsRender = Math.max(s.needsRender, 2);
                s.shadowDirty = true;
            },
            // Turn a face-down deal over, showing src. Still in the air, it just
            // flips on landing as an ordinary deal would; lying there, it flips
            // where it lies — or snaps over, with ro.instant.
            reveal(src, ro) {
                if (!live() || revealed) return false;
                if (src) handle.retexture(src);
                revealed = true;
                if (!parked) return true;
                if (ro && ro.instant) {
                    facedUp = true;
                    rest();
                    s.needsRender = Math.max(s.needsRender, 2);
                    s.shadowDirty = true;
                    if (o.onFaceUp) { try { o.onFaceUp(); } catch (err) { /* not ours */ } }
                    return true;
                }
                parked = false;
                t = DEAL.FLY;
                group.visible = true;
                return addActor(actor);
            },
            isRevealed: () => revealed,
            thickness: () => thick,
            isParked: () => parked && !gone,
            isGone: () => gone || session !== s || s.epoch !== mine,
        };
        return handle;
    }



    // Card thickness in CSS px. Floors at 0 here — the setting's own slider goes to
    // 0 and "paper" is a legitimate ask; the WORLD floor that stops shadow acne is
    // applied in place() where the conversion happens.
    function clampCardThick(v) {
        const n = parseFloat(v);
        if (!isFinite(n)) return DEAL.THICK;
        return Math.max(0, Math.min(24, n));
    }

    // A parked card is NOT an actor — its actor carries an empty stand-in — so
    // removeActor's dispose pass never reaches it. Everything per-card is freed
    // here; the geometry and the back texture are shared and die with the session.
    function disposeCard(group) {
        group.traverse((n) => {
            const m = n.material;
            if (!m) return;
            (Array.isArray(m) ? m : [m]).forEach((x) => x && x.dispose());
        });
        const tex = group.userData && group.userData.gpeFaceTex;
        if (tex) { try { tex.dispose(); } catch (e) {} }
    }

    function projectAbove(pageX, pageY, hCss) {
        const s = session;
        if (!s || !s.camera || !s.placed) return null;
        const T = window.THREE;
        if (!T) return null;
        const f = feltFrame();
        if (!f) return null;
        const p = toFelt(f, pageX, pageY);
        const v = new T.Vector3(p.X, hCss * f.wpp, p.Z).project(s.camera);   // -> NDC
        return {
            x: f.r.left + (v.x * 0.5 + 0.5) * f.r.width,
            y: f.r.top + (-v.y * 0.5 + 0.5) * f.r.height,
        };
    }

    // Set the table's view angle, in degrees. sinE/cosE, the camera, and the felt,
    // rail and wall geometry all derive from it, so this rebuilds the scene rather
    // than trying to patch it in place. Parked cards and chips come back on their
    // own: the epoch bump makes content.js re-park them on the next sweep.
    function setElevation(deg) {
        const n = parseFloat(deg);
        const v = isFinite(n) ? Math.max(20, Math.min(90, n)) : ELEV_DEG_0;
        if (v === ELEV_DEG) return;
        ELEV_DEG = v;
        if (session) { disable(); enable(); }
    }
    const elevation = () => ELEV_DEG;

    // Aim the fill — the second directional, the one that opens up whatever the
    // key leaves dark. It does not cast, so moving it costs nothing but a redraw.
    function setFillLight(x, y, z) {
        FILL_POS = [+x || 0, +y || 0.001, +z || 0];
        const s = session;
        if (!s || !s.fill) return;
        s.fill.position.set(FILL_POS[0], FILL_POS[1], FILL_POS[2]);
        s.fill.updateMatrixWorld(true);
        s.needsRender = Math.max(s.needsRender, 2);
    }

    // How hard each lamp is driven, as a multiple of the tuned default. Any key
    // may be omitted; 1 is the shipped look.
    function setLightLevels(cfg) {
        const c = cfg || {};
        const num = (v, cur) => (isFinite(+v) && +v >= 0 ? Math.min(4, +v) : cur);
        KEY_I = num(c.key, KEY_I);
        FILL_I = num(c.fill, FILL_I);
        AMB_I = num(c.ambient, AMB_I);
        LAMP_I = num(c.lamp, LAMP_I);
        const s = session;
        if (!s) return;
        if (s.key) s.key.intensity = KEY * KEY_I;
        if (s.fill) s.fill.intensity = FILL * FILL_I;
        if (s.amb) s.amb.intensity = AMBIENT * AMB_I;
        if (s.overhead) s.overhead.intensity = OVERHEAD * LAMP_I;
        // A dimmer key is a fainter shadow, so the map has to be redrawn.
        s.shadowDirty = true;
        s.needsRender = Math.max(s.needsRender, 2);
    }

    function lightLevels() { return { key: KEY_I, fill: FILL_I, ambient: AMB_I, lamp: LAMP_I }; }

    // Aim the shadow-casting key light. The shadow camera looks at the origin
    // from wherever the light is, so moving the light is enough — but its matrix
    // has to be refreshed by hand, since nothing else touches it between frames.
    function setKeyLight(x, y, z) {
        KEY_POS = [+x || 0, +y || 0.001, +z || 0];
        const s = session;
        if (!s || !s.key) return;
        s.key.position.set(KEY_POS[0], KEY_POS[1], KEY_POS[2]);
        s.key.updateMatrixWorld(true);
        s.key.shadow.camera.updateProjectionMatrix();
        s.shadowDirty = true;
        s.needsRender = Math.max(s.needsRender, 2);
    }

    function buildScene(s) {
        const T = window.THREE;
        s.scene = new T.Scene();

        const amb = new T.AmbientLight(0xffffff, AMBIENT * AMB_I);
        s.amb = amb;
        s.scene.add(amb);
        const key = new T.DirectionalLight(0xffffff, KEY * KEY_I);
        key.position.set(KEY_POS[0], KEY_POS[1], KEY_POS[2]);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        // The map is 2048 square over felt, rail, wall, floor and nine stools.
        // Re-rendering it every frame was free while nothing here moved, and stops
        // being free the moment actors do — a dealing card would redraw the whole
        // shadow pass at 60fps for the sake of one moving slab. So it updates only
        // when something says it must (see shadowDirty / touchShadows), which is
        // never for a parked board, an unchanged bet, or an idle table.
        key.shadow.autoUpdate = false;
        key.shadow.needsUpdate = true;      // ...once, for the first frame
        const sc = key.shadow.camera;
        sc.left = -22; sc.right = 22; sc.top = 16; sc.bottom = -16;
        sc.near = 1; sc.far = 80;
        sc.updateProjectionMatrix();
        s.scene.add(key);
        s.key = key;
        const fill = new T.DirectionalLight(0xbfd0d8, FILL * FILL_I);
        fill.position.set(FILL_POS[0], FILL_POS[1], FILL_POS[2]);
        s.fill = fill;
        s.scene.add(fill);

        // Overhead table light with falloff -> center-bright felt (see notes).
        const overhead = new T.PointLight(OVERHEAD_COL, OVERHEAD * LAMP_I, 0, OVERHEAD_DECAY);
        overhead.position.set(0, OVERHEAD_H, 2);
        // This lamp is the one that has to throw the table's shadow onto the
        // floor: it sits straight over the felt and, at floor distance, it is
        // worth ~1.5 intensity against the key light's 0.5, so a shadow from the
        // key alone is washed out to almost nothing. Its shadow is switched on
        // only while a backdrop is showing (see applyBackdrop) — a point light's
        // shadow is a six-face cube map, and with no floor to catch it the cost
        // would buy nothing and would newly shadow the felt for people who have
        // no backdrop at all.
        overhead.shadow.mapSize.set(1024, 1024);
        overhead.shadow.camera.near = 0.5;
        overhead.shadow.camera.far = 60;
        overhead.shadow.bias = -0.0015;
        overhead.castShadow = false;
        s.overhead = overhead;
        s.scene.add(overhead);

        const A = FELT_HALF_W_PX * (VIEW_W / ART_W);           // felt half-width, world
        // Felt half-depth, un-foreshortened — against the REFERENCE angle, not the
        // live one.
        //
        // This used to divide by the live sinE, which meant the table's world
        // dimensions changed every time the view angle moved: drop to 25 and the
        // half-depth went 5.75 -> 12.2, so the oval became a circle and the seats
        // (raycast onto a plane) were thrown into the distance. The table is a
        // table; its size is not a function of where you stand. So the geometry is
        // built once, at REF_SIN, and the view angle now only moves the camera.
        const B = FELT_HALF_D_PX * (VIEW_W / ART_W) / REF_SIN;
        s.feltA = A; s.feltB = B;
        s.feltAspect = A / B;

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
        // The felt is what actually blocks the light: the rail is a thin ring, so
        // on its own it drops a hoop onto the floor rather than a table. Casting
        // from the oval too gives the solid silhouette. shadowSide is explicit
        // because this is a one-sided plane — by default three.js shadow-renders
        // the BACK faces of a FrontSide material, and a floor-facing plane has
        // none, so it would write nothing into the shadow map.
        felt.castShadow = true;
        s.feltMat.shadowSide = T.DoubleSide;
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

        applyTexZoom(s);   // set all texture repeats from the current zoom
        applyDepth(s);     // set relief depth (normal-map strength)
        applyBackdrop(s);  // the floor under the table, if a style is chosen
        applySeats(s);     // ...and a stool or chair at every seat, if switched on

        // ---- gpokr logo watermark on the felt center (loads async) ----
        loadLogoTexture(T, (tex, aspect) => {
            if (!s.enabled) { tex.dispose(); return; }
            s.logoTex = tex;
            s.logoGeo = new T.PlaneGeometry(LOGO_W, LOGO_W / aspect);
            // renderOrder + depthWrite:false so it composites onto the felt rather
            // than fighting it for the same depth.
            //
            // depthTest stays ON. It used to be off — back when the felt was the
            // only thing in this scene and the watermark could not lose to
            // anything. Now that cards and chips lie on the cloth, an untested
            // logo paints straight over them: it is the last thing drawn and it
            // ignores what is in front of it. Being 0.15 above the felt plane is
            // enough to win against the felt without the hammer.
            s.logoMat = new T.MeshBasicMaterial({
                map: tex, transparent: true, opacity: logoOpacity,
                depthWrite: false, depthTest: true,
            });
            const logo = new T.Mesh(s.logoGeo, s.logoMat);
            logo.renderOrder = 10;
            logo.rotation.x = -Math.PI / 2;
            // Just above the FELT, which is at -FELT_DROP — not at y=0.05, which is
            // 0.15 above it. That gap did not matter while the watermark was the
            // only thing in this scene; now a card lying on the cloth is 2px thick
            // and sits BELOW a logo floating that high, so the logo drew straight
            // through the card's face. Sitting on the felt it belongs to, it loses
            // to anything actually resting on it.
            logo.position.set(0, -FELT_DROP + 0.01, 0);  // on the felt, centered
            s.scene.add(logo);
            s.needsRender = Math.max(s.needsRender, 2); // redraw now it's in
        });
    }

    // ---------- actors ----------
    // Deliberately the SAME contract coin3d uses — { object3D, step(dt) -> bool,
    // dispose? }, fixed timestep, the actor's object3D added and removed by the
    // loop. props3d's five motion functions are written against it, so matching it
    // exactly is what lets them move here later without touching one of them.
    const STEP = 1 / 120;        // same numbers as coin3d
    const MAX_SUBSTEPS = 8;

    function addActor(actor) {
        const s = session;
        if (!s || !actor || typeof actor.step !== "function") return false;
        if (actor.object3D) s.scene.add(actor.object3D);
        s.actors.push(actor);
        s.needsRender = Math.max(s.needsRender, 2);
        return true;
    }

    function removeActor(s, actor) {
        const i = s.actors.indexOf(actor);
        if (i >= 0) s.actors.splice(i, 1);
        if (actor.object3D) s.scene.remove(actor.object3D);
        if (typeof actor.dispose === "function") { try { actor.dispose(); } catch (e) {} }
        s.needsRender = Math.max(s.needsRender, 2);
    }

    // Something that casts moved, so the shadow map is stale for one frame.
    function touchShadows() {
        const s = session;
        if (s) { s.shadowDirty = true; s.needsRender = Math.max(s.needsRender, 2); }
    }

    function stepActors(s, dt) {
        if (!s.actors.length) return;
        s.acc = Math.min(s.acc + dt, STEP * MAX_SUBSTEPS);
        while (s.acc >= STEP) {
            for (const a of s.actors.slice()) {
                let alive = false;
                try { alive = a.step(STEP) === true; } catch (e) { alive = false; }
                if (!alive) removeActor(s, a);
            }
            s.acc -= STEP;
        }
        // Anything moving is a caster until proven otherwise, and a frame where an
        // actor moved is exactly the frame the shadow map is stale.
        s.needsRender = Math.max(s.needsRender, 2);
        s.shadowDirty = true;
    }

    // ---------- lifecycle ----------
    // The rAF is unconditional and stays that way: syncToTable has to run every
    // frame to catch the table moving under us, and it is the cheap half. The
    // expensive halves — the render and the shadow pass — are each gated.
    function loop(s, now) {
        if (!s.enabled) return;
        s.raf = requestAnimationFrame((t) => loop(s, t));
        const t = now || 0;
        const dt = Math.min(Math.max(0, (t - (s.last || t)) / 1000), 0.05);
        s.last = t;
        const r = syncToTable(s);
        if (r === "gone") { disable(); return; }
        if (r) {
            s.needsRender = Math.max(s.needsRender, 2);
            s.shadowDirty = true;          // the camera moved; every shadow is stale
            placeSeats(s);    // reframed: the seat rays moved with the camera
        }
        // Dark mode toggles without a reload, so the floor has to follow it.
        if (s.floor && s.floorDark !== isDarkTheme()) {
            applyBackdrop(s);
        }
        stepActors(s, dt);
        if (s.needsRender > 0) {
            if (s.shadowDirty && s.key) { s.key.shadow.needsUpdate = true; s.shadowDirty = false; }
            s.renderer.render(s.scene, s.camera);
            s.needsRender--;
        }
    }

    // Incremented per enable(); see the session's `epoch`.
    let epochCounter = 0;

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
            // Actors, their fixed-step accumulator, and the shadow-map flag.
            actors: [], acc: 0, last: 0, shadowDirty: true,
            cards: new Set(),
            // Bumped on every enable(). Anything holding a handle into this scene
            // compares it and lets go when it changes: syncTable3d does
            // disable(); enable() on any GWT re-render, and a same-tick pair
            // leaves the canvas present while every parked object is destroyed —
            // so "is there a canvas" is not enough to notice.
            epoch: ++epochCounter,
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
        s.raf = requestAnimationFrame((t) => loop(s, t));
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
        // Actors own meshes and materials of their own; give each its dispose()
        // before the renderer goes, or a table re-render leaks one set per actor.
        for (const a of (s.actors || []).slice()) removeActor(s, a);
        [s.feltGeo, s.railGeo, s.wallGeo, s.logoGeo, s.floorGeo,
            s.stoolSeatGeo, s.stoolLegGeo, s.stoolStretchGeo]
            .concat(s.chairGeos || []).forEach((g) => g && g.dispose());
        [s.feltMat, s.railMat, s.wallMat, s.logoMat, s.floorMat,
            s.stoolSeatMat, s.stoolWoodMat,
            s.chairPadMat, s.chairPrintMat, s.chairTubeMat,
            ].forEach((m) => m && m.dispose());
        if (s.floorMat && s.floorMat.map) s.floorMat.map.dispose();
        if (s.chairWeave) s.chairWeave.dispose();
        if (s.chairPrint) s.chairPrint.dispose();
        if (s.feltNormal) s.feltNormal.dispose();
        if (s.feltColor) s.feltColor.dispose();
        if (s.railColor) s.railColor.dispose();
        if (s.railNormal) s.railNormal.dispose();
        if (s.logoTex) s.logoTex.dispose();
        // Parked cards are not actors, so nothing else frees them.
        for (const g of s.cards || []) disposeCard(g);
        if (s.cards) s.cards.clear();
        if (s.cardGeo) { s.cardGeo.body.dispose(); s.cardGeo.cap.dispose(); }
        for (const k in (s.backTex || {})) { try { s.backTex[k].dispose(); } catch (e) {} }
        for (const m of s.plates || []) {
            if (m.material.map) m.material.map.dispose();
            m.material.dispose();
        }
        if (s.plates) s.plates.clear();
        if (s.plateGeo) s.plateGeo.dispose();
        disposeChipParts(s);
        for (const a of (s.chipArt ? s.chipArt.values() : [])) {
            if (!a) continue;
            a.faceMat.dispose(); a.rimMat.dispose();
            a.face.dispose(); a.rim.dispose();   // minted for us by GPE_CHIPS.art
        }
        if (s.renderer) {
            s.renderer.dispose();
            if (s.renderer.forceContextLoss) s.renderer.forceContextLoss();
        }
        if (s.canvas && s.canvas.parentNode) s.canvas.remove();
        restoreHost(s.host, s.saved);
        if (session === s) session = null;
    }

    function disable() { if (session) dispose(session); }

    window.GPE_TABLE3D = { enable, disable, setHost, setTexZoom, setTexDepth, setFeltColor, setLeatherColor, setLogoOpacity, setSurroundColor, setBackdrop, setSeats, projectAbove, feltMaskParams, setKeyLight, keyLight: () => KEY_POS.slice(),
        setFillLight, fillLight: () => FILL_POS.slice(), setLightLevels, lightLevels,
        addActor, touchShadows, parkChip, dealCard, setElevation, elevation, setChipRound, parkStackPlate, feltFit, feltHas, parkCardBack,
        // Page space <-> felt space, for anything drawing into this scene.
        feltFrame, toFelt, rectToFelt, onFelt,
        epoch: () => (session ? session.epoch : 0),
        isOn: () => !!session, _session: () => session };
})();
