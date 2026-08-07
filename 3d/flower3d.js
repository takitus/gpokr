/*
 * flower3d.js — drift a flower down in front of another player.
 *
 * Not a throw and not a slide: the flower simply appears above the target's seat
 * and FLOATS straight down, swaying side to side and rocking like a petal caught
 * in the air, then comes to rest just in front of them and fades. A soft, friendly
 * gesture — the opposite of the chip's ballistic smack.
 *
 * Like the beer, it isn't ballistic, so it doesn't borrow coin3d's flight phases.
 * It registers as an "actor" (GPE_COIN.addActor) to share the one WebGL layer,
 * camera and fixed-step clock while owning its own motion.
 *
 * The model (assets/models/flower.glb) is a bouquet already modelled upright —
 * stems on -Y, blooms on +Y — and facing the layer's camera (which looks down
 * -Z). So normalize only centres and sizes it; no standing-up or handle-yaw like
 * the beer needs. Measured, not assumed, so a re-export still lands right.
 *
 * Exposes window.GPE_FLOWER = { toss, ready, isRunning, disable }. toss() keeps
 * the (fromRect, toRect, tableRect, opts) shape GPE_COIN.toss uses so content.js's
 * step dispatcher doesn't branch per item. fromRect is ignored — a flower has no
 * origin, it just descends onto the target.
 *
 * Loaded after vendor/three.iife.js (THREE, incl. GLTFLoader) and coin3d.js.
 */
