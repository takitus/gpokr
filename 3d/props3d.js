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
        // These four share the chip's throw animation outright, and differ only in
        // the model and the sound — which is exactly the split this file exists for.
        // height here is the bounding-SPHERE diameter (see normalize), so one number
        // means the same apparent size for every one of them, whatever their shape.
        // The chip they fly alongside is 26px across, for reference.
        acorn:  { model: "acorn.glb",  height: 58, motion: "throw", maxLive: 8, glyph: "🌰", label: "acorn",  cooldownMs: 2000, sound: "check", launchSound: "fold" },
        peanut: { model: "peanut.glb", height: 58, motion: "throw", maxLive: 8, glyph: "🥜", label: "peanut", cooldownMs: 2000, sound: "check", launchSound: "fold" },
        cashew: { model: "cashew.glb", height: 58, motion: "throw", maxLive: 8, glyph: "🥜", label: "cashew", cooldownMs: 2000, sound: "check", launchSound: "fold" },
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
            onTemplate(T, key) {
                if (!window.GPE_COIN || typeof GPE_COIN.registerProjectile !== "function") return;
                GPE_COIN.registerProjectile(key, {
                    make: (TT) => instance(TT, key),
                    // Comes to rest lying along the direction of travel. World y is
                    // screen y flipped, hence the negated dy.
                    settlePose(TT, c) {
                        const dx = c.v.x, dy = -c.v.y;
                        const len = Math.hypot(dx, dy);
                        const dir = len > 1 ? new TT.Vector3(dx / len, dy / len, 0) : new TT.Vector3(1, 0, 0);
                        return new TT.Quaternion().setFromUnitVectors(new TT.Vector3(0, 1, 0), dir);
                    },
                });
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
