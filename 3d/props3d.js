/*
 * props3d.js — every thrown/sent 3D object, as data plus a handful of shared
 * animations.
 *
 * This replaced 3d/beer3d.js, 3d/flower3d.js and 3d/glove3d.js, which were three
 * copies of the same file with one different function each. Measured before the
 * merge: of ~250 lines apiece, ~130 were identical boilerplate (asset URL, GLB
 * load with timeout, clone-with-cloned-materials, the guard/addActor entry point)
 * and only ~43 were the animation that made the object interesting.
 *
 * So the split here is deliberate:
 *   MOTIONS  — how a thing moves. Shared: several objects use the same one.
 *   CATALOG  — what a thing is. Model file, size, pose, which motion, which
 *              sound, menu glyph, cooldown.
 *
 * Adding an object is a catalog row plus the .glb. No new file, no manifest entry,
 * no pack.sh / deploy.yml / BUILD.md edit — which is the whole point, since those
 * were seven places per object before.
 *
 * Two motion families, both already provided by coin3d:
 *   - "throw" hands the object to coin3d's projectile registry, so it inherits the
 *     chip's ballistic arc, avatar bounce, felt bounces and skid for free.
 *   - the rest are actors (GPE_COIN.addActor): own kinematics, coin3d's layer,
 *     camera and fixed-step clock.
 *
 * Exposes window.GPE_PROPS = { toss, ready, catalog, has, holdRiver, ... }.
 * Loaded after
 * vendor/three.iife.js (THREE incl. GLTFLoader) and coin3d.js.
 */
