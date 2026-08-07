/*
 * glove3d.js — slap another player across the face with an open hand.
 *
 * A gloved hand swings in from the side, sweeps across the target's avatar, and
 * connects — at which point the avatar takes the same recoil a chip gives it (the
 * onHit callback fires content.js's flinch). Then the hand follows through past
 * the face and fades. It never lands on the felt; the whole thing is the slap.
 *
 * Like the beer and the flower, the motion isn't ballistic, so it registers as an
 * "actor" (GPE_COIN.addActor) to share coin3d's WebGL layer, camera and clock
 * while driving its own swing.
 *
 * The model (assets/models/glove.glb) is a flat open hand modelled lying down
 * (palm on ±Y, fingers along +Z). Standing it up with a -90° pitch turns the palm
 * to face the camera with the fingers pointing up — the pose it slaps in. Measured
 * so a re-export still lands right.
 *
 * Exposes window.GPE_GLOVE = { toss, ready, isRunning, disable }, keeping the
 * (fromRect, toRect, tableRect, opts) shape so content.js's dispatcher doesn't
 * branch per item. fromRect only sets which way the hand swings in from.
 *
 * Loaded after vendor/three.iife.js (THREE, incl. GLTFLoader) and coin3d.js.
 */
(function () {
    "use strict";

    const GLOVE_H = 82;         // size on screen, CSS px, of the tallest visible extent
    const MODEL = "assets/models/glove.glb";
    const POSE_X = -Math.PI / 2;  // pitch the lying-down hand up to face the camera

    // The swing. A fast sweep across the face, a short follow-through past it, then
    // a fade — the whole slap is well under a second.
    const REACH = 104;          // px the hand starts back from the face along the swing
    const PAST = 52;            // px it carries on past the face on the follow-through
    const SWING = 0.75;         // s: back-swing point to contact (accelerating in)
    const FOLLOW = 0.13;        // s: contact to full follow-through (decelerating)
    const FADE = 0.75;          // s: fading out where the follow-through left it
    const ROLL = 0.9;           // rad the hand rolls through as it swings (+ before, - after)
    const Z = 8;                // depth: over the avatar it's slapping
    const MAX_GLOVES = 4;
    const LOAD_TIMEOUT_MS = 8000;

    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function assetUrl(path) {
        if (SELF_SRC) {
            try { return new URL("../" + path, SELF_SRC).href; } catch (e) { /* fall through */ }
        }
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const easeInQuad = (t) => t * t;
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const lerp = (a, b, t) => a + (b - a) * t;

    let template = null;
    let loading = null;
    let broken = false;
    let live = [];

    function ready() {
        if (template) return Promise.resolve(true);
        if (broken) return Promise.resolve(false);
        if (loading) return loading;
        const T = window.THREE;
        const url = assetUrl(MODEL);
        if (!T || !T.GLTFLoader || !url) {
            broken = true;
            console.warn("[gpe] glove3d: unavailable — " + (
                !T ? "THREE is not loaded"
                    : !T.GLTFLoader ? "this three.js bundle has no GLTFLoader (see vendor/README.md)"
                        : "could not resolve a URL for " + MODEL));
            return Promise.resolve(false);
        }
        loading = new Promise((resolve) => {
            const deadline = setTimeout(() => {
                if (template) return;
                loading = null;
                console.warn("[gpe] glove3d: timed out loading " + MODEL + " (no response after "
                    + LOAD_TIMEOUT_MS + "ms) — the glove will do nothing until it loads");
                resolve(false);
            }, LOAD_TIMEOUT_MS);
            new T.GLTFLoader().load(
                url,
                (gltf) => {
                    clearTimeout(deadline);
                    try { template = normalize(T, gltf.scene); resolve(true); }
                    catch (e) { broken = true; console.warn("[gpe] glove3d: could not prepare the model", e); resolve(false); }
                },
                null,
                (err) => { clearTimeout(deadline); broken = true; console.warn("[gpe] glove3d: could not load " + MODEL, err); resolve(false); }
            );
        });
        return loading;
    }

    // Centre it, pitch it up so the palm faces the camera, and size it to what's
    // actually SEEN. The outer group carries the baked scale so the swing can add a
    // little grow-on-contact without undoing the fit.
    function normalize(T, scene) {
        const box = new T.Box3().setFromObject(scene);
        const centre = box.getCenter(new T.Vector3());
        scene.position.sub(centre);

        const posed = new T.Group();
        posed.add(scene);
        posed.rotation.x = POSE_X;

        const outer = new T.Group();
        outer.add(posed);
        outer.updateMatrixWorld(true);
        const shown = new T.Box3().setFromObject(outer).getSize(new T.Vector3());
        const tallest = Math.max(shown.x, shown.y) || 1;
        outer.scale.setScalar(GLOVE_H / tallest);
        outer.userData.gpeBaseScale = outer.scale.x;
        return outer;
    }

    function instance(T) {
        if (!template) return null;
        const copy = template.clone(true);
        copy.userData = Object.assign({}, template.userData);
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

    // Sweep in along `dir`, connect at the face, follow through past it, fade.
    function swing(T, face, dir, opts) {
        const mesh = instance(T);
        if (!mesh) return null;
        const baseScale = (mesh.userData && mesh.userData.gpeBaseScale) || mesh.scale.x || 1;

        const start = { x: face.x - dir.x * REACH, y: face.y - dir.y * REACH };
        const end = { x: face.x + dir.x * PAST, y: face.y + dir.y * PAST };
        let t = 0, hit = false;

        const put = (x, y, roll, scale) => {
            mesh.position.set(x, -y, Z);
            mesh.rotation.set(0, 0, roll);          // roll is applied on top of the pitched pose within `posed`
            mesh.scale.setScalar(baseScale * scale);
        };

        const actor = {
            object3D: mesh,
            step(dt) {
                t += dt;
                if (t <= SWING) {
                    const p = easeInQuad(clamp(t / SWING, 0, 1)); // accelerate into the slap
                    put(lerp(start.x, face.x, p), lerp(start.y, face.y, p),
                        lerp(ROLL, 0, p), lerp(0.82, 1.06, p));   // grows into contact
                    return true;
                }
                if (!hit) {
                    hit = true;
                    if (opts.onHit) { try { opts.onHit(); } catch (e) {} }
                }
                if (t <= SWING + FOLLOW) {
                    const p = easeOutCubic(clamp((t - SWING) / FOLLOW, 0, 1)); // decelerate past
                    put(lerp(face.x, end.x, p), lerp(face.y, end.y, p),
                        lerp(0, -ROLL, p), lerp(1.06, 1, p));
                    return true;
                }
                const fp = (t - SWING - FOLLOW) / FADE;
                if (fp >= 1) return false;
                put(end.x, end.y, -ROLL, 1);
                setAlpha(mesh, 1 - fp);
                return true;
            },
        };
        put(start.x, start.y, ROLL, 0.82);   // no frame-one flash at the origin
        return actor;
    }

    let warned = false;
    function warnOnce(why) {
        if (warned) return false;
        warned = true;
        console.warn("[gpe] glove3d: nothing to swing — " + why);
        return false;
    }

    function toss(fromRect, toRect, tableRect, opts) {
        const T = window.THREE;
        if (!T) return warnOnce("THREE is not loaded");
        if (!template) return warnOnce("the model has not loaded yet");
        if (!window.GPE_COIN || typeof GPE_COIN.addActor !== "function") {
            return warnOnce("coin3d is missing addActor (stale 3d/coin3d.js?)");
        }
        if (!toRect || !toRect.width) return warnOnce("the target has no on-screen avatar");
        const o = (typeof opts === "function") ? { onHit: opts } : (opts || {});

        const face = centreOf(toRect);
        // Swing in from the thrower's side if we know it, otherwise sweep in from
        // the lower right — a natural backhand direction on this near-top-down view.
        let dir;
        if (fromRect && fromRect.width) {
            const f = centreOf(fromRect);
            const dx = face.x - f.x, dy = face.y - f.y, len = Math.hypot(dx, dy) || 1;
            dir = { x: dx / len, y: dy / len };
        } else {
            dir = { x: -0.7, y: -0.72 };
        }

        const actor = swing(T, face, dir, o);
        if (!actor) return false;
        if (!GPE_COIN.addActor(actor)) return false;
        live.push(actor);
        live = live.filter((a) => a.object3D && a.object3D.parent);
        while (live.length > MAX_GLOVES) {
            const oldest = live.shift();
            if (oldest && oldest.step) oldest.step = () => false;
        }
        return true;
    }

    window.GPE_GLOVE = {
        toss,
        ready,
        isRunning: () => live.some((a) => a.object3D && a.object3D.parent),
        disable: () => { live = []; if (window.GPE_COIN) GPE_COIN.disable(); },
        _registered: !!(window.GPE_COIN && typeof GPE_COIN.addActor === "function"),
    };
})();
