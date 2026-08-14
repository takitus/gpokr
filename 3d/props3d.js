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
 * Exposes window.GPE_PROPS = { toss, ready, catalog, has }. Loaded after
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
    };
    const ORDER = ["beer", "flower", "glove", "acorn", "peanut", "cashew", "bone"];

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
    // ---------- the river's landscape ----------
    // Everything here is geometry and per-vertex colour. There is deliberately
    // not a texture in it: the river used to be a tiled ripple map scrolling over
    // a flat sheet, and at this size the tile was plainly a tile — the same
    // handful of wave crests marching past over and over. Colour that comes from
    // a hash of the vertex's own position never repeats, because there is nothing
    // to repeat.
    //
    // The shape is the reference photo's: a strip of ground raised off the felt
    // with a channel cut down the middle of it. Across the strip that is, from
    // the outside in — an apron that lifts out of the cloth and fades in as it
    // goes, a grass crest, an inner slope down to the waterline, and a bed. The
    // water is its own surface sitting in the channel, and the only part that
    // moves.
    const hash2 = (x, y) => {
        const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        return s - Math.floor(s);
    };

    // Value noise: the hash smoothed over a grid, so the ground mottles in
    // patches rather than per-vertex confetti.
    function vnoise(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u),
            lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
    }

    // The swell on the water: two trains whose wavelengths are deliberately not
    // multiples of one another, so their sum never comes back round to where it
    // started within a river's length.
    const RIVER_WAVE = (x, y, t, M) => M.WAVE * (
        0.62 * Math.sin(2 * Math.PI * (x / M.WAVE_LEN - t * M.WAVE_HZ) + y * 0.05)
        + 0.38 * Math.sin(2 * Math.PI * (x / (M.WAVE_LEN * 0.41) + t * M.WAVE_HZ * 0.8) - y * 0.09));

    // One lattice over the felt-clipped strip: `rows` are the lateral offsets to
    // put lanes at, and `at(x, y, t)` returns [height, r, g, b, a] for a point.
    //
    // The landscape used to sink and fade away over the last 30px at each end.
    // It does not any more: it runs at full height right up to the felt's edge
    // and stops there against a cut face (see riverEndCap). Which is why the
    // trimming has to account for the LEAN — a lane sitting 22px high is drawn
    // 14px up-screen of where it was measured, so clipping it where it was
    // measured would push it that far over the rail. `span(y, h)` is asked where
    // a lane of that height may run, and answers in the lane's own coordinates.
    function riverLattice(T, rows, len, span, M, place, at) {
        const NU = 44, cols = NU + 1, n = rows.length * cols;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 4);
        const vx = new Float32Array(n), vy = new Float32Array(n);
        const ends = [];                    // [x0, x1] per row, for the end caps
        let k = 0;
        for (let j = 0; j < rows.length; j++) {
            const y = rows[j];
            const s = span(y, at(0, y, 0)[0]);
            if (!s || s.x1 - s.x0 < 2) return null;
            ends.push([s.x0, s.x1]);
            const run = s.x1 - s.x0;
            for (let i = 0; i < cols; i++) {
                vx[k] = s.x0 + run * (i / NU); vy[k] = y;
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
        return { geo: geo, shade: shade, ends: ends };
    }

    // The cut face where the landscape meets the rail: a wall from the surface
    // down to the cloth, across every lane, at each end. This is the whole reason
    // the river can stop dead instead of dissolving — an edge you can see the
    // thickness of reads as ground that has been cut through, and a fade reads as
    // a picture running out of ink.
    function riverEndCap(T, rows, ends, M, place, heightAt, colour) {
        const pos = [], col = [];
        const push = (p) => {
            pos.push(p[0], p[1], p[2]);
            col.push(colour[0] * M.CUT_SHADE, colour[1] * M.CUT_SHADE, colour[2] * M.CUT_SHADE, 1);
        };
        const at = (x, y, h) => { const v = [0, 0, 0]; place(x, y, h, v, 0); return v; };

        // How far a unit of height moves a point, which is the whole of the lean.
        const unit = at(0, 0, 1);
        // Only ONE end can show its cut face: the one whose outward direction
        // points down-screen, toward the viewer. At the other end we are looking
        // at the top of the same cliff from above, and a face drawn there would
        // lie across the ground it belongs to.
        const e = unit[0] > 0 ? 0 : 1;
        const inward = e === 0 ? 1 : -1;

        for (let j = 0; j < rows.length - 1; j++) {
            const pair = [j, j + 1].map((r) => {
                const y = rows[r], h = heightAt(y);
                // The TOP of the face is the surface's own edge — already trimmed
                // so that it lands exactly on the felt. The FOOT is dropped from
                // there back INTO the strip by the width the lean gives the face,
                // rather than from where the surface was measured: measured is a
                // lean's worth outside the felt at this end, which is what put a
                // wedge of cliff out over the rail.
                const top = at(ends[r][e], y, h);
                const foot = [top[0] + inward * Math.abs(unit[0] * h),
                    top[1] + inward * unit[1] * h * Math.sign(unit[0] || 1), 0];
                return { top: top, foot: foot };
            });
            if (Math.abs(pair[0].top[2]) < 0.05 && Math.abs(pair[1].top[2]) < 0.05) continue;
            // Wound so the face looks at the camera; the two triangles of the quad
            // are emitted in the order that puts their normal on +z.
            const quad = inward > 0
                ? [pair[0].top, pair[0].foot, pair[1].top, pair[0].foot, pair[1].foot, pair[1].top]
                : [pair[0].top, pair[1].top, pair[0].foot, pair[0].foot, pair[1].top, pair[1].foot];
            for (const p of quad) push(p);
        }
        if (!pos.length) return null;
        const geo = new T.BufferGeometry();
        geo.setAttribute("position", new T.BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute("color", new T.BufferAttribute(new Float32Array(col), 4));
        geo.computeVertexNormals();
        return geo;
    }

    // The two halves of the landscape, over the same clipped channel.
    //
    // The ground is built once and never touched again — it has no business
    // moving. Only the water is reshaded per frame, which is also why the crests
    // can carry their own foam: brightening the colour where the surface stands
    // high costs nothing once the height is already being computed there, and it
    // gives the white of breaking water without a streak texture to tile.
    function riverTerrain(T, hb, len, span, M, place, shadeSide) {
        const B = M.BANK;
        // Widths are fractions of the strip's half-width; what the bank does not
        // take is the water.
        const inner = hb * B.INNER, crestW = hb * B.CREST_W, apron = hb * B.APRON;
        const whw = Math.max(8, hb - inner - crestW - apron);
        const crestOut = whw + inner + crestW;           // outer edge of the grass crest
        // Lanes at the corners of the cross-section rather than evenly spaced, so
        // the crest and the slope stay crisp without carrying rows through the
        // flat bed that has nothing to say. Mirrored into one ascending list —
        // the lattice joins row j to row j+1, so out-of-order rows would weave
        // the strip into a tangle rather than a surface.
        const half = [hb, (hb + crestOut) / 2, crestOut, whw + inner, whw, whw * 0.55, 0];
        const rows = half.map((y) => -y).concat(half.slice(0, -1).reverse());

        // Cross-section, in px from the centre line: bed, inner slope, crest,
        // apron. Colour walks grass -> damp earth on the way down to the water.
        const ground = (x, y) => {
            const s = Math.abs(y);
            const n = vnoise(x / M.GRASS_CELL, y / M.GRASS_CELL);
            let h, mix;                                   // mix: 0 grass, 1 earth
            if (s >= crestOut) {                          // apron, out to nothing
                h = B.CREST * clamp((hb - s) / (hb - crestOut), 0, 1);
                mix = 0;
            } else if (s >= whw + inner) {                // crest
                h = B.CREST;
                mix = 0;
            } else if (s >= whw) {                        // inner slope
                const d = (s - whw) / inner;
                h = B.BED + (B.CREST - B.BED) * d * d;
                mix = 1 - d;
            } else {                                      // bed
                h = B.BED;
                mix = 1;
            }
            const g = [M.GRASS[0] + n * M.GRASS_VAR, M.GRASS[1] + n * M.GRASS_VAR,
                M.GRASS[2] + n * M.GRASS_VAR * 0.6];
            // The outer rim is the one place a fade still belongs: the apron
            // reaches the cloth at zero height, and without it the grass would
            // stop against the felt in a hard line drawn at nothing.
            const rim = clamp((hb - s) / M.RIM_FADE, 0, 1);
            return [h,
                lerp(g[0], M.EARTH[0], mix), lerp(g[1], M.EARTH[1], mix),
                lerp(g[2], M.EARTH[2], mix), rim];
        };
        const groundH = (y) => ground(0, y)[0];

        const land = riverLattice(T, rows, len, span, M, place, (x, y) => ground(x, y));
        if (!land) return null;

        // The water: a narrower lattice sitting in the cut, its surface a little
        // below the crest so the banks stand over it. It reaches PAST the foot of
        // the slope, up to where its own level meets the rising ground — stopping
        // at the foot would leave a rind of dry bed showing between the two.
        const wet = whw + inner * Math.sqrt(clamp((B.WATER - B.BED) / (B.CREST - B.BED), 0, 1));
        const wetRows = [];
        for (let i = 0; i <= 6; i++) wetRows.push(-wet + (2 * wet) * (i / 6));
        const water = riverLattice(T, wetRows, len, span, M, place, (x, y, t) => {
            const wave = RIVER_WAVE(x, y, t, M);
            // Foam on the crests, and a darker trough — the whole reason the water
            // reads as moving without anything scrolling across it. Cubed, because
            // a straight blend spends most of its time halfway between deep water
            // and white and the river comes out the colour of milk: this way the
            // deep blue holds until a crest is nearly at its peak.
            const lit = Math.pow(clamp(0.5 + wave / (M.WAVE * 2), 0, 1), 4);
            const edge = clamp((wet - Math.abs(y)) / M.WET_EDGE, 0, 1);
            // The bank standing between the light and the water throws a shadow
            // along its own foot. Only the UP-SCREEN bank does — that is the one
            // whose inner face we are looking at — and it is the single strongest
            // cue that the water is down in a channel rather than painted on.
            const band = M.SHADE_W * wet;
            const cast = shadeSide * y > 0 ? clamp((Math.abs(y) - (wet - band)) / band, 0, 1) : 0;
            const dim = 1 - M.SHADE * cast * cast;
            return [B.WATER + wave,
                lerp(M.DEEP[0], M.FOAM[0], lit) * dim, lerp(M.DEEP[1], M.FOAM[1], lit) * dim,
                lerp(M.DEEP[2], M.FOAM[2], lit) * dim, M.WET_ALPHA * edge];
        });
        if (!water) { land.geo.dispose(); return null; }

        const cap = riverEndCap(T, rows, land.ends, M, place, groundH, M.EARTH);

        // Stones along the waterline. No two are the same rock: each picks one of
        // four solids — a 4-face tetrahedron up to a 32-face subdivided octahedron
        // — squashes it on all three axes, and then pushes every vertex in or out
        // by a hash of the DIRECTION it points. That last part is what keeps a
        // stone whole: the shapes are non-indexed, so a corner appears in three or
        // four faces at once, and jittering each copy on its own would tear the
        // rock into shrapnel. Non-indexed also means every face keeps its own
        // normal, so they read as chipped rather than as pebbles.
        const stones = [];
        const push = (x, y, h) => { const v = [0, 0, 0]; place(x, y, h, v, 0); stones.push(v[0], v[1], v[2]); };
        const scol = [];
        const shapes = M.STONE_SHAPES.map(([kind, detail]) => {
            const g = kind === 4 ? new T.TetrahedronGeometry(1, detail)
                : kind === 20 ? new T.IcosahedronGeometry(1, detail)
                    : new T.OctahedronGeometry(1, detail);
            // Already non-indexed in three's polyhedra, but not promised to be —
            // and toNonIndexed() warns rather than no-ops when it is.
            const flat = g.index ? g.toNonIndexed() : g;
            const p = flat.attributes.position.array.slice();
            if (flat !== g) flat.dispose();
            g.dispose();
            return p;
        });
        for (let i = 0; i < M.STONES; i++) {
            // Scattered rather than spaced. Three things were making the old bank
            // look laid out by hand: the sides strictly alternated, the position
            // along the bank was a slot with a third of a slot of jitter, and every
            // stone sat the same distance up the slope.
            //
            // So: the side is a coin toss; the position keeps its slot but may
            // wander a whole slot and a half either way, which lets neighbours
            // clump and leaves the gaps between clumps that a real bank has; and
            // the distance up the slope runs from the water's edge to the top of
            // the crest, so some are half in the river and some are up in the grass.
            const side = hash2(i, 41) < 0.5 ? -1 : 1;
            // Wrapped rather than clamped: a stone whose jitter takes it off one
            // end comes back on at the other, where clamping would stack it on the
            // last one and leave two rocks in exactly the same place.
            const slot = (i + 0.5 + (hash2(i, 7) - 0.5) * 3) / M.STONES;
            const along = 0.05 + (slot - Math.floor(slot)) * 0.9;
            const y = side * (whw - inner * 0.12 + (inner + crestW) * hash2(i, 3) * 0.92);
            const s = span(y, groundH(y));
            if (!s || s.x1 - s.x0 < 8) continue;
            const x = s.x0 + (s.x1 - s.x0) * along;
            const r = M.STONE_R[0] + hash2(i, 11) * (M.STONE_R[1] - M.STONE_R[0]);
            const shape = shapes[Math.floor(hash2(i, 17) * shapes.length) % shapes.length];
            // Squashed differently on each axis, and flatter than it is wide, so a
            // stone sits in the bank rather than perching on it like a marble.
            const sx = r * (0.7 + hash2(i, 23) * 0.6);
            const sy = r * (0.7 + hash2(i, 29) * 0.6);
            const sz = r * (0.4 + hash2(i, 31) * 0.4);
            const base = groundH(y) + sz * 0.35;
            const g = M.STONE[0] + hash2(i, 5) * M.STONE_VAR;
            for (let v = 0; v < shape.length; v += 3) {
                const dx = shape[v], dy = shape[v + 1], dz = shape[v + 2];
                const j = 1 + M.STONE_JITTER * (hash2(Math.round(dx * 64) + i * 13,
                    Math.round(dy * 64) * 31 + Math.round(dz * 64)) - 0.5);
                push(x + dx * sx * j, y + dy * sy * j, base + dz * sz * j);
                scol.push(g, g * 1.02, g * 1.06, 1);
            }
        }
        let rock = null;
        if (stones.length) {
            rock = new T.BufferGeometry();
            rock.setAttribute("position", new T.BufferAttribute(new Float32Array(stones), 3));
            rock.setAttribute("color", new T.BufferAttribute(new Float32Array(scol), 4));
            rock.computeVertexNormals();
        }
        return { land: land, water: water, rock: rock, cap: cap, whw: whw };
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
            // The centre line runs exactly to the felt's edge — no further, since
            // the water is meant to be held by the rail rather than lapping over
            // it — and every other lane is cut short by the curve (see laneSpan).
            RAIL: 1.0,
            // Width of the WHOLE strip, banks included: a fraction of its own
            // length, within bounds. A river to a seat on the near rail crosses
            // the felt's short way and is a third the length of one to a seat on
            // the end, and a single fixed width made that short crossing read as a
            // stubby chute. THIN is the backstop on the same problem: whatever the
            // bounds say, the thing is at least three times as long as it is wide
            // or it stops looking like a river, so the shortest crossing gives up
            // width rather than shape.
            STRIP: [138, 192], STRIP_OF_LEN: 0.33, THIN: 2,
            // The cross-section. The WIDTHS are fractions of the strip's own half
            // width, so a short river gets a bank in proportion rather than the
            // same 25px of shoulder eating a channel half the size; the HEIGHTS
            // are in px, because how far the ground stands off the cloth is about
            // what the eye can pick out, not about how wide the river is.
            //
            // The gap between CREST and WATER is the drop from the bank down to
            // the river, and it is the whole point of the exercise.
            BANK: { INNER: 0.13, CREST_W: 0.09, APRON: 0.20, CREST: 22, WATER: 8, BED: 5 },
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
            STONES: 22, STONE_R: [3, 8], STONE_JITTER: 0.42,
            // [faces, subdivisions] — a tetrahedron through to a 32-face octahedron,
            // so the bank is not lined with thirty identical crystals.
            STONE_SHAPES: [[4, 0], [8, 0], [20, 0], [8, 1]],
            STONE: [0.26, 0.32], STONE_VAR: 0.26,
            RIM_FADE: 6,          // px of the outer apron over which the grass fades into the cloth
            CUT_SHADE: 0.72,      // the cut face at each end, against the ground's own colour
            WET_EDGE: 4,          // px of waterline over which the water fades into the bank
            SHADE: 0.62, SHADE_W: 0.34,   // the bank's shadow on the water: depth, and how far it reaches
            WET_ALPHA: 0.94,
            // Vertex colours are LINEAR — the renderer converts on the way out —
            // so these look about half as dark as they read on screen. They are
            // set to what comes out the far end under coin3d's lights, which are
            // bright: ambient 1.35 with a key on top of it.
            GRASS_CELL: 9,        // px per patch of ground mottling
            GRASS: [0.13, 0.26, 0.06], GRASS_VAR: 0.08,
            EARTH: [0.14, 0.09, 0.05],
            DEEP: [0.02, 0.14, 0.36], FOAM: [0.70, 0.90, 1.0],
            // The swell: two trains whose wavelengths are deliberately not
            // multiples of one another, so the pattern never comes back round.
            WAVE: 1.9, WAVE_LEN: 61, WAVE_HZ: 0.5,
            HEAD: 0.55,           // seconds for the water to cross the table
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
            Z_LAND: 1, Z_WATER: 1.2, Z_SWIM: 11,
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
                const reach = f ? M.RAIL / (Math.hypot(ux / f.ax, uy / f.by) || 1) : Math.max(h, 120);
                const len = reach * 2;
                if (len < 40) return null;
                const src = { x: mid.x - ux * reach, y: mid.y - uy * reach };

                const group = new T.Group();
                group.position.set(src.x, -src.y, 0);
                group.rotation.z = Math.atan2(-uy, ux);   // world y is screen y flipped

                const strip = Math.min(clamp(len * M.STRIP_OF_LEN, M.STRIP[0], M.STRIP[1]), len / M.THIN);
                const hb = strip / 2;                                  // the ground, half-width

                // How far the water reaches along a given LANE of the channel,
                // which is a straight line offset sideways from the centre one.
                // Substituting that line into the ellipse gives a quadratic in x,
                // and its two roots are where the lane enters and leaves the felt.
                // The centre lane's roots are 0 and len by construction; every
                // other lane's fall short at both ends, which is exactly the curve
                // the rail cuts. Returns null for a lane that misses the felt.
                const px = uy, py = -ux;                  // river +y, in screen space
                const sx = src.x - mid.x, sy = src.y - mid.y;
                // `hgt` is how high the lane will be drawn: the lean moves it that
                // far up-screen, so it has to be trimmed where it will LAND rather
                // than where it was measured, or the raised ground overhangs the
                // rail by exactly the amount that makes it look three-dimensional.
                const laneSpan = (y, hgt) => {
                    const dx = upx * (hgt || 0) * M.LEAN, dy = upy * (hgt || 0) * M.LEAN;
                    if (!f) return { x0: -dx, x1: len - dx };
                    y += dy;
                    const qx = sx + y * px, qy = sy + y * py;
                    const A = (ux * ux) / (f.ax * f.ax) + (uy * uy) / (f.by * f.by);
                    const B = 2 * (qx * ux / (f.ax * f.ax) + qy * uy / (f.by * f.by));
                    const C = (qx * qx) / (f.ax * f.ax) + (qy * qy) / (f.by * f.by) - 1;
                    const disc = B * B - 4 * A * C;
                    if (disc <= 0 || A <= 0) return null;
                    const r = Math.sqrt(disc);
                    return { x0: (-B - r) / (2 * A) - dx, x1: (-B + r) / (2 * A) - dx };
                };

                // Ground and water are both that clipped strip, not rectangles:
                // straight banks and ends that follow the felt's own edge. A
                // rectangle laid across an oval has to either stop short of the
                // rail in the middle or put its corners over it — there is no
                // length that does neither.
                // Where a point of the landscape actually lands. The group is
                // rotated to the heading, so "up the screen" in here is whatever
                // world up became under that rotation — height is laid along it
                // (times LEAN) and along z (times what is left), which is what
                // turns a height field into something you can see the side of.
                const theta = Math.atan2(-uy, ux);
                const upx = Math.sin(theta), upy = Math.cos(theta);
                const flat = Math.sqrt(Math.max(0, 1 - M.LEAN * M.LEAN));
                const place = (x, y, hgt, out, i) => {
                    out[i] = x + upx * hgt * M.LEAN;
                    out[i + 1] = y + upy * hgt * M.LEAN;
                    out[i + 2] = hgt * flat;
                };

                const terrain = riverTerrain(T, hb, len, laneSpan, M, place, upy >= 0 ? 1 : -1);
                if (!terrain) return null;
                const width = terrain.whw * 2;      // the water the cargo rides in
                // Both surfaces are lit by their own vertex colours: the ground
                // matte, the water glossy enough to catch the key light off a
                // crest. Alpha rides in the colour too — it is what fades the
                // apron into the cloth and both of them out at the ends.
                const landMat = new T.MeshStandardMaterial({
                    vertexColors: true, transparent: true, depthWrite: false,
                    roughness: 0.95, metalness: 0,
                    // Faceted, like the low-poly ground it is imitating: the bank
                    // is only a dozen lanes wide, and smoothing them out throws
                    // away the one thing that says this is a landform.
                    flatShading: true,
                });
                const waterMat = new T.MeshStandardMaterial({
                    vertexColors: true, transparent: true, depthWrite: false,
                    // Glossy, but not a mirror: at 0.16 the key light came off
                    // every crest as a hard white glare and drowned the foam that
                    // is supposed to be doing that job.
                    roughness: 0.32, metalness: 0.1,
                    emissive: 0x08324f, emissiveIntensity: 0.3,
                });
                const water = new T.Group();
                const land = new T.Mesh(terrain.land.geo, landMat);
                const wet = new T.Mesh(terrain.water.geo, waterMat);
                land.position.z = M.Z_LAND;
                wet.position.z = M.Z_WATER;
                if (terrain.cap) {
                    const cut = new T.Mesh(terrain.cap, landMat);
                    cut.position.z = M.Z_LAND;
                    cut.renderOrder = 1;
                    water.add(cut);
                }
                if (terrain.rock) {
                    const rock = new T.Mesh(terrain.rock, landMat);
                    rock.position.z = M.Z_LAND + 0.1;
                    rock.renderOrder = 3;            // on the bank, over the water's edge
                    water.add(rock);
                }
                // Both are transparent and neither writes depth, so the order they
                // are drawn in is the order they stack — and 0.2px of separation is
                // too little to trust a depth sort with. Say it outright.
                land.renderOrder = 1;
                wet.renderOrder = 2;
                water.add(land, wet);
                water.scale.x = 0.001;
                group.add(water);

                // ---- swimmers ----
                const X = new T.Vector3(1, 0, 0), Z = new T.Vector3(0, 0, 1);
                const lie = spec.settleFlat || { face: [0, 1, 0], long: [1, 0, 0] };
                const swimmers = [];
                const board = (mesh, scale, opt) => {
                    if (!mesh) return;
                    group.add(mesh);
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
                        // Run the landscape in from the upstream edge.
                        const grow = Math.max(0.001, easeOutCubic(Math.min(1, t / M.HEAD)));
                        water.scale.x = grow;
                        // Roll the swell downstream — but no more than 60 times a
                        // second. Actors are stepped on a fixed 1/120 clock and up
                        // to 8 times per drawn frame, and reshading and renormalling
                        // the surface eight times to draw it once is seven rivers
                        // nobody sees. (The ground never moves at all.)
                        if (t - lifted >= 1 / 60) { terrain.water.shade(t); lifted = t; }

                        for (const s of swimmers) {
                            const u = (t - s.t0) / s.dur;
                            if (u < 0) continue;
                            const gone = clamp((u - 1) / M.ARRIVE, 0, 1);
                            if (gone >= 1) { s.mesh.visible = false; continue; }
                            s.mesh.visible = true;
                            const sway = Math.sin((t * s.hz + s.phase) * 2 * Math.PI);
                            // On the water, which means through the same lean the
                            // landscape went through — otherwise the cargo floats
                            // where the river would have been if it were flat, and
                            // slides visibly off the downstream bank.
                            const sx2 = s.from + Math.min(1, u) * (s.to - s.from);
                            const sy2 = (s.lane * M.LANE + sway * M.SWAY) * width;
                            place(sx2, sy2, M.BANK.WATER + RIVER_WAVE(sx2, sy2, t, M), swimAt, 0);
                            s.mesh.position.set(swimAt[0], swimAt[1], M.Z_SWIM + s.z);
                            spin.setFromAxisAngle(Z, s.spin * t);
                            roll.setFromAxisAngle(X, s.roll * sway);
                            s.mesh.quaternion.copy(s.base).premultiply(spin).premultiply(roll);
                            // Into the winner's stack: it shrinks away as it lands
                            // rather than stopping dead on top of their avatar.
                            s.mesh.scale.setScalar(s.scale * (1 - 0.4 * gone));
                            if (gone > 0) setAlpha(s.mesh, 1 - gone);
                        }

                        const left = M.LIFE - t;
                        if (left <= 0) return false;
                        if (left < M.FADE) {
                            const a = left / M.FADE;
                            landMat.opacity = a;
                            waterMat.opacity = a;
                            for (const s of swimmers) {
                                const u = (t - s.t0) / s.dur;
                                const gone = clamp((u - 1) / M.ARRIVE, 0, 1);
                                setAlpha(s.mesh, (1 - gone) * a);
                            }
                        }
                        return true;
                    },
                    // coin3d frees the materials it can see; the lattices and the
                    // stones are built per river and are this actor's own to free.
                    dispose() {
                        terrain.land.geo.dispose();
                        terrain.water.geo.dispose();
                        if (terrain.rock) terrain.rock.dispose();
                        if (terrain.cap) terrain.cap.dispose();
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

        const actor = motion.build(T, { key: key, to: to, from: from, felt: felt, dir: dir }, spec, o);
        if (!actor) return false;
        if (!GPE_COIN.addActor(actor)) return false;
        capLive(key, spec, actor);
        return true;
    }

    window.GPE_PROPS = {
        toss: toss,
        ready: ready,
        has: (key) => !!CATALOG[key],
        // Menu data for content.js, so the item list has one home rather than two.
        catalog: CATALOG,
        order: ORDER.slice(),
        isRunning: () => Object.keys(live).some((k) => live[k].some((a) => a.object3D && a.object3D.parent)),
    };
})();