(function () {
    "use strict";

    const FLOWER_H = 96;        // size on screen, CSS px, of the tallest visible extent
    const MODEL = "assets/models/flower.glb";

    // The fall. FALL_H is kept modest on purpose: the top-row seats sit near the
    // top of the game window, so a tall drop would spend most of its life off the
    // top of the screen with only the stem peeking in. This starts it just above
    // the seat and lets the whole descent read.
    const FALL_H = 155;         // px above the resting spot it starts from
    const FALL_DUR = 3.0;       // seconds to drift all the way down (slow, on purpose)
    const FRONT_STEP = 42;      // px toward the felt centre — "in front of" the player, clear of their panel
    const REST_MS = 1500;       // sits in front of them this long before fading
    const FADE_MS = 1100;
    const Z = 6;                // depth: in front of chips/beer if they overlap

    // The sway. A pendulum: the horizontal drift and the roll share one sine so the
    // bouquet leans into the direction it's swinging, the way a falling petal does.
    const SWAY_AMP = 30;        // px of side-to-side drift
    const SWAY_PERIOD = 1.7;    // seconds per full left-right-left
    const ROCK = 0.20;          // rad of roll at the extremes of the sway
    const YAW_RATE = 0.5;       // rad/s of slow turn, so it isn't a flat cut-out

    const MAX_FLOWERS = 5;
    const LOAD_TIMEOUT_MS = 8000;

    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function assetUrl(path) {
        if (SELF_SRC) {
            try { return new URL("../" + path, SELF_SRC).href; } catch (e) { /* fall through */ }
        }
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    let template = null;
    let loading = null;
    let broken = false;
    let live = [];

    // Load once, hand out clones. Resolves false rather than throwing: a missing
    // model degrades to "the flower item does nothing", never a broken sequence.
    function ready() {
        if (template) return Promise.resolve(true);
        if (broken) return Promise.resolve(false);
        if (loading) return loading;
        const T = window.THREE;
        const url = assetUrl(MODEL);
        if (!T || !T.GLTFLoader || !url) {
            broken = true;
            console.warn("[gpe] flower3d: unavailable — " + (
                !T ? "THREE is not loaded"
                    : !T.GLTFLoader ? "this three.js bundle has no GLTFLoader (see vendor/README.md)"
                        : "could not resolve a URL for " + MODEL));
            return Promise.resolve(false);
        }
        loading = new Promise((resolve) => {
            const deadline = setTimeout(() => {
                if (template) return;
                loading = null;   // self-healing: a later throw retries the load
                console.warn("[gpe] flower3d: timed out loading " + MODEL + " (no response after "
                    + LOAD_TIMEOUT_MS + "ms) — the flower will do nothing until it loads");
                resolve(false);
            }, LOAD_TIMEOUT_MS);
            new T.GLTFLoader().load(
                url,
                (gltf) => {
                    clearTimeout(deadline);
                    try { template = normalize(T, gltf.scene); resolve(true); }
                    catch (e) { broken = true; console.warn("[gpe] flower3d: could not prepare the model", e); resolve(false); }
                },
                null,
                (err) => { clearTimeout(deadline); broken = true; console.warn("[gpe] flower3d: could not load " + MODEL, err); resolve(false); }
            );
        });
        return loading;
    }

    // Centre it and size it to what's actually SEEN by the layer's camera (screen
    // X-Y). The model already stands upright and faces the camera, so — unlike the
    // beer — there's nothing to rotate; the extra group is only there to carry the
    // baked scale, which the animation reads so it can grow/shrink without undoing
    // the fit.
    function normalize(T, scene) {
        const box = new T.Box3().setFromObject(scene);
        const centre = box.getCenter(new T.Vector3());
        scene.position.sub(centre);

        const outer = new T.Group();
        outer.add(scene);
        outer.updateMatrixWorld(true);
        const shown = new T.Box3().setFromObject(outer).getSize(new T.Vector3());
        const tallest = Math.max(shown.x, shown.y) || 1;
        outer.scale.setScalar(FLOWER_H / tallest);
        outer.userData.gpeBaseScale = outer.scale.x;
        return outer;
    }

    // A fresh clone per drift, with its own material clones so each fades alone.
    function instance(T) {
        if (!template) return null;
        const copy = template.clone(true);
        copy.userData = Object.assign({}, template.userData); // carry gpeBaseScale
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
        return copy;
    }

    function centreOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    function setAlpha(mesh, alpha) {
        mesh.traverse((n) => {
            const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
            for (const m of mats) {
                const base = (m.userData && typeof m.userData.gpeBaseOpacity === "number") ? m.userData.gpeBaseOpacity : 1;
                m.opacity = base * alpha;
            }
        });
    }

    // Descend from FALL_H above the resting spot to the spot itself, swaying the
    // whole way, then rest and fade.
    function drift(T, base, opts) {
        const mesh = instance(T);
        if (!mesh) return null;
        const baseScale = (mesh.userData && mesh.userData.gpeBaseScale) || mesh.scale.x || 1;

        const endY = base.y, startY = base.y - FALL_H, baseX = base.x;
        const phase = Math.random() * Math.PI * 2;         // vary so a pair don't sway in lockstep
        const spin = Math.random() < 0.5 ? -1 : 1;
        let t = 0, resting = 0, arrived = false;

        const poseAt = (tt) => {
            const sway = Math.sin(tt / SWAY_PERIOD * 2 * Math.PI + phase);
            mesh.rotation.set(0, spin * tt * YAW_RATE, ROCK * sway);
            return baseX + SWAY_AMP * sway;
        };

        const actor = {
            object3D: mesh,
            step(dt) {
                if (t < FALL_DUR) {
                    t = Math.min(FALL_DUR, t + dt);
                    const p = t / FALL_DUR;
                    const x = poseAt(t);
                    mesh.position.set(x, -(startY + (endY - startY) * p), Z);
                    if (t >= FALL_DUR && !arrived) {
                        arrived = true;
                        if (opts.onArrive) { try { opts.onArrive(); } catch (e) {} }
                    }
                    return true;
                }
                // Keep swaying, ever so slightly, while it rests — then fade.
                resting += dt * 1000;
                const x = poseAt(FALL_DUR + resting / 1000 * 0.15); // near-still
                mesh.position.set(x, -endY, Z);
                if (resting <= REST_MS) return true;
                const alpha = 1 - (resting - REST_MS) / FADE_MS;
                if (alpha <= 0) return false;
                setAlpha(mesh, alpha);
                return true;
            },
        };
        mesh.position.set(poseAt(0), -startY, Z);   // no frame-one flash at the origin
        return actor;
    }

    let warned = false;
    function warnOnce(why) {
        if (warned) return false;
        warned = true;
        console.warn("[gpe] flower3d: nothing to drift — " + why);
        return false;
    }

    // Same signature as GPE_COIN.toss; fromRect is unused (a flower has no origin).
    function toss(fromRect, toRect, tableRect, opts) {
        const T = window.THREE;
        if (!T) return warnOnce("THREE is not loaded");
        if (!template) return warnOnce("the model has not loaded yet");
        if (!window.GPE_COIN || typeof GPE_COIN.addActor !== "function") {
            return warnOnce("coin3d is missing addActor (stale 3d/coin3d.js?)");
        }
        if (!toRect || !toRect.width) return warnOnce("the target has no on-screen avatar");
        const o = (typeof opts === "function") ? { onArrive: opts } : (opts || {});

        // Rest right in front of the player: a short step from their seat toward
        // the middle of the table, so the bouquet lands between them and the felt
        // rather than on top of their face.
        const to = centreOf(toRect);
        let base = { x: to.x, y: to.y };
        const felt = GPE_COIN.feltBounds(tableRect);
        if (felt) {
            const dx = felt.cx - to.x, dy = felt.cy - to.y, len = Math.hypot(dx, dy) || 1;
            base = { x: to.x + dx / len * FRONT_STEP, y: to.y + dy / len * FRONT_STEP };
        }

        const actor = drift(T, base, o);
        if (!actor) return false;
        if (!GPE_COIN.addActor(actor)) return false;
        live.push(actor);
        live = live.filter((a) => a.object3D && a.object3D.parent);
        while (live.length > MAX_FLOWERS) {
            const oldest = live.shift();
            if (oldest && oldest.step) oldest.step = () => false; // retire on the next tick
        }
        return true;
    }

    window.GPE_FLOWER = {
        toss,
        ready,
        isRunning: () => live.some((a) => a.object3D && a.object3D.parent),
        disable: () => { live = []; if (window.GPE_COIN) GPE_COIN.disable(); },
        _registered: !!(window.GPE_COIN && typeof GPE_COIN.addActor === "function"),
    };
})();