(function () {
    "use strict";

    // ---------- the catalog: what each object IS ----------
    // height  on-screen size in CSS px, measured against the object's own
    //         projection rather than the model's units (see normalize)
    // motion  a key in MOTIONS below; several objects share one
    // sound   a file under /gpokr2/sound/ that content.js plays on IMPACT, or
    //         omitted for silence. Per object, not per motion: a bone landing
    //         should not clatter like a chip.
    // launchSound  the same, played as the object LEAVES — the throw's two moments
    //         are separately voiced, and either may be omitted.
    const CATALOG = {
        beer: {
            model: "beer.glb", height: 42, tiltDeg: 43, yawDeg: -90,
            motion: "slide", maxLive: 6,
            glyph: "🍺", label: "beer", cooldownMs: 10000, flinch: false,
        },
        flower: {
            model: "flower.glb", height: 96,
            motion: "drift", maxLive: 5,
            glyph: "💐", label: "flower", cooldownMs: 8000, flinch: false,
        },
        glove: {
            model: "glove.glb", height: 82, poseX: -Math.PI / 2,
            motion: "swing", maxLive: 4,
            glyph: "🧤", label: "glove", cooldownMs: 2000,
        },
        // The glove again, as a PAIR that applauds in front of a standing avatar.
        // Deliberately absent from ORDER: it is fired by the "stand up and clap"
        // celebration in content.js, not thrown at a seat, so it must not appear in
        // the throw menu. (syncInteractCatalog walks ORDER, not CATALOG.)
        // height is much larger than the glove's because MOTIONS.clap turns the
        // hands fingertip-on to the camera, and normalize() measures the model
        // UNROTATED — along its length. What you actually see is the hand's
        // width by its thickness, so 100 here renders as ~28x63px: about the
        // size of the 64px avatar it stands in front of.
        clap: {
            model: "glove.glb", height: 100, poseX: -Math.PI / 2,
            motion: "clap", maxLive: 2,
            glyph: "👏", label: "clap", cooldownMs: 8000, flinch: false,
        },
        // The river: the pot pours across the felt to whoever won the last hand,
        // with dollar bills and chips riding it down. Like clap, it is a
        // celebration rather than a throw — content.js fires it and aims it at the
        // WINNER, not at the player who set it off — so it is deliberately absent
        // from ORDER and never appears in the per-seat throw menu.
        //
        // height is one bill's length; the chips alongside come from coin3d at
        // their own size. settleFlat is not about settling here — it is how this
        // model lies (face +Y, length +X), which is what the river reads to float
        // the bills face-up and pointing downstream.
        river: {
            model: "dollar.glb", height: 38,
            motion: "river", maxLive: 2,
            glyph: "🌊", label: "river", cooldownMs: 12000, flinch: false,
            settleFlat: { face: [0, 1, 0], long: [1, 0, 0] },
        },
        // These four share the chip's throw animation outright, and differ only in
        // the model and the sound — which is exactly the split this file exists for.
        // height here is the bounding-SPHERE diameter (see normalize), so one number
        // means the same apparent size for every one of them, whatever their shape.
        // The chip they fly alongside is 26px across, for reference.
        acorn:  { model: "acorn.glb",  height: 58, motion: "throw", maxLive: 8, glyph: "🌰", label: "acorn",  cooldownMs: 2000, sound: "check", launchSound: "fold" },
        peanut: { model: "peanut.glb", height: 58, motion: "throw", maxLive: 8, glyph: "🥜", label: "peanut", cooldownMs: 2000, sound: "check", launchSound: "fold" },
        // The cashew is the one that needed a resting pose spelled out. It is
        // authored lying down — 88 long, 79 across the curve, 21 thin — so the
        // default settle, which only spins an object in the screen plane, left it
        // edge-on: a 21-unit sliver, the one item you could not tell had landed.
        cashew: {
            model: "cashew.glb", height: 58, motion: "throw", maxLive: 8,
            glyph: "🥜", label: "cashew", cooldownMs: 2000, sound: "check", launchSound: "fold",
            settleFlat: { face: [0, 1, 0], long: [1, 0, 0] },
        },
        bone:   { model: "bone.glb",   height: 58, motion: "throw", maxLive: 8, glyph: "🦴", label: "bone",   cooldownMs: 2000, sound: "check", launchSound: "fold" },
        // A life ring, lobbed over a player who is going down with the ship. No
        // pose keys on purpose: MOTIONS.ring builds its own three-group rig so it
        // can drive the lean, the roll and the spin about the ring's own axis
        // separately, and a pose baked in here would be one more rotation for
        // those to fight over. Unposed the model measures 252 across by 52 thick,
        // so `height` scales its OUTER WIDTH (normalize's non-sphere branch takes
        // max(x, y) of the projected box): 96px around a 64px avatar leaves a
        // ~57px hole for the face and ~16px of ring standing out either side of
        // the portrait, which is what makes it read as worn rather than dropped
        // on. Measured at 95 x 81.5 on screen once it settles.
        //
        // The shipped model is the ring ALONE. The export also has a rope loop
        // (Rectangle_sweep) out at radius 142 against the ring's 126, which drew
        // as a thin square outline around it and, being the widest thing in the
        // file, took 12% off the ring body for any given `height`. It is dropped
        // on the way in — see tools/drop-node.js, which records the two commands
        // — and the raw export in assets-src/ still has it, so it can come back.
        float: {
            model: "float.glb", height: 96,
            motion: "ring", maxLive: 3,
            // 🛟 is Emoji 14 (2021) — the newest glyph in the menu by a decade.
            // It is the only one that IS a life ring, so it is worth the vintage,
            // but anyone still on Windows 10 gets tofu where the rest get a
            // picture. ⛑ (Emoji 1.0) is the fallback if that ever matters.
            glyph: "🛟", label: "life ring", cooldownMs: 6000,
            sound: "check", launchSound: "fold",
        },
    };
    const ORDER = ["beer", "flower", "glove", "acorn", "peanut", "cashew", "bone", "float"];

    const MODEL_DIR = "assets/models/";
    const LOAD_TIMEOUT_MS = 8000;

    // ---------- shared helpers ----------
    // Same resolution content.js and the other renderers use: as an extension there
    // is no currentScript and assets hang off the extension root; in the site build
    // we are a plain script under <base>/3d/, one level below the assets.
    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function assetUrl(path) {
        if (SELF_SRC) {
            try { return new URL("../" + path, SELF_SRC).href; } catch (e) { /* fall through */ }
        }
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const easeInQuad = (t) => t * t;
    const centreOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

    function setAlpha(mesh, alpha) {
        mesh.traverse((n) => {
            const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
            for (const m of mats) {
                const base = (m.userData && typeof m.userData.gpeBaseOpacity === "number") ? m.userData.gpeBaseOpacity : 1;
                m.opacity = base * alpha;
            }
        });
    }

    const warned = Object.create(null);
    function warnOnce(key, why) {
        if (warned[key]) return false;
        warned[key] = true;
        console.warn("[gpe] props3d: " + key + " unavailable — " + why);
        return false;
    }

    // ---------- models ----------
    const templates = Object.create(null);   // key -> normalized Object3D
    const loading = Object.create(null);     // key -> Promise<boolean>
    const broken = Object.create(null);

    // Centre it, apply the object's pose, then scale so its ON-SCREEN projection is
    // `height` px. Scaling by the model's own height would be wrong for anything
    // posed or tilted: the tilt foreshortens it, and the models arrive in arbitrary
    // units (obj2gltf output with per-node scales).
    function normalize(T, scene, spec) {
        const box = new T.Box3().setFromObject(scene);
        scene.position.sub(box.getCenter(new T.Vector3()));

        let node = scene;
        // Optional: stand the model's longest axis up (auto), pitch it, yaw it, tilt
        // it back toward the viewer. Each is its own wrapper so they compose without
        // fighting over one object's rotation.
        if (spec.standUp) {
            const size = box.getSize(new T.Vector3());
            const axes = [size.x, size.y, size.z];
            const up = axes.indexOf(Math.max.apply(null, axes));
            const stand = new T.Group();
            stand.add(node);
            if (up === 0) stand.rotation.z = Math.PI / 2;
            else if (up === 2) stand.rotation.x = -Math.PI / 2;
            node = stand;
        }
        if (spec.poseX != null) {
            const posed = new T.Group();
            posed.add(node);
            posed.rotation.x = spec.poseX;
            node = posed;
        }
        if (spec.yawDeg != null) {
            const yawed = new T.Group();
            yawed.add(node);
            yawed.rotation.y = spec.yawDeg * Math.PI / 180;
            node = yawed;
        }
        if (spec.tiltDeg != null) {
            const tilted = new T.Group();
            tilted.add(node);
            tilted.rotation.x = spec.tiltDeg * Math.PI / 180;
            node = tilted;
        }

        const outer = new T.Group();
        outer.add(node);
        outer.updateMatrixWorld(true);
        const shown = new T.Box3().setFromObject(outer).getSize(new T.Vector3());

        // Which dimension "height" refers to depends on whether the object tumbles.
        //
        // For something that holds its pose — the beer sliding upright, the flower
        // drifting, the glove swinging in-plane — the on-screen box is what you see,
        // so scale by its longest visible side.
        //
        // A tumbling object is different: as it spins, its DEPTH rotates into view.
        // Scaling those by the flat box makes apparent size depend on the model's
        // proportions, which is why the cashew (87.9 long but 79.7 deep) ballooned
        // in flight while the peanut (3.4 long, 1.4 deep) stayed tiny at the same
        // nominal size. The bounding sphere is the invariant there: it is the
        // object's maximum extent at ANY rotation, so "height" means the same thing
        // for every model regardless of shape.
        const bySphere = (MOTIONS[spec.motion] || {}).sizeBySphere;
        const measure = bySphere
            ? Math.hypot(shown.x, shown.y, shown.z)
            : Math.max(shown.x, shown.y);
        outer.scale.setScalar((spec.height || 40) / (measure || 1));
        outer.userData.gpeBaseScale = outer.scale.x;
        return outer;
    }

    // Load once per object, then hand out clones. Resolves false rather than
    // throwing: a missing model must degrade to "this item does nothing", never to
    // a broken sequence — content.js awaits this before playing a step.
    function ready(key) {
        const spec = CATALOG[key];
        if (!spec) return Promise.resolve(false);
        if (templates[key]) return Promise.resolve(true);
        if (broken[key]) return Promise.resolve(false);
        if (loading[key]) return loading[key];

        const T = window.THREE;
        const url = assetUrl(MODEL_DIR + spec.model);
        if (!T || !T.GLTFLoader || !url) {
            broken[key] = true;
            // Name the failed precondition. A bare false here once cost an
            // afternoon: the item silently did nothing, with no way to tell a
            // three.js bundle without GLTFLoader (it is an addon, absent from a
            // bundle built from the plain `export * from "three"` entry) from an
            // asset URL that would not resolve.
            warnOnce(key, !T ? "THREE is not loaded"
                : !T.GLTFLoader ? "this three.js bundle has no GLTFLoader (see vendor/README.md)"
                    : "could not resolve a URL for " + MODEL_DIR + spec.model);
            return Promise.resolve(false);
        }

        loading[key] = new Promise((resolve) => {
            // A deadline, because "never settles" is the worst failure mode here:
            // GLTFLoader is not guaranteed to call back at all (a request blocked
            // rather than failed produces neither onLoad nor onError) and whoever
            // awaits this would wait forever.
            const deadline = setTimeout(() => {
                if (templates[key]) return;
                loading[key] = null;   // self-healing: a later throw retries
                console.warn("[gpe] props3d: timed out loading " + spec.model
                    + " (no response in " + LOAD_TIMEOUT_MS + "ms)");
                resolve(false);
            }, LOAD_TIMEOUT_MS);

            new T.GLTFLoader().load(url, (gltf) => {
                clearTimeout(deadline);
                try {
                    templates[key] = normalize(T, gltf.scene, spec);
                    if (MOTIONS[spec.motion] && MOTIONS[spec.motion].onTemplate) {
                        MOTIONS[spec.motion].onTemplate(T, key, spec);
                    }
                    resolve(true);
                } catch (e) {
                    broken[key] = true;
                    console.warn("[gpe] props3d: could not prepare " + spec.model, e);
                    resolve(false);
                }
            }, null, (err) => {
                clearTimeout(deadline);
                broken[key] = true;
                console.warn("[gpe] props3d: could not load " + spec.model, err);
                resolve(false);
            });
        });
        return loading[key];
    }

    // A fresh clone per throw, with cloned materials: each object fades on its own,
    // Object3D.clone() shares materials by default, and disposing a clone's
    // materials would otherwise take the template's with them. The authored opacity
    // is recorded where the fade can find it, so genuinely translucent parts (the
    // beer's glass) stay translucent.
    function instance(T, key) {
        const template = templates[key];
        if (!template) return null;
        const copy = template.clone(true);
        copy.traverse((n) => {
            if (!n.material) return;
            const mats = Array.isArray(n.material) ? n.material : [n.material];
            const cloned = mats.map((m) => {
                const c = m.clone();
                c.userData = Object.assign({}, c.userData, {
                    gpeBaseOpacity: typeof m.opacity === "number" ? m.opacity : 1,
                });
                c.transparent = true;
                c.depthWrite = c.userData.gpeBaseOpacity >= 1;
                return c;
            });
            n.material = Array.isArray(n.material) ? cloned : cloned[0];
        });
        copy.userData.gpeBaseScale = template.userData.gpeBaseScale;
        return copy;
    }
    // ---------- ground textures ----------
    // Drawn, not sampled: nothing in this extension ships a texture image, and
    // table3d already builds its felt maps this way (see feltColorTexture there).
    // Generated once and cached — a river is built per throw and these are not.
    //
    // Worth knowing what they can and cannot do here. The bands they land on are
    // about 25px (grass) and 21px (stone) on screen, so a tile is minified hard
    // and most of the fine detail averages away. What survives minification is
    // the LOW-frequency structure — the clumping of the blades, the size of the
    // stones — so both of these are built to have that, rather than being fine
    // grain that turns into mush. The old value-noise mottle had no structure at
    // all, which is why it read as dirt.
    const TEX = 192;            // px per tile, both textures

    // A tile is a fixed size on the felt again. This was briefly derived from
    // devicePixelRatio to hold texels-per-device-pixel constant, which did make
    // the mip level the same everywhere — but it did so by making a cobble two to
    // three times bigger on a low-ratio display, which looked worse than the
    // problem it solved. Storing the textures linear (see finishTex) fixes the
    // brightness at its source instead, so the world size can go back to being
    // one number.
    const TEX_TILE = 34;        // world px one tile covers, so it repeats visibly

    let grassTex = null, stoneTex = null;

    function texCanvas() {
        const cv = document.createElement("canvas");
        cv.width = cv.height = TEX;
        return cv;
    }
    // Explicitly sRGB, never the display's space. A canvas defaults to the
    // browser's idea of the right colour space for where the window happens to
    // be, which is a per-monitor answer — see finishTex for why that mattered.
    function texCtx(cv) {
        try { return cv.getContext("2d", { colorSpace: "srgb" }); }
        catch (e) { return cv.getContext("2d"); }
    }
    // sRGB -> linear, one entry per byte. Built once; the conversion runs over
    // every pixel of both textures and pow() per channel is not worth it.
    const LIN = (() => {
        const t = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            const c = i / 255;
            const l = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            t[i] = Math.round(l * 255);
        }
        return t;
    })();

    function finishTex(T, cv) {
        // The textures go to the GPU as RAW BYTES, not as a canvas, and they are
        // stored linear. Both halves of that matter, for different reasons.
        //
        // Raw bytes, because a CanvasTexture is COLOUR-MANAGED on upload. A canvas
        // carries a colour space, the browser converts it to the compositor's on
        // the way to the GPU, and that conversion depends on which monitor the
        // window is on. Two Chrome windows on one machine, one per display, gave
        // measurably different textures from identical code: everything computed
        // in the shader agreed to under 1% (dash peak 189.0 in both, water 46.7
        // against 46.4) while the textured surfaces did not, and the saturated
        // green grass lost 41% where the neutral grey stone lost only 23% —
        // saturated colours being hit harder than neutral ones is what a gamut
        // conversion does. A DataTexture is bytes; there is nothing to convert.
        //
        // Linear, because the GPU builds mipmaps by averaging the stored bytes,
        // and averaging sRGB-ENCODED values is not averaging light — it comes out
        // darker, and darker again at each level down. Converting first and
        // telling three the data is already linear means it averages light, which
        // is correct, and the mip level stops changing the apparent brightness. At
        // full resolution it is a no-op, so it costs nothing where the texture is
        // magnified.
        const ctx = texCtx(cv);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const d = img.data;
        let mean = 0;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = LIN[d[i]]; d[i + 1] = LIN[d[i + 1]]; d[i + 2] = LIN[d[i + 2]];
            mean += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        }
        const tex = new T.DataTexture(new Uint8Array(d), cv.width, cv.height);
        // DataTexture defaults are not CanvasTexture's: no mipmaps and a nearest
        // filter, either of which would make this look nothing like it did.
        tex.generateMipmaps = true;
        tex.minFilter = T.LinearMipmapLinearFilter;
        tex.magFilter = T.LinearFilter;
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.colorSpace = T.LinearSRGBColorSpace;   // converted above, not painted
        tex.anisotropy = 4;                        // seen at a glancing angle
        tex.needsUpdate = true;
        tex._gpeMean = Math.round(mean / Math.max(1, d.length / 4));
        return tex;
    }

    // TEMPORARY. One line, printed when a river is built, so the same numbers can
    // be read off two browsers instead of inferred from screenshots of them.
    // Remove once the two agree.
    //
    // Off for release builds: this logs on every river and readbackDiag() below
    // pulls the framebuffer back to do it, neither of which belongs in a player's
    // console. Flip it to true to compare two browsers again.
    const RIVER_DIAG = false;
    function riverDiag(T, mask, f, grass, stone) {
        if (!RIVER_DIAG) return;
        try {
            const gl = document.createElement("canvas").getContext("webgl2")
                || document.createElement("canvas").getContext("webgl");
            let gpu = "?", aniso = "?";
            if (gl) {
                const di = gl.getExtension("WEBGL_debug_renderer_info");
                if (di) gpu = gl.getParameter(di.UNMASKED_RENDERER_WEBGL);
                const ae = gl.getExtension("EXT_texture_filter_anisotropic");
                if (ae) aniso = gl.getParameter(ae.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            }
            console.log("[GPE-RIVER]",
                "dpr", window.devicePixelRatio,
                "| tile", TEX_TILE, "texPx", TEX,
                "| texMean grass", grass && grass._gpeMean, "stone", stone && stone._gpeMean,
                "| aniso max", aniso, "applied", grass && grass.anisotropy,
                "| maskR", mask && mask.radius,
                "| felt", f && Math.round(f.ax) + "x" + Math.round(f.by),
                "at", f && Math.round(f.cx) + "," + Math.round(f.cy),
                "| scrollY", Math.round(window.scrollY),
                "| maskRect", (window.GPE_TABLE3D && GPE_TABLE3D.feltMaskParams
                    && GPE_TABLE3D.feltMaskParams()
                    ? JSON.stringify(GPE_TABLE3D.feltMaskParams().rect.map(Math.round))
                    : "none"),
                "| gpu", gpu);
        } catch (e) { console.log("[GPE-RIVER] diag failed", e && e.message); }
        readbackDiag();
    }

    // TEMPORARY, and the point of it is to stop comparing screenshots. Reads the
    // pixels the GPU actually produced and prints the means, so two browsers can
    // report the same numbers about themselves instead of me measuring photographs
    // of them. Remove with riverDiag.
    function readbackDiag() {
        let tries = 0;
        const attempt = () => {
            tries++;
            let done = false;
            for (const cv of document.querySelectorAll("canvas")) {
                if (cv.width < 400) continue;
                const gl = cv.getContext("webgl2") || cv.getContext("webgl");
                if (!gl) continue;
                const w = cv.width, h = cv.height;
                const px = new Uint8Array(w * h * 4);
                try { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); }
                catch (e) { continue; }
                const acc = {};
                let lit = 0;
                for (let i = 0; i < px.length; i += 4) {
                    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
                    if (a < 8) continue;
                    lit++;
                    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                    let k = null;
                    if (r > 20 && g < 4 && b < 4) k = "DEBUGr";
                    else if (b > 150 && b > r * 1.35 && b > g * 1.1 && g > r) k = "dash";
                    else if (g > 35 && g > r * 1.25 && g > b * 1.25) k = "grass";
                    else if (b > 45 && b > r * 1.2 && b > g * 1.05) k = "water";
                    else if (mx > 70 && mx - mn < 34) k = "stone";
                    if (!k) continue;
                    const e2 = acc[k] || (acc[k] = [0, 0, 0, 0]);
                    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    e2[0]++; e2[1] += L; if (L > e2[2]) e2[2] = L; e2[3] += a;
                }
                if (!lit) continue;
                // Only the canvas with the river on it counts. The table's own
                // canvas reads fine and is not what is being asked about, and
                // treating it as an answer stopped the retries before the river
                // had been drawn at all.
                const big = (k2) => acc[k2] && acc[k2][0] > 2000;
                if (!big("grass") && !big("water") && !big("DEBUGr")) continue;
                // Alpha matters: the canvas is composited over the page and the
                // context is premultiplied, so readPixels hands back colour ALREADY
                // scaled by alpha. A surface at 0.6 alpha reads as 0.6x the colour
                // and is indistinguishable from a dimmer surface unless alpha is
                // reported next to it.
                const fmt = (k) => acc[k]
                    ? k + " " + (acc[k][1] / acc[k][0]).toFixed(1) + "/pk" + acc[k][2].toFixed(0)
                        + "/a" + (acc[k][3] / acc[k][0]).toFixed(0)
                    : k + " -";
                console.log("[GPE-PIXELS]", w + "x" + h, "scroll", Math.round(window.scrollY),
                    "vh", window.innerHeight,
                    "|", fmt("dash"), "|", fmt("water"),
                    "|", fmt("grass"), "|", fmt("stone"), "|", fmt("DEBUGr"));
                done = true;
            }
            if (!done && tries < 90) requestAnimationFrame(attempt);
            else if (!done) console.log("[GPE-PIXELS] no readable canvas");
        };
        requestAnimationFrame(attempt);
    }

    // Grass: individual blades, thousands of them. A blade is a short tapered
    // stroke leaning off vertical, and they are drawn in two passes — a darker
    // undergrowth first, then a lighter layer on top — which is what gives the
    // clumped, layered look that survives being shrunk. Blades that cross a tile
    // edge are drawn again on the far side, so the tile is seamless.
    function makeGrassTexture(T) {
        if (grassTex) return grassTex;
        const cv = texCanvas(), ctx = texCtx(cv);
        // The ground under the blades, and it is deliberately close to the colour
        // the grass is meant to be rather than the near-black soil it used to be.
        //
        // This is the fix for the same river reading bright and three-dimensional
        // in one browser and dark and flat in another ON THE SAME MACHINE. All the
        // brightness used to live in thin bright strokes over a near-black ground,
        // so any renderer that filtered the blades away — a coarser mip, less
        // anisotropy, whatever the two Chromes were doing differently — collapsed
        // the grass to the ground colour. Measured across the two: the untextured
        // surfaces were identical (dash peak 189.0 in both, water 46.7 vs 46.3),
        // the grass was 54.3 against 34.0, and #1b2a14 has a luma of 37.2. It was
        // landing on the soil almost exactly.
        //
        // With the ground at roughly the intended grass tone the blades supply
        // VARIATION around a correct mean instead of supplying the brightness, so
        // losing them costs detail rather than turning the felt into a dark
        // rectangle. The stone never had this problem because its base was already
        // mid-grey — it lost 17% where the grass lost 37%.
        ctx.fillStyle = "#26401c";
        ctx.fillRect(0, 0, TEX, TEX);
        ctx.lineCap = "round";
        const blade = (x, y, len, ang, wid, col) => {
            ctx.strokeStyle = col;
            ctx.lineWidth = wid;
            ctx.beginPath();
            ctx.moveTo(x, y);
            // A slight bend, so they are not straight bristles.
            ctx.quadraticCurveTo(x + Math.sin(ang) * len * 0.5, y - len * 0.5,
                x + Math.sin(ang) * len, y - len);
            ctx.stroke();
        };
        for (const pass of [{ n: 2600, lo: 0.20, hi: 0.34, len: [7, 15] },
            { n: 1700, lo: 0.34, hi: 0.62, len: [5, 11] }]) {
            for (let i = 0; i < pass.n; i++) {
                const x = Math.random() * TEX, y = Math.random() * TEX;
                const len = pass.len[0] + Math.random() * (pass.len[1] - pass.len[0]);
                const ang = (Math.random() - 0.5) * 1.5;
                const wid = 0.7 + Math.random() * 0.9;
                // Hue wanders a little either side of green; value carries the pass.
                const v = pass.lo + Math.random() * (pass.hi - pass.lo);
                const hue = 88 + Math.random() * 26;
                const col = "hsl(" + hue.toFixed(0) + "," + (38 + Math.random() * 26).toFixed(0)
                    + "%," + (v * 100).toFixed(0) + "%)";
                blade(x, y, len, ang, wid, col);
                // Seamless: repeat anything that reaches past an edge.
                const reach = len + 2;
                if (x < reach) blade(x + TEX, y, len, ang, wid, col);
                if (x > TEX - reach) blade(x - TEX, y, len, ang, wid, col);
                if (y < reach) blade(x, y + TEX, len, ang, wid, col);
                if (y > TEX - reach) blade(x, y - TEX, len, ang, wid, col);
            }
        }
        grassTex = finishTex(T, cv);
        return grassTex;
    }

    // Stone: a jittered-grid Voronoi, which is what gives it stones of a definite
    // SIZE rather than undifferentiated noise — the thing that reads at 21px. Each
    // cell takes its own grey, and the gap between the nearest and second-nearest
    // seed darkens the crevice between cells. The jittered grid also makes it tile
    // for free: seeds are indexed by cell, and the cell index wraps.
    function makeStoneTexture(T) {
        if (stoneTex) return stoneTex;
        const CELLS = 7, CS = TEX / CELLS;
        const seed = [], tone = [];
        for (let j = 0; j < CELLS; j++) {
            for (let i = 0; i < CELLS; i++) {
                seed.push([(i + 0.15 + Math.random() * 0.7) * CS,
                    (j + 0.15 + Math.random() * 0.7) * CS]);
                tone.push(0.62 + Math.random() * 0.30);
            }
        }
        const cv = texCanvas(), ctx = texCtx(cv);
        const img = ctx.createImageData(TEX, TEX);
        const wrap = (n) => ((n % CELLS) + CELLS) % CELLS;
        for (let y = 0; y < TEX; y++) {
            for (let x = 0; x < TEX; x++) {
                const ci = Math.floor(x / CS), cj = Math.floor(y / CS);
                let d1 = 1e9, d2 = 1e9, hit = 0;
                // Own cell plus the eight around it is enough: no seed outside
                // that ring can be the nearest.
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        const k = wrap(cj + dj) * CELLS + wrap(ci + di);
                        const sx = seed[k][0] + (ci + di - wrap(ci + di)) * CS;
                        const sy = seed[k][1] + (cj + dj - wrap(cj + dj)) * CS;
                        const d = Math.hypot(x - sx, y - sy);
                        if (d < d1) { d2 = d1; d1 = d; hit = k; }
                        else if (d < d2) { d2 = d;
                        }
                    }
                }
                // Crevice: dark where two cells meet, and a touch of grain so a
                // face is not perfectly flat.
                const gap = Math.min(1, (d2 - d1) / (CS * 0.30));
                // The crevice bottoms out at 0.62 of the face, not 0.34. Darker
                // than this and the gaps between cobbles read as black lines
                // drawn on the stone rather than as shadow between stones.
                const shade = tone[hit] * (0.62 + 0.38 * gap * gap)
                    * (0.94 + Math.random() * 0.12);
                const v = Math.max(0, Math.min(255, Math.round(shade * 255)));
                const o = (y * TEX + x) * 4;
                // Faintly cool, the way wet stone is.
                img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = Math.min(255, v + 6);
                img.data[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        stoneTex = finishTex(T, cv);
        return stoneTex;
    }

    // ---------- the river's landscape ----------
    // Everything here is geometry and per-vertex color, and every band of it is
    // ONE flat color: no textures, no noise, no blends. The shading you see is
    // the key light on flat facets (the materials are flatShading), which is what
    // a low-poly landform is made of.
    //
    // The shape is the reference photo's: a strip of ground raised off the felt
    // with a channel cut down the middle of it. Across the strip that is, from
    // the outside in — an apron that lifts out of the cloth and fades in as it
    // goes, a grass crest, an inner slope down to the waterline, and a bed. The
    // water is its own surface sitting in the channel.
    //
    // The water used to be the moving part: a two-train swell displacing the
    // surface, with foam blended onto the crests and a darker trough. At this
    // size that read as busy rather than as wet — a churn of light and dark
    // competing with the cards, which are the thing being celebrated. It is a
    // flat blue sheet now, and the motion is carried by riverDashes() instead.
    const hash2 = (x, y) => {
        const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        return s - Math.floor(s);
    };

    // One lattice over the felt-clipped strip: `rows` are the lateral offsets to
    // put lanes at, and `at(x, y, t)` returns [height, r, g, b, a] for a point.
    //
    // `span(y, h)` is asked how far a lane of that height may run, and answers in
    // the lane's own coordinates. It no longer trims to anything — the strip is
    // built past the rail at both ends and the felt mask decides what shows — but
    // it still has to account for the LEAN, since a lane sitting 22px high is
    // drawn 14px up-screen of where it was measured.
    function riverLattice(T, rows, len, span, M, place, at) {
        const NU = 44, cols = NU + 1, n = rows.length * cols;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 4);
        const uv = new Float32Array(n * 2);
        const vx = new Float32Array(n), vy = new Float32Array(n);
        // Read once per lattice rather than per vertex: it is a device-pixel-ratio
        // lookup, and every vertex of a river has to agree on it or the two banks
        // stop matching.
        const tile = TEX_TILE;
        let k = 0;
        for (let j = 0; j < rows.length; j++) {
            const y = rows[j];
            const s = span(y, at(0, y, 0)[0]);
            if (!s || s.x1 - s.x0 < 2) return null;
            const run = s.x1 - s.x0;
            for (let i = 0; i < cols; i++) {
                vx[k] = s.x0 + run * (i / NU); vy[k] = y;
                // UVs in WORLD px over a tile, not 0..1 over the surface: the strip
                // is hundreds of px long and a couple of dozen across, so stretching
                // one tile over it would smear the texture beyond recognition. This
                // way a tile is `tile` px on the felt wherever it lands, and the
                // texture repeats — which also means the two banks match.
                uv[k * 2] = vx[k] / tile;
                uv[k * 2 + 1] = y / tile;
                k++;
            }
        }
        const idx = [];
        for (let j = 0; j < rows.length - 1; j++) {
            for (let i = 0; i < NU; i++) {
                const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
                idx.push(a, b, c, b, d, c);   // wound to face the camera (+z)
            }
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute("position", new T.BufferAttribute(pos, 3));
        geo.setAttribute("color", new T.BufferAttribute(col, 4));   // RGBA: the rim needs alpha
        geo.setAttribute("uv", new T.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        const P = geo.attributes.position, C = geo.attributes.color;
        const shade = (t) => {
            for (let i = 0; i < n; i++) {
                const v = at(vx[i], vy[i], t);
                place(vx[i], vy[i], v[0], P.array, i * 3);
                C.array[i * 4] = v[1]; C.array[i * 4 + 1] = v[2];
                C.array[i * 4 + 2] = v[3]; C.array[i * 4 + 3] = v[4];
            }
            P.needsUpdate = true; C.needsUpdate = true;
            geo.computeVertexNormals();
        };
        shade(0);
        return { geo: geo, shade: shade };
    }

    // The two halves of the landscape, over the same clipped channel.
    //
    // The ground is built once and never touched again — it has no business
    // moving. Only the water is reshaded per frame, which is also why the crests
    // can carry their own foam: brightening the color where the surface stands
    // high costs nothing once the height is already being computed there, and it
    // gives the white of breaking water without a streak texture to tile.
    // The felt mask: a visibility mask in the exact shape of the playing surface
    // inside the rails, applied to every fragment the river draws.
    //
    // The shape is a STADIUM, not an ellipse — table3d builds the felt as
    // stadium(halfW, halfD): a rectangle with a semicircular cap at each end
    // (see roundedRect/stadium there). coin3d's feltBounds reports it as {ax, by}
    // and this used to test it as an ellipse, which is strictly inside the real
    // surface everywhere except four points — so "clip to the felt" was wrong by
    // up to halfD along the straight sides no matter how it was applied.
    //
    // Being analytic, the test is exact at any resolution: the inside of a stadium
    // is "within r of the centre segment", which is a clamp and a dot product. A
    // stencil pass would draw the same shape into a buffer and test against that,
    // costing an extra pass and a renderer-wide stencil buffer (three r185
    // defaults it off) to arrive at the same answer, rasterized rather than exact.
    //
    // Cheap only because of coin3d's camera: orthographic, looking straight down
    // z, with left/right/top/bottom set to the viewport in CSS px. A vertex's
    // world xy IS its position on screen (y negated), so the mask can be tested
    // in world space with no projection at all.
    function feltMask(T, f) {
        // The exact footprint if the 3D table is rendering: the test happens on
        // the felt's own ground plane, where the felt really is a stadium. See
        // GPE_TABLE3D.feltMaskParams for why a screen-space stadium cannot match
        // the rail under a perspective camera.
        const P = (window.GPE_TABLE3D && GPE_TABLE3D.feltMaskParams)
            ? GPE_TABLE3D.feltMaskParams() : null;
        if (!P && !f) return null;

        // One object per uniform, shared by every material the mask is applied to.
        const uR = { value: P ? P.radius : Math.min(f.by, f.ax) };
        const uX = { value: P ? P.halfRun : Math.max(0, f.ax - Math.min(f.by, f.ax)) };
        const uInv = { value: P ? P.inv : null };
        const uRect = { value: P ? new T.Vector4(P.rect[0], P.rect[1], P.rect[2], P.rect[3]) : null };
        // Fallback only: the site's own flat felt, where there is no camera to
        // invert and a screen-space stadium is the best available.
        const uC = { value: f ? new T.Vector2(f.cx, -f.cy) : new T.Vector2() };

        const decl = P
            ? "uniform mat3 gpeInv;\nuniform vec4 gpeRect;\nuniform float gpeMaskX;\nuniform float gpeMaskR;\n"
            : "uniform vec2 gpeMaskC;\nuniform float gpeMaskX;\nuniform float gpeMaskR;\n";
        // Nothing but the mask reads this any more. It used to also feed the lamp,
        // which is why it was kept unclamped in its own variable; the lamp now
        // works in screen space instead, for the reason written up below it.
        const test = P
            // Screen -> NDC -> the felt's ground plane, then a stadium test there.
            // vGpeXY is world, and world y is page y negated.
            ? "\tvec2 gpeNdc = vec2((vGpeXY.x - gpeRect.x) / gpeRect.z * 2.0 - 1.0,\n"
              + "\t                 1.0 - ((-vGpeXY.y) - gpeRect.y) / gpeRect.w * 2.0);\n"
              + "\tvec3 gpeG = gpeInv * vec3(gpeNdc, 1.0);\n"
              + "\tvec2 gpeP = gpeG.xy / gpeG.z;\n"
              + "\tgpeP.x -= clamp(gpeP.x, -gpeMaskX, gpeMaskX);\n"
              + "\tif (dot(gpeP, gpeP) > gpeMaskR * gpeMaskR) discard;"
            : "\tvec2 gpeP = vGpeXY - gpeMaskC;\n"
              + "\tgpeP.x -= clamp(gpeP.x, -gpeMaskX, gpeMaskX);\n"
              + "\tif (dot(gpeP, gpeP) > gpeMaskR * gpeMaskR) discard;";

        // The pool of light over the middle of the table.
        //
        // This was a real PointLight, and on one machine it worked: measured, its
        // own contribution ran +42 luma over the felt centre against +8 at the
        // rail. On another machine running the same build it did not show up at
        // all, and a highlight I cannot get onto the user's screen is not a
        // feature. So it is computed here instead, from the one thing that cannot
        // vary between two browsers running this code: the fragment's own position
        // on the felt, which the mask has already worked out three lines up.
        //
        // Worth having at all because coin3d lights the scene with an ambient and
        // two directionals, and the grass is one big flat plane — under lights with
        // no falloff that is exactly ONE tone however it is textured, which reads
        // as a painted rectangle rather than ground.
        //
        // Inverse-square, from a lamp H felt-radii above the centre, so it falls
        // off the way a real one would. H is in units of the felt's own radius, so
        // the pool covers the same fraction of the table at any table size. FLOOR
        // and GAIN map it to a multiplier that averages about 1, keeping the
        // overall brightness where it already was.
        // H is the lamp's height in felt radii — bigger is a broader, gentler pool.
        // GAIN is how much the centre gains. It only ever ADDS: the multiplier is
        // 1.0 at the far end of the table and rises toward the middle, never below.
        //
        // It used to run 0.52 at the ends up to 1.18 at the centre, which dimmed
        // most of the felt to brighten a little of it. That is fine when the
        // texture underneath is bright and actively bad when it is not — on a
        // display where the grass already came out dark it made it darker, which
        // is exactly what "I just don't have lighting" looked like. A light that
        // can only add cannot do that on any machine.
        // H is the lamp's height in felt half-axes — bigger is a broader, gentler
        // pool. GAIN is what the centre gains. It only ever ADDS: the multiplier is
        // 1.0 at the rail and rises toward the middle, never below.
        // GAIN is large because the surfaces under it are dark. The contour-ring
        // test confirmed the coordinate is exactly right — four rings from the
        // felt centre to the rail, elliptical, matching the felt's own aspect —
        // so the pool was landing in the right place and simply was not worth
        // enough to see. At 0.75 the centre reached 1.46x, which on grass sitting
        // near luma 34 is a lift of about 15 — real, and invisible.
        const LAMP = { H: 0.80, GAIN: 1.80 };
        const lampH2 = LAMP.H * LAMP.H;
        const lampBase = lampH2 / (lampH2 + 1.0);   // so the rail lands on exactly 1.0

        // The lamp is measured in SCREEN space, from the felt's own centre and
        // half-axes, and deliberately NOT through the camera's inverse projection
        // the way the mask above is.
        //
        // It used to share the mask's coordinate, which seemed tidy — same maths,
        // one less thing. But the mask's coordinate comes from an inverse
        // homography via NDC, and that turned out to depend on browser ZOOM: at
        // 150% the pool was there and at 175% it vanished, on one machine, from
        // the same build. Everything computed straight in the shader agreed
        // between the two (dash peak 189.0 in both, water 46.3 against 46.4) while
        // everything downstream of that inverse did not.
        //
        // The mask genuinely needs the exact projection, because it has to land on
        // the rail to the pixel. A soft radial gradient does not need it at all.
        // vGpeXY is coin3d world, which is CSS px with y negated, and the felt
        // centre and half-axes are CSS px too — all of it zoom-independent by
        // definition, since CSS px are what layout is expressed in. Normalising by
        // the half-axes also makes the falloff elliptical like the felt, so the
        // rail sits at r = 1.0 the whole way round instead of only across the
        // short axis.
        const lampOK = !!f;
        const uLampC = { value: f ? new T.Vector2(f.cx, -f.cy) : new T.Vector2() };
        const uLampR = { value: f ? new T.Vector2(Math.max(1, f.ax), Math.max(1, f.by)) : new T.Vector2(1, 1) };
        const lampDecl = "uniform vec2 gpeLampC;\nuniform vec2 gpeLampR;\n";
        // TEMPORARY DEBUG: paint length(gpeL) instead of shading with it, so the
        // readback reports what the lamp coordinate actually is. Over the felt it
        // should run 0 at the centre to ~1 at the rail, i.e. red 0 -> 255.
        const LAMP_DEBUG = false;
        const lamp = LAMP_DEBUG
            ? "\tvec2 gpeL = (vGpeXY - gpeLampC) / gpeLampR;\n"
              // Rings every 0.25 of a felt half-axis. Counting them from the centre
              // to the rail says exactly what the scale is: four rings means right.
              + "\tfloat gpeDbg = mod(length(gpeL) * 4.0, 1.0);\n"
              + "\tdiffuseColor.rgb = vec3(gpeDbg < 0.5 ? 1.0 : 0.05, 0.0, 0.0);"
            : "\tvec2 gpeL = (vGpeXY - gpeLampC) / gpeLampR;\n"
              + "\tfloat gpeLr2 = dot(gpeL, gpeL);\n"
              + "\tdiffuseColor.rgb *= 1.0 + " + LAMP.GAIN.toFixed(3) + " * max(0.0, "
              + lampH2.toFixed(4) + " / (" + lampH2.toFixed(4) + " + gpeLr2) - "
              + lampBase.toFixed(4) + ");";

        return {
            radius: uR.value,
            // opts.lamp === false leaves a material masked but unlit by the pool.
            // The dashes and the cargo riding the river opt out: they are marks and
            // objects, not ground, and dimming them toward the rail would read as
            // them fading out rather than as the table being lit.
            apply(mat, opts) {
                const lit = !opts || opts.lamp !== false;
                mat.onBeforeCompile = (shader) => {
                    shader.uniforms.gpeMaskX = uX;
                    shader.uniforms.gpeMaskR = uR;
                    if (lit && lampOK) {
                        shader.uniforms.gpeLampC = uLampC;
                        shader.uniforms.gpeLampR = uLampR;
                    }
                    if (P) { shader.uniforms.gpeInv = uInv; shader.uniforms.gpeRect = uRect; }
                    else { shader.uniforms.gpeMaskC = uC; }
                    shader.vertexShader = shader.vertexShader
                        .replace("void main() {", "varying vec2 vGpeXY;\nvoid main() {")
                        // begin_vertex defines `transformed`, so this follows
                        // anything that displaced the vertex, not the raw attribute.
                        .replace("#include <begin_vertex>",
                            "#include <begin_vertex>\n\tvGpeXY = (modelMatrix * vec4(transformed, 1.0)).xy;");
                    shader.fragmentShader = shader.fragmentShader
                        .replace("void main() {",
                            decl + (lit && lampOK ? lampDecl : "")
                            + "varying vec2 vGpeXY;\nvoid main() {")
                        // Before lighting: a fragment off the felt costs nothing.
                        .replace("#include <clipping_planes_fragment>",
                            "#include <clipping_planes_fragment>\n" + test);
                    // After color_fragment, so it scales the albedo the vertex
                    // colors and the map have already agreed on, and the material's
                    // own lighting still runs on top of the result.
                    if (lit && lampOK) {
                        shader.fragmentShader = shader.fragmentShader
                            .replace("#include <color_fragment>",
                                "#include <color_fragment>\n" + lamp);
                    }
                };
                mat.customProgramCacheKey = () =>
                    (P ? "gpeFeltMaskExact" : "gpeFeltMaskScreen")
                    + (lit && lampOK ? "Lamp" : "");
                return mat;
            },
        };
    }

    // Dashes on the water: short bright strokes drifting downstream. With the
    // surface flat there is nothing left in the shading to say the river is
    // moving, so this is the whole motion cue — and being a handful of small
    // marks rather than an all-over churn, it says it without competing with the
    // cards for attention.
    //
    // Their own geometry, not more vertex color on the water. The surface lattice
    // is 44 cells along its length, so a cell is a good 10-15px; a dash painted
    // into that grid would be a soft smear two cells wide that pulses as it
    // crossed vertex boundaries. Four columns of vertices per dash with alpha
    // running 0 -> 1 -> 1 -> 0 gives a tapered stroke instead, at any length,
    // independent of how the water underneath is tessellated.
    function riverDashes(T, wet, M, place, span) {
        // Two columns, not four: a dash is a solid mark now. It used to run its
        // alpha 0 -> 1 -> 1 -> 0 along its length for a brush-stroke taper, which
        // is a gradient, and to fade in and out at the ends of its run, which is
        // another. Neither is needed — the mask cuts the strip well inside where a
        // dash wraps, so it appears and disappears off the felt where nobody sees
        // it happen.
        const COL = [0, 1];
        const dashes = [];
        for (let i = 0; i < M.DASH; i++) {
            const y = M.DASH_LANES[i % M.DASH_LANES.length] * wet;
            const s = span(y, M.BANK.WATER);
            if (!s || s.x1 - s.x0 < 8) continue;   // a lane too short to drift along
            // Deterministic from the index: there is no RNG to seed here, and a
            // river built twice should look the same both times.
            const h = hash2(i * 7.13, 1.7), h2 = hash2(i * 3.71, 5.5);
            dashes.push({
                y: y, x0: s.x0, run: s.x1 - s.x0,
                len: M.DASH_LEN[0] + (M.DASH_LEN[1] - M.DASH_LEN[0]) * h,
                phase: h2,
                rate: 0.85 + 0.3 * hash2(i * 1.9, 12.1),
            });
        }
        if (!dashes.length) return null;

        const n = dashes.length * 4;             // 2 columns x 2 sides
        const pos = new Float32Array(n * 3), col = new Float32Array(n * 4);
        const idx = [];
        for (let d = 0; d < dashes.length; d++) {
            const a0 = d * 4;
            idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);       // faces +z
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute("position", new T.BufferAttribute(pos, 3));
        geo.setAttribute("color", new T.BufferAttribute(col, 4));
        geo.setIndex(idx);
        const P = geo.attributes.position, C = geo.attributes.color;
        const step = (t) => {
            for (let d = 0; d < dashes.length; d++) {
                const s = dashes[d];
                // Wrapped, so a dash leaving downstream is the one arriving
                // upstream: a fixed set of marks covers an endless drift.
                let u = s.phase + t * M.FLOW * M.DASH_SPEED * s.rate / s.run;
                u -= Math.floor(u);
                const cx = s.x0 + u * s.run;
                for (let c = 0; c < 2; c++) {
                    for (let r = 0; r < 2; r++) {
                        const k = d * 4 + c * 2 + r;
                        place(cx + (COL[c] - 0.5) * s.len,
                            s.y + (r ? M.DASH_W : -M.DASH_W) / 2,
                            M.BANK.WATER, P.array, k * 3);
                        C.array[k * 4] = M.DASH_COLOR[0];
                        C.array[k * 4 + 1] = M.DASH_COLOR[1];
                        C.array[k * 4 + 2] = M.DASH_COLOR[2];
                        C.array[k * 4 + 3] = 1;
                    }
                }
            }
            P.needsUpdate = true; C.needsUpdate = true;
        };
        step(0);
        return { geo: geo, step: step };
    }

    function riverTerrain(T, hb, reach, len, span, M, place) {
        const B = M.BANK;
        // Widths are fractions of the strip's half-width; what the bank does not
        // take is the water.
        const inner = hb * B.INNER, crestW = hb * B.CREST_W, apron = hb * B.APRON;
        const whw = Math.max(8, hb - inner - crestW - apron);
        // Lanes at the corners of the cross-section rather than evenly spaced, so
        // the crest and the slope stay crisp without carrying rows through the
        // flat bed that has nothing to say. Mirrored into one ascending list —
        // the lattice joins row j to row j+1, so out-of-order rows would weave
        // the strip into a tangle rather than a surface.
        // The top is flat all the way out to the outer edge, so the rows that used
        // to carry the apron's ramp down to the cloth are gone: one strip of grass,
        // the inner slope, the bed. The grass simply stops at a hard edge — there
        // is no wall under it, by choice.
        //
        // Where the grass gives way to stone. It is a mesh boundary now, so the
        // doubled row that used to sit either side of it is gone: nothing
        // interpolates across a gap between two meshes, and there is no float32
        // rounding to dodge because neither mesh has to decide which side a row
        // falls on — the row lists below say so outright.
        const seam = whw + inner;
        // Cross-section, in px from the centre line: bed, inner slope, crest,
        // apron. Every band is ONE solid color — grass on the top, stone
        // everywhere else — and nothing is blended between them.
        //
        // This used to mottle the grass with value noise and walk the color from
        // grass to damp earth down the inner slope, with the apron's alpha fading
        // it into the cloth. Three gradients on a shape twenty pixels tall, and
        // together they read as smudge rather than as ground. What makes a
        // low-poly landform look like one is flat facets meeting at an angle: the
        // material is flatShading, so the key light alone shades facet against
        // facet, and it does it from the geometry rather than by painting a
        // gradient over it. Solid colors let that happen instead of fighting it.
        const ground = (x, y) => {
            const s = Math.abs(y);
            let h, col;
            // Grass covers everything the camera sees the TOP of — the crest and
            // the apron ramping away from it — and stone takes over only where the
            // bank turns down into the channel. Which is the reference: green on
            // top, pale stone dropping to the waterline. (Putting stone on the
            // apron instead left grey covering three times the area green did,
            // since the apron is the widest band in the cross-section.)
            if (s >= whw + inner) {                       // the grass, flat to the edge
                h = B.CREST;
                col = M.GRASS;
            } else if (s >= whw) {                        // inner slope, down to the water
                const d = (s - whw) / inner;
                h = B.BED + (B.CREST - B.BED) * d * d;
                col = M.ROCK;
            } else {                                      // bed
                h = B.BED;
                col = M.ROCK;
            }
            // Opaque to the very edge. The apron still ramps down to zero height,
            // so it meets the cloth along a line rather than a wall — but it meets
            // it as stone, not as a fade.
            return [h, col[0], col[1], col[2], 1];
        };

        // THREE lattices, not one, so each carries a single material and a single
        // texture: the grass on either side, and the stone bank between them (its
        // two slopes plus the bed under the water). Splitting them here is what
        // makes texturing possible at all — one mesh cannot hold two maps — and it
        // retires the doubled-row seam trick with it, since the grass/stone colour
        // change is now a boundary BETWEEN meshes rather than across a quad. Both
        // meshes include the boundary row at exactly `seam`, so they share an edge
        // and there is no hairline gap along it.
        // The grass runs right out to `reach`, not just to the strip's own edge:
        // the felt is a landscape with a river cut through it, so everything that
        // is not channel is grass. The mask trims it to the rail, and it has to
        // overshoot generously — the plateau sits at CREST height, so the camera
        // pushes it up-screen, and without the overshoot the down-screen edge of
        // the felt would show bare cloth under it.
        //
        // Several rows across, even though the plateau is flat: place() projects
        // each vertex, and two rows hundreds of px apart would be joined by a
        // straight line where the projection wants a curve.
        const gr = [];
        for (let i = 0; i <= M.GRASS_ROWS; i++) {
            gr.push(seam + (reach - seam) * (i / M.GRASS_ROWS));
        }
        const grassR = riverLattice(T, gr, len, span, M, place, (x, y) => ground(x, y));
        const grassL = riverLattice(T, gr.map((y) => -y).reverse(), len, span, M, place,
            (x, y) => ground(x, y));
        const bank = riverLattice(T, [-seam, -whw, -whw * 0.55, 0, whw * 0.55, whw, seam],
            len, span, M, place, (x, y) => ground(x, y));
        if (!grassL || !grassR || !bank) {
            if (grassL) grassL.geo.dispose();
            if (grassR) grassR.geo.dispose();
            if (bank) bank.geo.dispose();
            return null;
        }

        // The water: a narrower lattice sitting in the cut, its surface a little
        // below the crest so the banks stand over it. It reaches PAST the foot of
        // the slope, up to where its own level meets the rising ground — stopping
        // at the foot would leave a rind of dry bed showing between the two.
        const wet = whw + inner * Math.sqrt(clamp((B.WATER - B.BED) / (B.CREST - B.BED), 0, 1));
        const wetRows = [];
        for (let i = 0; i <= 6; i++) wetRows.push(-wet + (2 * wet) * (i / 6));
        // One solid blue, opaque, hard-edged. No displacement, no foam, and — the
        // last two to go — no alpha ramp at the waterline and no painted shadow
        // under the up-screen bank. Both of those were gradients, and a gradient
        // is exactly what makes this read as a smudge rather than as a surface.
        // What shades the river now is the lights hitting flat faces, nothing else.
        //
        // Being independent of both time and position, this is shaded once at build
        // and never touched again; the per-frame work is the dashes.
        const water = riverLattice(T, wetRows, len, span, M, place,
            () => [B.WATER, M.DEEP[0], M.DEEP[1], M.DEEP[2], 1]);
        if (!water) {
            grassL.geo.dispose(); grassR.geo.dispose(); bank.geo.dispose();
            return null;
        }

        // Nothing vertical is drawn any more. The end caps went because the mask
        // cuts the strip well inside where they sat, so every fragment of them was
        // discarded; the outer side walls went because they read as grey stripes
        // running alongside the river rather than as its sides. What is left is the
        // three surfaces you actually look down on: grass, the stone bank falling
        // to the waterline, and the water.

        // The stones that used to line the waterline are gone — twenty-two little
        // chipped solids that read as grit rather than as rock at this size.

        return { grassL: grassL, grassR: grassR, bank: bank, water: water, whw: whw,
            dash: riverDashes(T, wet, M, place, span) };
    }

    // Land a model that was authored lying down the same way it was authored: the
    // face it rests on turned to the viewer (+Z, since coin3d works in screen
    // space) and its long axis along the direction of travel.
    //
    // Both at once, which is why this is a change of basis and not two chained
    // setFromUnitVectors calls — the second of those spins the model about a new
    // axis and throws away what the first just aimed. `flat` names the two model
    // axes in its own space: `face` is the normal of the side that lands upward,
    // `long` the axis that lies down the throw.
    function flatPose(T, dir, flat) {
        const L = new T.Vector3().fromArray(flat.long).normalize();
        const N = new T.Vector3().fromArray(flat.face).normalize();
        const at = new T.Vector3(0, 0, 1);   // toward the viewer
        // Third axis of each frame, chosen so both come out right-handed and the
        // change of basis is a rotation rather than a rotation plus a mirror.
        const from = new T.Matrix4().makeBasis(L, new T.Vector3().crossVectors(N, L), N);
        const to = new T.Matrix4().makeBasis(dir, new T.Vector3().crossVectors(at, dir), at);
        return new T.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
    }

    // ---------- motions ----------
    // Each is either { projectile: true } — handed to coin3d's registry so it
    // inherits the chip's physics — or { build(T, ctx, spec, opts) -> actor }.
    // ctx carries everything any motion has wanted: the target's centre, the
    // thrower's, the felt ellipse, and the unit direction from thrower to target.
    const MOTIONS = {
        // Ballistic: the chip's arc, bounce off the avatar, felt bounces, skid.
        // Registering the object as a coin3d projectile is all this takes.
        throw: {
            projectile: true,
            // coin3d spins projectiles end over end, so size these by the sphere.
            sizeBySphere: true,
            onTemplate(T, key, spec) {
                if (!window.GPE_COIN || typeof GPE_COIN.registerProjectile !== "function") return;
                GPE_COIN.registerProjectile(key, {
                    make: (TT) => instance(TT, key),
                    // Comes to rest lying along the direction of travel. World y is
                    // screen y flipped, hence the negated dy.
                    settlePose(TT, c) {
                        const dx = c.v.x, dy = -c.v.y;
                        const len = Math.hypot(dx, dy);
                        const dir = len > 1 ? new TT.Vector3(dx / len, dy / len, 0) : new TT.Vector3(1, 0, 0);
                        // Aiming the model's own +Y down the direction of travel is
                        // a pure spin in the screen plane, so it settles showing
                        // whichever side the model was authored facing. That is
                        // fine for a lumpy acorn and wrong for anything flat, which
                        // says so with settleFlat and lands face-up instead.
                        return spec.settleFlat ? flatPose(TT, dir, spec.settleFlat)
                            : new TT.Quaternion().setFromUnitVectors(new TT.Vector3(0, 1, 0), dir);
                    },
                });
            },
        },

        // A river crosses the whole table — rail to rail, through the middle of
        // the felt — flowing toward whoever won the last hand, with dollar bills
        // and chips riding it down.
        //
        // The winner's seat sets the DIRECTION only: the channel is the full
        // chord of the felt ellipse through its centre along that heading, run a
        // little past the edge at both ends so it disappears under the rail
        // rather than stopping short of it. That is why the seat's own position
        // never appears below — everything is the felt's geometry and one angle.
        //
        // One actor draws the whole thing: a strip of ground raised out of the
        // felt with a channel cut down it and water in the channel (see
        // riverTerrain), and every bill and chip a swimmer on that channel — u
        // downstream, v across. All of it hangs off one group rotated to the
        // heading, so everything inside works in river space (+x downstream, +y
        // across) and nothing needs aiming individually.
        //
        // The landscape's origin is the UPSTREAM edge rather than its own middle,
        // which is what lets the river open by scaling x: it runs in from that
        // edge instead of swelling out of the centre.
        river: {
            // px the strip is built PAST the felt at each end, so the mask always
            // has material to cut and never a gap it cannot fill. The excess is
            // discarded before it is shaded, so it costs almost nothing.
            OVER: 120,
            // Width of the WHOLE strip, banks included — a fraction of the felt's
            // SHORT axis, and so the same at every heading. It used to be a
            // fraction of the chord through the felt, which is nearly three times
            // longer across the table's width than across its depth: turning the
            // river squashed it and re-stretched it, when it should just be the
            // same river pointed somewhere else. Tracking the felt keeps it in
            // proportion when the table is resized.
            STRIP_OF_FELT: 1.62,   // strip width, in felt half-depths
            GRASS_ROWS: 7,         // rows across each grass plateau, for the projection's curve
            // The overhead lamp: height as a fraction of the felt's half-width, and
            // the illuminance wanted directly under it. 1.22 puts the felt's edge at
            // ~0.6 of the centre's brightness, which is the falloff table3d's own
            // lamp gives its felt.
            STRIP_FALLBACK: 165,   // px, for the (unmasked) no-felt case
            // The cross-section. The WIDTHS are fractions of the strip's own half
            // width so the bank stays in proportion if the strip changes; the
            // HEIGHTS are in px, because how far the ground stands off the cloth is
            // about what the eye can pick out, not about how wide the river is.
            //
            // The gap between CREST and WATER is the drop from the bank down to
            // the river, and it is the whole point of the exercise.
            // Heights roughly doubled from the flat-ribbon days. With the outer
            // edge now a wall rather than a ramp, CREST is literally how tall that
            // wall is: at 22 it came out a 14px band (22 x LEAN) against a ~150px
            // strip — under a tenth of the width, far too little to read as a
            // raised bank. The reference's banks stand about a third of the river's
            // width, which is what these are aiming at. The CREST-to-WATER gap is
            // the drop from the top down to the surface, and is the whole effect.
            BANK: { INNER: 0.13, CREST_W: 0.09, APRON: 0.20, CREST: 42, WATER: 14, BED: 8 },
            // ...which it only can if height leans toward the viewer. coin3d's
            // camera is orthographic and points straight down its own z, so a
            // vertical rise moves nothing on screen — build a mountain along z and
            // it renders as a flat disc. So height is split: most of it up-screen
            // (where it shifts pixels and shows the drop, the far bank standing
            // over the water, a stone's silhouette) and the rest along z (where it
            // does nothing visible but keeps what is high in front of what is low).
            // 0.62 is roughly the table's own elevation — the same cheat the site's
            // near-top-down art uses to make an upright thing look upright.
            LEAN: 0.62,
            // Vertex colors are LINEAR — the renderer converts on the way out —
            // so these look about half as dark as they read on screen. They are
            // set to what comes out the far end under coin3d's lights, which are
            // bright: ambient 1.35 with a key on top of it.
            // Two solid colors carry the whole landform: sage green on top, pale
            // stone for every face that is not the top. Both are a good deal
            // lighter than the greens they replace, which were chosen to survive
            // being mottled and blended; a flat color does not need that headroom.
            // The grass reads DARKER than the felt it sits on, so the landform
            // separates from the cloth instead of glowing against it. Solved from a
            // render rather than guessed: the felt measures #2d504a (luma 72), the
            // vertex-to-screen gain here is about 0.85 in linear light, and these
            // land near #2c4323 (luma 60) — clearly under the cloth, still clearly
            // green.
            GRASS: [0.030, 0.066, 0.020],
            // Left where it was. Trimming this 12% to stop the bright cobbles
            // clipping on a low-ratio display moved the clipped fraction from
            // 5.32% to 5.17% — those pixels are far over 255, not marginally
            // over, so scaling the albedo is the wrong lever and the trim only
            // cost brightness. See the note on stone clipping in LAMP.
            ROCK: [0.52, 0.55, 0.56],
            // Sampled from a screenshot rather than guessed: [0.02, 0.14, 0.36]
            // came out #346a98, a bright mid-blue, where the look wanted a deep
            // navy for the dashes to read against.
            DEEP: [0.008, 0.022, 0.088],
            // The dashes, which are the whole motion cue now the surface is flat.
            // Lanes are fractions of the channel's half-width and deliberately
            // uneven — evenly spaced they line up into a grid the eye reads as a
            // pattern rather than as drifting water. Kept inside 0.72 so a dash
            // never rides up onto the waterline.
            DASH: 15,
            DASH_LANES: [-0.66, -0.31, 0.06, 0.41, 0.70, -0.48, 0.24],
            DASH_LEN: [13, 29],   // px along the flow; varied so they don't read as one object
            DASH_W: 1.8,          // px across it
            // Slower than the cargo floating past. The water reads as carrying the
            // chips rather than racing them, and a dash moving at FLOW looks like
            // one more thing being swept along instead of the sweeping.
            DASH_SPEED: 0.6,
            DASH_COLOR: [0.30, 0.55, 0.85],
            SPAWN: 2.7,           // ...over which bills and chips are launched
            // Water moves at a speed, not in a fixed time: a swimmer's crossing
            // is the channel's own length divided by this, so the long river and
            // the short one flow at the same rate rather than looking sluggish
            // and frantic respectively.
            FLOW: 190, RUN: [1.5, 3.6], RUN_JITTER: 0.12,
            LIFE: 5.0, FADE: 0.9,
            BILLS: 7, CHIPS: 12, BOTTLES: 4,
            CHIP_SCALE: 0.78,     // a chip rides a little smaller than a tossed one
            BOTTLE_SCALE: 0.8, BOTTLE_SPIN: 0.35, BOTTLE_ROLL: 0.18,
            // Lane and sway are fractions of the channel width, and they add: 0.20
            // + 0.09 keeps a swimmer's CENTRE inside the water even at full
            // wander, so nothing ends up sailing over the bank onto dry felt.
            LANE: 0.20, SWAY: 0.09,
            SWAY_HZ: [0.35, 0.8],
            SPIN: [-1.5, 1.5],    // in-plane turn, rad/s
            ROLL: 0.5,            // rock about the flow axis, rad
            ARRIVE: 0.18,         // fraction of the run spent sinking into the water
            // A swimmer stops this far short of the water's edge at both ends.
            // Its POSITION is a centre point and a bill is 38px long, so riding
            // all the way to the edge hangs half of it over the rail — which is
            // the one thing the surface was just clipped to avoid.
            INSET: 24,
            // The swimmers float ON the water, so they clear the highest thing
            // under them — the grass crest, which stands over the waterline. When
            // the water was a flat sheet this was 4 and fine; once the landscape
            // had a body, anything below it was painted over by it.
            // Z_SWIM has to clear the tallest thing under a swimmer, and the
            // landscape's own z runs to CREST x sqrt(1 - LEAN^2) — so raising the
            // banks raises this with it, or the grass draws over the cargo.
            Z_LAND: 1, Z_WATER: 1.2, Z_SWIM: 44,
            build(T, ctx, spec, opts) {
                const M = MOTIONS.river;
                const f = ctx.felt;
                if (!ctx.to) return null;
                // Heading: the middle of the felt toward the winner's seat. Only
                // its ANGLE is kept — the length comes from the table. Without a
                // felt (no table on screen) there is no chord to take, so it falls
                // back to the sender's heading and a plain crossing through the
                // seat, which is the same shape drawn off worse information.
                const mid = f ? { x: f.cx, y: f.cy } : { x: ctx.to.x, y: ctx.to.y };
                let hx = ctx.to.x - mid.x, hy = ctx.to.y - mid.y;
                if (!f && ctx.from) { hx = ctx.to.x - ctx.from.x; hy = ctx.to.y - ctx.from.y; }
                let h = Math.hypot(hx, hy);
                if (h < 1e-3) { hx = 0; hy = 1; h = 1; }   // dead centre: send it down-screen
                const ux = hx / h, uy = hy / h;

                // Where that heading crosses the felt's edge: the ellipse is
                // stretched into a circle, the unit ray measured against it, and
                // the answer stretched back — one line, and exact at any angle.
                // Both ends of the chord are the same reach, so the river runs
                // from one edge through the pot to the other.
                // Reach far enough to cross the felt from ANY direction — the
                // longest way across, not this heading's own chord — so the built
                // length is constant too and the mask decides where it stops. The
                // old per-heading chord is what made a river to a near seat a
                // stubby chute and one to the end a long one.
                const reach = f ? (f.ax + M.OVER) : Math.max(h, 120);
                const len = reach * 2;
                if (len < 40) return null;
                const src = { x: mid.x - ux * reach, y: mid.y - uy * reach };

                const group = new T.Group();
                group.position.set(src.x, -src.y, 0);
                group.rotation.z = Math.atan2(-uy, ux);   // world y is screen y flipped

                // ONE width, and one length, whatever the heading. Both used to be
                // derived from the chord through the felt — and that chord is long
                // across the table's width and short across its depth, so turning
                // the river squashed and re-stretched it. It is a river; it is the
                // same river at every angle. The width is a fraction of the felt's
                // short axis so it still tracks the table's size, and the length is
                // simply enough to cross the felt from any direction, with the mask
                // taking care of where it actually stops.
                const strip = f ? f.by * M.STRIP_OF_FELT : M.STRIP_FALLBACK;
                const hb = strip / 2;                                  // the ground, half-width

                // How far a lane of the channel runs — the strip's full length
                // plus OVER at both ends, and NOT trimmed to the felt. The mask
                // decides what is visible, which is the whole point. This used to
                // solve the felt's edge per lane, and with thirteen lanes across
                // the strip that approximated the rail as a thirteen-step
                // staircase, each step trimmed at one height while the surface
                // over it varied: ragged, and wrong in both directions at once.
                // Nothing in here knows about the rail any more.
                // Height is not this function's business — place() below applies
                // it. Shifting the extent by the shear as well counted it twice,
                // sliding the high rows of the landscape along the flow relative
                // to the low ones. OVER at both ends is slop the mask eats anyway.
                const laneSpan = () => ({ x0: -M.OVER, x1: len + M.OVER });

                // Ground and water are both plain rectangles now — straight banks,
                // square ends, built past the rail at both. What makes them follow
                // the felt's own edge is the mask, not their shape.
                //
                // The group is already rotated to the heading (see group.rotation.z
                // above), so everything below is in the river's own frame: x runs
                // downstream, y across the channel. Height goes partly into that
                // frame and partly into z — LEAN across, and what is left of the
                // unit vector into depth, which is only ever used for draw order.
                const flat = Math.sqrt(Math.max(0, 1 - M.LEAN * M.LEAN));

                // Height, laid OUTWARD from the channel rather than all one way.
                //
                // This is the part that kept going wrong. Faking height with a 2D
                // offset means shearing, and a shear applied to a symmetric channel
                // slides the whole landscape in one direction: on one side the grass
                // pulls back off the water and shows a wide wall, on the other it
                // overhangs and hides its wall completely. That is the skew — the
                // river looked like it was leaning over, and which side leaned
                // depended on the heading. Borrowing the table camera's parallax per
                // point did the same thing, plus made the two edges fan apart,
                // because the camera's offset grows across the felt.
                //
                // So the offset is signed by which bank the point is on: each side
                // lifts away from the centreline by the same amount. Both walls are
                // visible, both the same width, at every angle — which is what "we
                // want both walls" and "it is mostly top down" actually describe. It
                // is parallel by construction (a line of constant y gets a constant
                // shift), the same size at every heading, and it asks the camera for
                // nothing, so it cannot differ between two machines.
                //
                // What it gives up is the camera-matched lean. Nothing here converges
                // toward a vanishing point any more; it reads as a trench seen from
                // above, which at 64 degrees of elevation over a table this size is
                // very close to what the perspective was drawing anyway.
                const place = (x, y, hgt, out, i) => {
                    const h = hgt || 0;
                    const lift = h * M.LEAN;
                    // Math.sign, but without the -0 case: the river bed sits at y = 0
                    // and must not pick a side.
                    const side = y > 0 ? 1 : (y < 0 ? -1 : 0);
                    out[i] = x;
                    out[i + 1] = y + side * lift;
                    out[i + 2] = h * flat;          // depth order only
                };

                const mask = feltMask(T, f);

                const terrain = riverTerrain(T, hb, reach, len, laneSpan, M, place);
                if (!terrain) return null;
                const width = terrain.whw * 2;      // the water the cargo rides in
                // Both surfaces are lit by their own vertex colors: the ground
                // matte, the water glossy enough to catch the key light off a
                // crest. Alpha rides in the color too — it is what fades the
                // apron into the cloth and both of them out at the ends.
                // Grass and stone are separate materials because they carry
                // separate maps. Both keep vertexColors, so the base tint still
                // comes from GRASS/ROCK and the texture modulates it rather than
                // replacing it — which is what lets the grass stay darker than the
                // felt while still reading as grass.
                const mkGround = (map, rough) => new T.MeshStandardMaterial({
                    vertexColors: true, transparent: true, depthWrite: false,
                    map: map, roughness: rough, metalness: 0,
                    // Faceted, like the low-poly ground it is imitating: the bank
                    // is only a dozen lanes wide, and smoothing them out throws
                    // away the one thing that says this is a landform.
                    flatShading: true,
                });
                const grassMat = mkGround(makeGrassTexture(T), 0.95);
                const stoneMat = mkGround(makeStoneTexture(T), 0.80);
                const waterMat = new T.MeshStandardMaterial({
                    vertexColors: true, transparent: true, depthWrite: false,
                    // Matte, and flat-shaded like the ground and the walls. Without
                    // flatShading the lattice's normals interpolate and the sheet
                    // shades smoothly across itself — a gradient produced by the
                    // renderer rather than by anything in the scene. The emissive
                    // went for the same reason it was never right: a self-glow is
                    // not light from a light.
                    roughness: 0.85, metalness: 0, flatShading: true,
                });
                // The dashes are unlit on purpose: they are a graphic mark, not a
                // wet surface, and a key light raking across them would make the
                // upstream ones brighter than the downstream ones for no reason.
                const dashMat = new T.MeshBasicMaterial({
                    vertexColors: true, transparent: true, depthWrite: false,
                });
                // Everything the river draws goes through the mask — the surfaces
                // here, and every bill, chip and bottle riding it (see board()).
                //
                // No felt means no mask, and the geometry is built well past the
                // rail now — so drawing it would put a slab of landscape over the
                // wood. Refuse instead, and say why: silently painting outside the
                // table is worse than the celebration not playing.
                if (!mask) {
                    grassMat.dispose(); stoneMat.dispose();
                    waterMat.dispose(); dashMat.dispose();
                    terrain.grassL.geo.dispose(); terrain.grassR.geo.dispose();
                    terrain.bank.geo.dispose(); terrain.water.geo.dispose();
                    console.warn("[GPokr Tools] river: no felt bounds, so nothing to mask to — skipped");
                    return null;
                }
                // Ground, walls and water are lit by the pool over the table's
                // centre (see LAMP in feltMask); the dashes are not, because they
                // are a graphic mark and dimming them toward the rail would read as
                // them fading out rather than as the table being lit.
                mask.apply(grassMat); mask.apply(stoneMat); mask.apply(waterMat);
                mask.apply(dashMat, { lamp: false });
                riverDiag(T, mask, f, grassMat.map, stoneMat.map);

                const water = new T.Group();
                const gL = new T.Mesh(terrain.grassL.geo, grassMat);
                const gR = new T.Mesh(terrain.grassR.geo, grassMat);
                const bank = new T.Mesh(terrain.bank.geo, stoneMat);
                const wet = new T.Mesh(terrain.water.geo, waterMat);
                gL.position.z = gR.position.z = bank.position.z = M.Z_LAND;
                wet.position.z = M.Z_WATER;
                if (terrain.dash) {
                    const dash = new T.Mesh(terrain.dash.geo, dashMat);
                    dash.position.z = M.Z_WATER + 0.1;
                    dash.renderOrder = 3;            // on the water
                    water.add(dash);
                }
                // All transparent and none writes depth, so the order they are
                // drawn in IS the order they stack — 0.2px of separation is too
                // little to trust a depth sort with. Grass and bank are coplanar
                // neighbours rather than overlapping, so they share an order.
                gL.renderOrder = gR.renderOrder = bank.renderOrder = 1;
                wet.renderOrder = 2;
                water.add(gL, gR, bank, wet);
                group.add(water);

                // ---- swimmers ----
                const X = new T.Vector3(1, 0, 0), Z = new T.Vector3(0, 0, 1);
                const lie = spec.settleFlat || { face: [0, 1, 0], long: [1, 0, 0] };
                const swimmers = [];
                const board = (mesh, scale, opt) => {
                    if (!mesh) return;
                    group.add(mesh);
                    // Masked like the water it floats on, or the cargo sails out
                    // over the rail while the river it is riding stops at it.
                    //
                    // Safe to do in place because every source hands out per-
                    // instance materials: instance() clones them, and coin3d's chip
                    // maker clones per throw. A source that SHARED a material would
                    // clip thrown chips to the felt too, which is why this is worth
                    // stating rather than assuming.
                    mesh.traverse((n) => {
                        if (!n.material) return;
                        const mats = Array.isArray(n.material) ? n.material : [n.material];
                        // Masked but not lit by the pool: a bill or a chip is an
                        // object on the river, not part of the ground, and dimming
                        // it as it drifts toward the rail would read as the thing
                        // itself fading rather than as the table being lit.
                        for (const m of mats) mask.apply(m, { lamp: false });
                    });
                    // Each one rides its OWN lane, so it enters and leaves the water
                    // where that lane does rather than at the centre line's ends —
                    // otherwise an off-centre swimmer spends its first and last
                    // moments on dry felt beyond the curve of the water.
                    const lane = rand(-1, 1);
                    // Trimmed at the water's own height, so a swimmer's run ends
                    // where the water it is riding ends rather than where the
                    // unleaned channel would have.
                    const s = laneSpan(lane * M.LANE * width, M.BANK.WATER) || { x0: 0, x1: len };
                    // Inset both ends, unless the lane is so short that doing so
                    // would leave nowhere to swim.
                    const room = (s.x1 - s.x0) > M.INSET * 2 + 40 ? M.INSET : 0;
                    swimmers.push({
                        mesh: mesh,
                        base: mesh.quaternion.clone(),
                        scale: scale,
                        // Spread over the spawn window rather than randomly, so the
                        // river is never briefly empty; the jitter is the wander.
                        t0: 0.1 + M.SPAWN * (swimmers.length / (M.BILLS + M.CHIPS + M.BOTTLES)),
                        dur: clamp(len / M.FLOW, M.RUN[0], M.RUN[1]) * rand(1 - M.RUN_JITTER, 1 + M.RUN_JITTER),
                        from: s.x0 + room, to: s.x1 - room,
                        lane: lane,
                        hz: rand(M.SWAY_HZ[0], M.SWAY_HZ[1]),
                        phase: Math.random() * Math.PI * 2,
                        // A flat thing spins in the plane it lies in and rocks about
                        // the flow; a bottle standing in the water can do neither
                        // without looking like a clock hand, so it says what it wants.
                        spin: opt && opt.spin != null
                            ? opt.spin * (Math.random() < 0.5 ? -1 : 1) : rand(M.SPIN[0], M.SPIN[1]),
                        roll: opt && opt.roll != null ? opt.roll : M.ROLL,
                        z: rand(-0.6, 0.6),
                    });
                    mesh.visible = false;
                };
                // Bills first, chips second, then the spawn times are dealt out
                // round-robin below so the two arrive mixed rather than in waves.
                for (let i = 0; i < M.BILLS; i++) {
                    const bill = instance(T, ctx.key);
                    if (!bill) break;
                    // The bill is a single zero-thickness plane, so it is only
                    // drawn from one side unless told otherwise — and a swimmer
                    // that rocks WILL turn its back to us.
                    //
                    // It also arrives half metal and nearly polished (an FBX Phong
                    // conversion), which under the key light blows a bill that
                    // happens to face it to solid white — the note vanishes and a
                    // blank card floats down the river instead. Paper is neither.
                    bill.traverse((n) => {
                        const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
                        for (const m of mats) {
                            m.side = T.DoubleSide;
                            m.metalness = 0;
                            m.roughness = 0.8;
                        }
                    });
                    bill.quaternion.copy(flatPose(T, X, lie));   // face up, pointing downstream
                    board(bill, (bill.userData && bill.userData.gpeBaseScale) || 1);
                }
                const coin = window.GPE_COIN;
                for (let i = 0; coin && typeof coin.chipMesh === "function" && i < M.CHIPS; i++) {
                    const chip = coin.chipMesh();
                    if (!chip) break;
                    chip.scale.setScalar(M.CHIP_SCALE);
                    board(chip, M.CHIP_SCALE);
                }
                // ...and a few bottles bobbing along with the money. The beer is the
                // catalog's own model, borrowed: content.js asks for it alongside
                // the river's, and if it never arrived the river simply sails
                // without it rather than not sailing.
                for (let i = 0; templates.beer && i < M.BOTTLES; i++) {
                    const bottle = instance(T, "beer");
                    if (!bottle) break;
                    bottle.scale.multiplyScalar(M.BOTTLE_SCALE);
                    // It keeps the upright pose the catalog gave it — a bottle
                    // floats standing, and it is the one piece of cargo with a top
                    // and a bottom worth telling apart. So: no in-plane spin to
                    // speak of, and it rocks rather than rolls.
                    board(bottle, bottle.scale.x, { spin: M.BOTTLE_SPIN, roll: M.BOTTLE_ROLL });
                }
                if (!swimmers.length) return null;
                // Deal the spawn times out again, interleaved: each kind was built
                // in its own run, and taking them in that order would send seven
                // bills down the river ahead of twelve chips ahead of the beer.
                const times = swimmers.map((s) => s.t0);
                for (let i = swimmers.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    const tmp = times[i]; times[i] = times[j]; times[j] = tmp;
                }
                swimmers.forEach((s, i) => { s.t0 = times[i]; });

                let t = 0, lifted = -1;
                const spin = new T.Quaternion(), roll = new T.Quaternion();
                const swimAt = [0, 0, 0];

                const actor = {
                    object3D: group,
                    step(dt) {
                        t += dt;
                        // No run-in. The river is simply there, at full size, from
                        // the first frame — it does not grow, sweep or scale in.
                        // Every version of that read as the landform inflating, and
                        // in the inspector a rebuild on each drag step replayed it,
                        // so dragging was a river endlessly re-expanding.

                        // Drift the dashes downstream — but no more than 60 times
                        // a second. Actors are stepped on a fixed 1/120 clock and
                        // up to 8 times per drawn frame, and rewriting the marks
                        // eight times to draw them once is seven rivers nobody
                        // sees. (Neither the ground nor the water moves at all now.)
                        if (terrain.dash && t - lifted >= 1 / 60) {
                            terrain.dash.step(t); lifted = t;
                        }

                        for (const s of swimmers) {
                            const u = (t - s.t0) / s.dur;
                            if (u < 0) continue;
                            const gone = clamp((u - 1) / M.ARRIVE, 0, 1);
                            if (gone >= 1) { s.mesh.visible = false; continue; }
                            s.mesh.visible = true;
                            const sway = Math.sin((t * s.hz + s.phase) * 2 * Math.PI);
                            // On the water, which means through the same lean the
                            // landscape went through — otherwise the cargo floats
                            // where the river would have been without the lean, and
                            // slides visibly off the downstream bank. The surface is
                            // flat, so the height is simply the waterline; this used
                            // to add the swell so a chip bobbed over the crests.
                            const sx2 = s.from + Math.min(1, u) * (s.to - s.from);
                            const sy2 = (s.lane * M.LANE + sway * M.SWAY) * width;
                            place(sx2, sy2, M.BANK.WATER, swimAt, 0);
                            s.mesh.position.set(swimAt[0], swimAt[1], M.Z_SWIM + s.z);
                            spin.setFromAxisAngle(Z, s.spin * t);
                            roll.setFromAxisAngle(X, s.roll * sway);
                            s.mesh.quaternion.copy(s.base).premultiply(spin).premultiply(roll);
                            // Into the winner's stack: it shrinks away as it lands
                            // rather than stopping dead on top of their avatar.
                            s.mesh.scale.setScalar(s.scale * (1 - 0.4 * gone));
                            if (gone > 0) setAlpha(s.mesh, 1 - gone);
                        }

                        // Held open for the inspector: no lifetime, no fade, and it
                        // ends only when whoever holds it says so. Everything above
                        // still runs, so the dashes drift and the cargo floats the
                        // way they do in the real thing.
                        if (opts && opts.hold) return !opts.hold();
                        const left = M.LIFE - t;
                        if (left <= 0) return false;
                        if (left < M.FADE) {
                            const a = left / M.FADE;
                            grassMat.opacity = a;
                            stoneMat.opacity = a;
                            waterMat.opacity = a;
                            dashMat.opacity = a;
                            for (const s of swimmers) {
                                const u = (t - s.t0) / s.dur;
                                const gone = clamp((u - 1) / M.ARRIVE, 0, 1);
                                setAlpha(s.mesh, (1 - gone) * a);
                            }
                        }
                        return true;
                    },
                    // coin3d frees the materials it can see; the lattices and the
                    // lattices are built per river and are this actor's own to free.
                    dispose() {
                        terrain.grassL.geo.dispose();
                        terrain.grassR.geo.dispose();
                        terrain.bank.geo.dispose();
                        terrain.water.geo.dispose();
                    },
                };
                return actor;
            },
        },

        // Slides across the felt from the sender's rail to the target's, upright,
        // decelerating like something heavy on a smooth surface, then sits.
        slide: {
            SLIDE_SPEED: 620, SLIDE_MIN: 0.45, SLIDE_MAX: 1.5,
            REST_MS: 10000, FADE_MS: 900, RAIL_OUT: 1.06, Z: 3,
            build(T, ctx, spec, opts) {
                const M = MOTIONS.slide;
                const mesh = instance(T, ctx.key);
                if (!mesh || !ctx.felt) return null;

                const rail = (x, y) => {
                    const dx = x - ctx.felt.cx, dy = y - ctx.felt.cy;
                    const len = Math.hypot(dx / ctx.felt.ax, dy / ctx.felt.by) || 1;
                    const k = M.RAIL_OUT / len;
                    return { x: ctx.felt.cx + dx * k, y: ctx.felt.cy + dy * k };
                };
                const end = rail(ctx.to.x, ctx.to.y);
                const start = ctx.from
                    ? rail(ctx.from.x, ctx.from.y)
                    : { x: ctx.felt.cx, y: ctx.felt.cy + ctx.felt.by * M.RAIL_OUT };

                const dist = Math.hypot(end.x - start.x, end.y - start.y);
                const dur = clamp(dist / M.SLIDE_SPEED, M.SLIDE_MIN, M.SLIDE_MAX);
                let t = 0, resting = 0, arrived = false;

                const actor = {
                    object3D: mesh,
                    step(dt) {
                        if (t < dur) {
                            t = Math.min(dur, t + dt);
                            const e = easeOutCubic(t / dur);
                            mesh.position.set(start.x + (end.x - start.x) * e,
                                -(start.y + (end.y - start.y) * e), M.Z);
                            if (t >= dur && !arrived) {
                                arrived = true;
                                if (opts.onArrive) { try { opts.onArrive(); } catch (e) {} }
                            }
                            return true;
                        }
                        resting += dt * 1000;
                        if (resting <= M.REST_MS) return true;
                        const alpha = 1 - (resting - M.REST_MS) / M.FADE_MS;
                        if (alpha <= 0) return false;
                        setAlpha(mesh, alpha);
                        return true;
                    },
                };
                mesh.position.set(start.x, -start.y, M.Z);
                return actor;
            },
        },

        // Falls from above the target, swaying, and lingers in front of them.
        drift: {
            FALL_H: 155, FALL_DUR: 3.0, FRONT_STEP: 42, REST_MS: 1500, FADE_MS: 1100,
            Z: 6, SWAY_AMP: 30, SWAY_PERIOD: 1.7, ROCK: 0.20, YAW_RATE: 0.5,
            build(T, ctx, spec, opts) {
                const M = MOTIONS.drift;
                const mesh = instance(T, ctx.key);
                if (!mesh) return null;

                // Rest in front of the player: a short step from their seat toward
                // the middle of the table, so it lands between them and the felt
                // rather than on top of their face.
                let base = { x: ctx.to.x, y: ctx.to.y };
                if (ctx.felt) {
                    const dx = ctx.felt.cx - ctx.to.x, dy = ctx.felt.cy - ctx.to.y;
                    const len = Math.hypot(dx, dy) || 1;
                    base = { x: ctx.to.x + dx / len * M.FRONT_STEP, y: ctx.to.y + dy / len * M.FRONT_STEP };
                }

                const endY = base.y, startY = base.y - M.FALL_H, baseX = base.x;
                const phase = Math.random() * Math.PI * 2;   // so a pair don't sway in lockstep
                const spin = Math.random() < 0.5 ? -1 : 1;
                let t = 0, resting = 0, arrived = false;

                const poseAt = (tt) => {
                    const sway = Math.sin(tt / M.SWAY_PERIOD * 2 * Math.PI + phase);
                    mesh.rotation.set(0, spin * tt * M.YAW_RATE, M.ROCK * sway);
                    return baseX + M.SWAY_AMP * sway;
                };

                const actor = {
                    object3D: mesh,
                    step(dt) {
                        if (t < M.FALL_DUR) {
                            t = Math.min(M.FALL_DUR, t + dt);
                            const p = t / M.FALL_DUR;
                            mesh.position.set(poseAt(t), -(startY + (endY - startY) * p), M.Z);
                            if (t >= M.FALL_DUR && !arrived) {
                                arrived = true;
                                if (opts.onArrive) { try { opts.onArrive(); } catch (e) {} }
                            }
                            return true;
                        }
                        resting += dt * 1000;
                        mesh.position.set(poseAt(M.FALL_DUR + resting / 1000 * 0.15), -endY, M.Z);
                        if (resting <= M.REST_MS) return true;
                        const alpha = 1 - (resting - M.REST_MS) / M.FADE_MS;
                        if (alpha <= 0) return false;
                        setAlpha(mesh, alpha);
                        return true;
                    },
                };
                mesh.position.set(poseAt(0), -startY, M.Z);
                return actor;
            },
        },

        // Sweeps in from the thrower's side, accelerating into the avatar, then
        // follows through past it.
        swing: {
            REACH: 104, PAST: 52, SWING: 0.75, FOLLOW: 0.13, FADE: 0.75, ROLL: 0.9, Z: 8,
            build(T, ctx, spec, opts) {
                const M = MOTIONS.swing;
                const mesh = instance(T, ctx.key);
                if (!mesh) return null;
                const baseScale = (mesh.userData && mesh.userData.gpeBaseScale) || mesh.scale.x || 1;

                // In from the thrower if we know where they are, otherwise a
                // backhand sweep from the lower right — natural on this near-top-down view.
                const dir = ctx.dir || { x: -0.7, y: -0.72 };
                const face = ctx.to;
                const start = { x: face.x - dir.x * M.REACH, y: face.y - dir.y * M.REACH };
                const end = { x: face.x + dir.x * M.PAST, y: face.y + dir.y * M.PAST };
                let t = 0, hit = false;

                const put = (x, y, roll, scale) => {
                    mesh.position.set(x, -y, M.Z);
                    mesh.rotation.set(0, 0, roll);   // on top of the pitched pose inside the model
                    mesh.scale.setScalar(baseScale * scale);
                };

                const actor = {
                    object3D: mesh,
                    step(dt) {
                        t += dt;
                        if (t <= M.SWING) {
                            const p = easeInQuad(clamp(t / M.SWING, 0, 1));
                            put(lerp(start.x, face.x, p), lerp(start.y, face.y, p),
                                lerp(M.ROLL, 0, p), lerp(0.82, 1.06, p));
                            return true;
                        }
                        if (!hit) {
                            hit = true;
                            if (opts.onHit) { try { opts.onHit(); } catch (e) {} }
                        }
                        if (t <= M.SWING + M.FOLLOW) {
                            const p = easeOutCubic(clamp((t - M.SWING) / M.FOLLOW, 0, 1));
                            put(lerp(face.x, end.x, p), lerp(face.y, end.y, p),
                                lerp(0, -M.ROLL, p), lerp(1.06, 1, p));
                            return true;
                        }
                        const fp = (t - M.SWING - M.FOLLOW) / M.FADE;
                        if (fp >= 1) return false;
                        put(end.x, end.y, -M.ROLL, 1);
                        setAlpha(mesh, 1 - fp);
                        return true;
                    },
                };
                put(start.x, start.y, M.ROLL, 0.82);
                return actor;
            },
        },

        // A life ring, lobbed over someone and left floating around them — the
        // gesture you make at a player who is drowning. Three things have to be
        // true or the joke doesn't land: it has to arrive as a RING and not a
        // disc, it has to end up AROUND the avatar rather than lying on top of
        // it, and it has to keep moving afterwards, because a life preserver
        // sitting perfectly still is just a doughnut.
        //
        // The first two are one trick, and the camera does the work. gpokr's
        // table is drawn from a near-top-down elevation, and from up there a ring
        // lying flat around a swimmer reads as a full ellipse with the swimmer
        // inside it — no part of it needs to pass BEHIND them. That matters more
        // than it looks: the props canvas is one flat layer over the page at z 9
        // and the avatar is DOM underneath it, so a prop is either wholly in front
        // of a seat or wholly behind it. Nothing here can thread through an
        // avatar, and at this elevation nothing has to.
        //
        // So the ring is posed to lie in the table's own plane and drawn over the
        // seat, and the avatar shows through the hole. TILT comes from the river's
        // LEAN rather than being eyeballed: LEAN is cos(E) for the table's
        // elevation E, a circle lying flat projects to an ellipse squashed to
        // sin(E), and rotation.x = acos(LEAN) is the angle that gives both at once
        // — so the ring agrees with the river about which way the table is tipped.
        //
        // The rig is three nested groups, one rotation each, because they are
        // three different axes and one Euler triple would make their order matter:
        // roll is in the screen plane (outermost), lean is about screen x, and the
        // spin is about the ring's OWN axis, which only exists inside the lean.
        // Same reason normalize() wraps each catalog pose in its own group.
        ring: {
            FLY: 0.52,          // s, the thrower's rail to a hover over the target
            ARC: 92,            // px the lob rises above the straight line
            DROP: 0.34,         // s, dropping over them
            DROP_H: 54,         // px up-screen of its resting spot that the drop starts
            SETTLE: 0.6,        // s of damped rocking once it is over them
            SETTLE_ROCK: 0.26,  // rad of lean wobble at the moment it lands
            SETTLE_ROLL: 0.2,   // ...and of in-plane roll, a quarter-period behind it
            SETTLE_HOP: 6,      // px it rebounds after landing
            REST_MS: 5200,      // how long it floats there before going
            FADE_MS: 900,
            // The idle. Three periods, none of them multiples of each other, so it
            // reads as water rather than as a loop: a ring bobbing on a 2.6s cycle
            // while rocking on a 3.6s one never repeats inside its own lifetime.
            BOB: 3.6, BOB_PERIOD: 2.6,
            IDLE_ROCK: 0.05, IDLE_ROCK_PERIOD: 3.6,
            IDLE_ROLL: 0.07, IDLE_ROLL_PERIOD: 2.1,
            SPIN: 7.4,          // rad/s about its own axis at launch
            SPIN_DECAY: 2.6,    // e-folds per second; it is still turning as it lands
            GROW: 1.06,         // scale on the way down, easing back to 1 as it settles
            // Resting centre, in avatar heights BELOW the middle of the portrait.
            // The avatars are head-and-shoulders, so dead centre puts the hole over
            // the face; a sixth of a height down wears it on the shoulders and
            // leaves the face clear inside the top of the ring.
            SIT: 0.16,
            Z: 10,              // over everything else at a seat, including the gloves
            build(T, ctx, spec, opts) {
                const M = MOTIONS.ring;
                const mesh = instance(T, ctx.key);
                if (!mesh) return null;

                // See the note above: acos(LEAN) leans the ring's axis out of the
                // screen exactly as far as the table's own up vector is leaned.
                const TILT = Math.acos(MOTIONS.river.LEAN);

                const spinner = new T.Group();   // about the ring's own axis
                spinner.add(mesh);
                const lean = new T.Group();      // about screen x: how flat it lies
                lean.add(spinner);
                const rig = new T.Group();       // in the screen plane, and positioned
                rig.add(lean);

                const avH = (ctx.toSize && ctx.toSize.h) || 64;
                const rest = { x: ctx.to.x, y: ctx.to.y + avH * M.SIT };
                const hover = { x: rest.x, y: rest.y - M.DROP_H };
                // Thrown from the sender's seat when we know it, otherwise lobbed
                // in off the near rail — the same fallback the slide uses, and the
                // arc reads the same either way.
                const start = ctx.from
                    ? { x: ctx.from.x, y: ctx.from.y }
                    : (ctx.felt ? { x: ctx.felt.cx, y: ctx.felt.cy }
                        : { x: rest.x, y: rest.y + 220 });

                // Every ring gets its own phases, so two of them floating at
                // neighbouring seats don't bob in lockstep.
                const ph = [rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2)];
                const spinDir = Math.random() < 0.5 ? -1 : 1;
                let t = 0, spin = 0, resting = 0, landed = false;

                const put = (x, y, rock, roll, scale) => {
                    rig.position.set(x, -y, M.Z);
                    rig.rotation.z = roll;
                    lean.rotation.x = TILT + rock;
                    spinner.rotation.y = spin;
                    rig.scale.setScalar(scale);
                };

                const actor = {
                    object3D: rig,
                    step(dt) {
                        t += dt;
                        // Still turning when it arrives, which is what makes the
                        // drop read as a catch rather than as a placement.
                        spin += spinDir * M.SPIN * Math.exp(-M.SPIN_DECAY * t) * dt;

                        if (t < M.FLY) {
                            const p = t / M.FLY;
                            put(lerp(start.x, hover.x, p),
                                lerp(start.y, hover.y, p) - M.ARC * Math.sin(Math.PI * p),
                                // Comes in banked and levels off as it arrives.
                                M.SETTLE_ROCK * (1 - p), M.SETTLE_ROLL * (1 - p) * 0.6, 1);
                            return true;
                        }
                        if (t < M.FLY + M.DROP) {
                            const p = easeInQuad((t - M.FLY) / M.DROP);   // it falls
                            put(hover.x, lerp(hover.y, rest.y, p), 0, 0, lerp(M.GROW, 1, p));
                            return true;
                        }
                        if (!landed) {
                            landed = true;
                            if (opts.onHit) { try { opts.onHit(); } catch (e) {} }
                            else if (opts.onArrive) { try { opts.onArrive(); } catch (e) {} }
                        }
                        if (t < M.FLY + M.DROP + M.SETTLE) {
                            // Damped: about a turn and a half of rocking, squared
                            // falloff, with the roll a quarter period behind the
                            // lean so it wallows instead of pumping.
                            const k = (t - M.FLY - M.DROP) / M.SETTLE;
                            const d = (1 - k) * (1 - k);
                            const w = k * Math.PI * 3;
                            put(rest.x, rest.y - M.SETTLE_HOP * d * Math.abs(Math.sin(w)),
                                M.SETTLE_ROCK * d * Math.cos(w),
                                M.SETTLE_ROLL * d * Math.sin(w), 1);
                            return true;
                        }

                        // Afloat. Kept up while it fades, so it goes on bobbing on
                        // the way out rather than freezing and then vanishing.
                        const f = t - M.FLY - M.DROP - M.SETTLE;
                        const wave = (amp, period, phase) =>
                            amp * Math.sin(f / period * 2 * Math.PI + phase);
                        put(rest.x, rest.y + wave(M.BOB, M.BOB_PERIOD, ph[0]),
                            wave(M.IDLE_ROCK, M.IDLE_ROCK_PERIOD, ph[1]),
                            wave(M.IDLE_ROLL, M.IDLE_ROLL_PERIOD, ph[2]), 1);

                        resting += dt * 1000;
                        if (resting <= M.REST_MS) return true;
                        const alpha = 1 - (resting - M.REST_MS) / M.FADE_MS;
                        if (alpha <= 0) return false;
                        setAlpha(rig, alpha);
                        return true;
                    },
                };
                put(start.x, start.y, M.SETTLE_ROCK, M.SETTLE_ROLL * 0.6, 1);
                return actor;
            },
        },

        // A PAIR of gloves applauding in front of a standing avatar. Both hands
        // are one actor: they can never drift apart, and one object3D means
        // coin3d's removeActor frees both sets of materials.
        //
        // LEAD / CLAPS / PERIOD are a single choreography shared three ways —
        // here, the avatar's rise in content.js's standAndClap(), and the eight
        // transients in assets/audio/clap.mp3 (see tools/make_clap.py). Change
        // one and the other two drift off it.
        //
        // Orientation is set as an explicit basis rather than Euler angles, because
        // what matters is stated directly: the hand's length runs at the viewer and
        // its broad face turns to meet its partner. The two differ only in which way
        // that face points, which is the mirror. Built with makeBasis (a rotation)
        // rather than a negative scale, since a negative determinant flips winding
        // order and the glove would light itself inside-out.
        //
        // The hands HINGE AT THE WRIST while the wrists themselves slide together —
        // half the closing distance from each. Sliding whole hands into each other
        // reads as stiff; hinging alone needs so much angle to close the gap that the
        // hands turn face-on to the camera and look flat. Splitting it keeps the
        // articulation without either failure.
        //
        // Each hand sits in a pivot group, offset half a hand-length along its finger
        // axis so the cuff lands on the pivot; swinging the pivot about world up
        // carries the fingertips together. SHUT stays small on purpose, so the palms
        // meet nearly parallel.
        clap: {
            LEAD: 0.42, CLAPS: 8, PERIOD: 0.33, TAIL: 0.62,
            WRIST_OPEN: 26,  // half the distance between the wrists, apart (px)
            WRIST_SHUT: 15,  // ...and at the strike: the wrists close ~11px each
            OPEN: -0.52,     // hinge angle with the hands apart (rad)
            SHUT: 0.06,      // ...and at the strike: palms flat against each other
            STRIKE: 0.42,    // share of a period spent closing; the rest reopens
            RISE: 22,        // how far they float up into place during LEAD (px)
            Z: 9,
            build(T, ctx, spec, opts) {
                const M = MOTIONS.clap;
                const near = instance(T, ctx.key);
                const far = instance(T, ctx.key);
                if (!near || !far) return null;

                // Local +Y runs along the hand (fingers) and -Z is its broad face,
                // after the catalog's poseX. Aim the length at the viewer (+Z) and
                // turn the broad face inward, so the palms meet.
                const V = (x, y, z) => new T.Vector3(x, y, z);
                const pose = new T.Quaternion().setFromRotationMatrix(
                    new T.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0)));
                near.quaternion.copy(pose);
                far.quaternion.copy(pose);

                // Push each hand half its length up its finger axis so the cuff —
                // the wrist — sits on its pivot's origin. normalize() scaled the
                // model's length to spec.height, so that half-length is in px here.
                const half = (spec.height || 100) / 2;
                near.position.set(0, 0, half);
                far.position.set(0, 0, half);

                // Both hands take the SAME pose; the far one is then REFLECTED.
                // There is only one glove model and it is a right hand, so this has
                // to be a reflection and not a rotation — no rotation turns a right
                // hand into a left one, which is why a half-turn about Y used to
                // leave the far hand clapping with its thumb pointing down.
                //
                // The mirror gets its own node outside the mesh's rotation so the
                // plane it reflects across is the world vertical between the two
                // wrists, not some axis of the hand. A negative determinant is safe
                // here: three.js reads it off the world matrix and flips the front
                // face winding to match, so the reflected glove still lights right.
                const mirror = new T.Group();
                mirror.scale.set(-1, 1, 1);
                mirror.add(far);

                const nearPivot = new T.Group(); nearPivot.add(near);
                const farPivot = new T.Group(); farPivot.add(mirror);
                const group = new T.Group();
                group.add(nearPivot, farPivot);

                // Centre of the clap: the caller's point, nudged by however far it
                // wants the hands to sit below the avatar's middle (chest height).
                const cx = ctx.to.x;
                const cy = ctx.to.y + (opts.dropY || 0);

                const LIFE = M.LEAD + M.CLAPS * M.PERIOD + M.TAIL;
                let t = 0;

                // One eased parameter drives BOTH halves of the closing motion, so the
                // slide and the hinge can never fall out of step: 0 is wide apart, 1 is
                // struck. Values outside that range extrapolate, which the release at
                // the end uses to fall further open than a clap ever does.
                const poseAt = (p) => put(
                    lerp(M.OPEN, M.SHUT, p),
                    lerp(M.WRIST_OPEN, M.WRIST_SHUT, p)
                );

                // `wrist` is half the distance between the two pivots; `swing` hinges
                // the hands about them, mirrored, so the palms come together. Scaling
                // the PIVOT rather than the mesh keeps the hand and its wrist offset
                // together and leaves the template's own scale untouched.
                let dy = 0, scale = 1;
                const put = (swing, wrist) => {
                    nearPivot.position.set(cx - wrist, -(cy + dy), M.Z);
                    nearPivot.rotation.y = swing;
                    nearPivot.scale.setScalar(scale);
                    farPivot.position.set(cx + wrist, -(cy + dy), M.Z);
                    farPivot.rotation.y = -swing;
                    farPivot.scale.setScalar(scale);
                };

                const actor = {
                    object3D: group,
                    step(dt) {
                        t += dt;
                        if (t >= LIFE) return false;

                        // Float up into place while the avatar is still rising.
                        if (t < M.LEAD) {
                            const e = easeOutCubic(clamp(t / M.LEAD, 0, 1));
                            setAlpha(group, e);
                            dy = M.RISE * (1 - e);
                            scale = 0.9 + 0.1 * e;
                            poseAt(0);
                            return true;
                        }

                        const since = t - M.LEAD;
                        const i = Math.floor(since / M.PERIOD);

                        // Applause over: the hands fall open and fade where they are.
                        if (i >= M.CLAPS) {
                            const q = clamp((since - M.CLAPS * M.PERIOD) / M.TAIL, 0, 1);
                            setAlpha(group, 1 - q);
                            dy = -10 * q;
                            scale = 1 - 0.12 * q;
                            poseAt(-0.55 * q);   // past open: the hands drop loose
                            return true;
                        }

                        const u = (since - i * M.PERIOD) / M.PERIOD;
                        // p: 0 apart, 1 struck. Closing accelerates, so contact is the
                        // fastest part of the cycle rather than a soft meeting; the
                        // rebound springs open and eases to a stop.
                        const p = u < M.STRIKE
                            ? easeInQuad(u / M.STRIKE)
                            : 1 - easeOutCubic((u - M.STRIKE) / (1 - M.STRIKE));
                        // The pair dips into each strike rather than hanging level.
                        dy = Math.sin(u * Math.PI) * 5;
                        scale = lerp(1, 1.06, p);
                        poseAt(p);
                        return true;
                    },
                };
                setAlpha(group, 0);
                dy = M.RISE;
                scale = 0.9;
                poseAt(0);
                return actor;
            },
        },
    };

    // ---------- throwing ----------
    const live = Object.create(null);   // key -> actors in flight, oldest first

    function capLive(key, spec, actor) {
        const list = (live[key] || []).filter((a) => a.object3D && a.object3D.parent);
        list.push(actor);
        while (list.length > (spec.maxLive || 6)) {
            const oldest = list.shift();
            if (oldest && oldest.step) oldest.step = () => false;   // retire next tick
        }
        live[key] = list;
    }

    // Same signature as GPE_COIN.toss, with the object key in front, so content.js's
    // step dispatcher stays uniform across every item.
    function toss(key, fromRect, toRect, tableRect, opts) {
        const spec = CATALOG[key];
        if (!spec) return false;
        const T = window.THREE;
        if (!T) return warnOnce(key, "THREE is not loaded");
        if (!templates[key]) return warnOnce(key, "the model has not loaded yet");
        if (!window.GPE_COIN) return warnOnce(key, "coin3d is missing");
        if (!toRect || !toRect.width) return warnOnce(key, "the target has no on-screen avatar");

        const o = (typeof opts === "function") ? { onHit: opts, onArrive: opts } : (opts || {});
        const motion = MOTIONS[spec.motion];
        if (!motion) return warnOnce(key, 'unknown motion "' + spec.motion + '"');

        // Ballistic objects go through coin3d's own physics rather than an actor.
        if (motion.projectile) {
            if (typeof GPE_COIN.registerProjectile !== "function") {
                return warnOnce(key, "coin3d has no projectile registry (stale 3d/coin3d.js?)");
            }
            return !!GPE_COIN.toss(fromRect, toRect, tableRect, Object.assign({}, o, { item: key }));
        }

        if (typeof GPE_COIN.addActor !== "function") {
            return warnOnce(key, "coin3d is missing addActor (stale 3d/coin3d.js?)");
        }
        const felt = (typeof GPE_COIN.feltBounds === "function") ? GPE_COIN.feltBounds(tableRect) : null;
        const to = centreOf(toRect);
        const from = (fromRect && fromRect.width) ? centreOf(fromRect) : null;
        let dir = null;
        if (from) {
            const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
            dir = { x: dx / len, y: dy / len };
        }

        // toSize rides along because one motion needs the target's SIZE and not
        // just its centre: the life ring sits a fraction of an avatar height low,
        // so it wears on the shoulders at any table scale rather than at one.
        const toSize = { w: toRect.width, h: toRect.height };
        const actor = motion.build(T, { key: key, to: to, from: from, felt: felt, dir: dir, toSize: toSize }, spec, o);
        if (!actor) return false;
        if (!GPE_COIN.addActor(actor)) return false;
        capLive(key, spec, actor);
        return true;
    }

    // ---------- the inspector ----------
    // One river, held on the felt at a heading of your choosing, for looking at.
    // It exists because the celebration is a five-second event behind a
    // between-hands gate, which makes judging how the thing actually looks a
    // reload-and-wait cycle per attempt.
    //
    // Deliberately built through toss() and the ordinary river motion rather than
    // a private path: what you are inspecting has to be the same geometry, the
    // same mask and the same projection players get, or it is worth nothing.
    // The heading comes from a synthetic target out on the felt's edge, which is
    // exactly how a real one aims itself (mid -> the winner's seat).
    let held = null;
    function holdRiver(angleRad, tableRect) {
        releaseRiver();
        if (typeof GPE_COIN === "undefined" || !GPE_COIN) return false;
        const felt = (typeof GPE_COIN.feltBounds === "function")
            ? GPE_COIN.feltBounds(tableRect) : null;
        if (!felt) return false;
        const x = felt.cx + felt.ax * Math.cos(angleRad);
        const y = felt.cy + felt.by * Math.sin(angleRad);
        const toRect = { left: x - 20, top: y - 20, right: x + 20, bottom: y + 20,
            width: 40, height: 40 };
        let dead = false;
        const ok = toss("river", null, toRect, tableRect, { hold: () => dead });
        if (ok) held = { kill: () => { dead = true; } };
        return ok;
    }
    function releaseRiver() {
        if (held) held.kill();
        held = null;
    }

    window.GPE_PROPS = {
        toss: toss,
        holdRiver: holdRiver,
        releaseRiver: releaseRiver,
        isHolding: () => !!held,
        ready: ready,
        has: (key) => !!CATALOG[key],
        // Menu data for content.js, so the item list has one home rather than two.
        catalog: CATALOG,
        order: ORDER.slice(),
        isRunning: () => Object.keys(live).some((k) => live[k].some((a) => a.object3D && a.object3D.parent)),
    };
})();
