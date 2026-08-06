/*
 * beer3d.js — slide a beer across the table to another player.
 *
 * Not a throw. The chip is launched, tumbles and bounces (coin3d.js); a beer is
 * SLID: it stays upright the whole way, travels in a straight line across the
 * felt from the sender's rail to the target's, decelerates like something heavy
 * on a smooth surface, and then sits on the rail for ten seconds before fading.
 *
 * So it doesn't use coin3d's ballistic phases at all — it registers as an
 * "actor" instead (GPE_COIN.addActor), which buys the shared WebGL layer, camera
 * and fixed-step clock while owning its own motion. One canvas, one render loop,
 * whatever we add later.
 *
 * The model (assets/models/beer.glb) is normalized once at load: centred, its
 * long axis stood up, tilted back to sit on the table, scaled to BEER_H on screen,
 * and yawed so the handle points out to the right rather than at the camera — the
 * handle sits on the model's local +Z, which in this layer's screen-space
 * convention points straight out of the display and reads as invisible.
 *
 * Exposes window.GPE_BEER = { toss, ready, isRunning, disable }. toss() keeps the
 * (fromRect, toRect, tableRect, opts) shape GPE_COIN.toss uses so content.js's
 * step dispatcher doesn't branch per item.
 *
 * Loaded after vendor/three.iife.js (THREE, incl. GLTFLoader) and coin3d.js.
 */
(function () {
    "use strict";

    const BEER_H = 42;          // size on screen, CSS px, measured not assumed
    const MODEL = "assets/models/beer.glb";

    // Tilt the glass so it sits on the table the way the table is drawn, instead of
    // standing bolt upright facing the camera like a sprite.
    //
    // The geometrically exact match is table3d.js's ELEV_DEG = 64 (90 = straight
    // down), which it measures against the site's painted art: an upright object
    // under that view foreshortens to cos(64°) ≈ 0.44 of its height with its top
    // opened to sin(64°) ≈ 0.90 of a full circle. Rendered, that reads as a squat
    // puck — technically right, and too much. This is about two thirds of it, which
    // keeps the rim and the beer surface in view and rounds the base into an
    // ellipse while leaving the glass recognisably a glass.
    //
    // So this is deliberately NOT tied to ELEV_DEG. It's a look, chosen by eye
    // against the real table; the derivation above is only what bounds it.
    const TILT_DEG = 43;

    // Slide: fast off the rail, then coasting to a stop.
    const SLIDE_SPEED = 620;    // px/s the slide aims for; sets the duration
    const SLIDE_MIN = 0.45, SLIDE_MAX = 1.5;  // seconds, whatever the distance
    const REST_MS = 10000;      // sits on the rail this long (the whole point)
    const FADE_MS = 900;
    const RAIL_OUT = 1.06;      // how far past the felt edge the rail sits (fraction)
    const MAX_BEERS = 6;
    const LOAD_TIMEOUT_MS = 8000;   // a load that never calls back must not hang callers

    // Same resolution content.js and table3d.js use: as an extension there is no
    // currentScript and assets hang off the extension root; in the site-hosted
    // build we're a plain script under <base>/3d/, one level below the assets.
    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function assetUrl(path) {
        if (SELF_SRC) {
            try { return new URL("../" + path, SELF_SRC).href; } catch (e) { /* fall through */ }
        }
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    let template = null;
    let loading = null;
    let broken = false;
    let live = [];   // sliding beers, oldest first

    // Load once, then hand out clones. Resolves false rather than throwing: a
    // missing model degrades to "the beer item does nothing", never to a broken
    // sequence — content.js awaits this before playing the step.
    function ready() {
        if (template) return Promise.resolve(true);
        if (broken) return Promise.resolve(false);
        if (loading) return loading;
        const T = window.THREE;
        const url = assetUrl(MODEL);
        if (!T || !T.GLTFLoader || !url) {
            broken = true;
            // Say which precondition failed. A bare false here cost real debugging
            // time: the item silently did nothing, with no way to tell a stale
            // three.js bundle (GLTFLoader is an addon, absent from a bundle built
            // from the plain `export * from "three"` entry) from a bad asset URL.
            console.warn("[gpe] beer3d: unavailable — " + (
                !T ? "THREE is not loaded"
                    : !T.GLTFLoader ? "this three.js bundle has no GLTFLoader (see vendor/README.md)"
                        : "could not resolve a URL for " + MODEL));
            return Promise.resolve(false);
        }
        loading = new Promise((resolve) => {
            // A deadline, because "never settles" is a real failure mode and the
            // worst possible one: whoever is waiting on this promise waits forever.
            // GLTFLoader is not guaranteed to call back at all (a request blocked
            // rather than failed produces neither onLoad nor onError), and a caller
            // awaiting a promise that never settles takes its own bookkeeping down
            // with it. Resolve false and let the next throw try again.
            const deadline = setTimeout(() => {
                if (template) return;
                loading = null;   // self-healing: a later throw retries the load
                console.warn("[gpe] beer3d: timed out loading " + MODEL + " (no response after "
                    + LOAD_TIMEOUT_MS + "ms) — the beer will do nothing until it loads");
                resolve(false);
            }, LOAD_TIMEOUT_MS);
            new T.GLTFLoader().load(
                url,
                (gltf) => {
                    clearTimeout(deadline);
                    try {
                        template = normalize(T, gltf.scene);
                        resolve(true);
                    } catch (e) {
                        broken = true;
                        console.warn("[gpe] beer3d: could not prepare the model", e);
                        resolve(false);
                    }
                },
                null,
                (err) => {
                    clearTimeout(deadline);
                    broken = true;
                    console.warn("[gpe] beer3d: could not load " + MODEL, err);
                    resolve(false);
                }
            );
        });
        return loading;
    }

    // Centre it, stand it up, size it, and turn the handle to the side.
    //
    // Measured rather than hardcoded, because the model is an obj2gltf export with
    // per-node scales and quantized positions — none of its numbers are readable
    // from the file. The mug's own dimensions are 0.169 x 0.242 x 0.196: tallest on
    // Y (so Y is up), and wider on Z than X because the handle sticks out along Z.
    // Screen-space here is world X-Y with the camera looking down -Z, so a +Z
    // handle points at the viewer and vanishes; yawing +90° about Y swings it to
    // screen right. Swap a differently-built model in and the measurement still
    // holds, but re-check the handle axis.
    function normalize(T, scene) {
        const box = new T.Box3().setFromObject(scene);
        const size = box.getSize(new T.Vector3());
        const centre = box.getCenter(new T.Vector3());
        scene.position.sub(centre);   // spin and scale about its own middle

        const axes = [size.x, size.y, size.z];
        const up = axes.indexOf(Math.max.apply(null, axes)); // tallest axis = upright
        const stand = new T.Group();
        stand.add(scene);
        if (up === 0) stand.rotation.z = Math.PI / 2;        // X -> Y
        else if (up === 2) stand.rotation.x = -Math.PI / 2;  // Z -> Y

        // With it standing, the handle is on the horizontal axis that isn't the
        // height — model-local +Z, which in this layer points straight at the
        // camera and vanishes. Yaw it into the screen plane. -90° rather than +90°:
        // both put it "out the side", and this is the one that puts it on the
        // RIGHT (checked on the table — +90° reads as left).
        const yaw = new T.Group();
        yaw.add(stand);
        yaw.rotation.y = -Math.PI / 2;

        const scale = BEER_H / (Math.max.apply(null, axes) || 1);
        yaw.scale.setScalar(scale);

        const tilt = new T.Group();
        tilt.add(yaw);
        tilt.rotation.x = TILT_DEG * Math.PI / 180;   // top toward the viewer

        const outer = new T.Group();
        outer.add(tilt);
        // Size to what is actually SEEN. The tilt foreshortens the glass to ~44%
        // of its height, so scaling by the model's own height would leave a stub;
        // measure the tilted projection and bring that up to BEER_H instead.
        outer.updateMatrixWorld(true);
        const shown = new T.Box3().setFromObject(outer).getSize(new T.Vector3());
        const tallest = Math.max(shown.x, shown.y) || 1;
        outer.scale.setScalar(BEER_H / tallest);
        return outer;
    }

    // A fresh clone per slide. Materials are cloned too: each beer fades on its
    // own, Object3D.clone() shares materials by default, and disposing a clone's
    // materials would otherwise take the template's with them. The authored
    // opacity is recorded where the fade can find it, so the glass stays glass.
    function instance(T) {
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
                c.transparent = true;             // needed for the fade regardless
                c.depthWrite = c.userData.gpeBaseOpacity >= 1;
                return c;
            });
            n.material = Array.isArray(n.material) ? cloned : cloned[0];
        });
        return copy;
    }

    // A point out on the rail, in the direction of an avatar from the table's
    // centre. feltBounds comes from coin3d so the felt geometry stays measured in
    // exactly one place.
    function railPoint(felt, towardX, towardY) {
        const dx = towardX - felt.cx, dy = towardY - felt.cy;
        const len = Math.hypot(dx / felt.ax, dy / felt.by) || 1;
        const k = RAIL_OUT / len;
        return { x: felt.cx + dx * k, y: felt.cy + dy * k };
    }

    function centreOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    // Slide from the sender's rail to the target's, stay put, fade.
    function slide(T, felt, start, end, opts) {
        const mesh = instance(T);
        if (!mesh) return null;

        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        const dur = clamp(dist / SLIDE_SPEED, SLIDE_MIN, SLIDE_MAX);
        let t = 0, resting = 0, arrived = false, alpha = 1;

        const actor = {
            object3D: mesh,
            step(dt) {
                if (t < dur) {
                    t = Math.min(dur, t + dt);
                    const e = easeOutCubic(t / dur);   // coasts to a stop
                    mesh.position.set(
                        start.x + (end.x - start.x) * e,
                        -(start.y + (end.y - start.y) * e),
                        3
                    );
                    if (t >= dur && !arrived) {
                        arrived = true;
                        if (opts.onArrive) { try { opts.onArrive(); } catch (e) {} }
                    }
                    return true;
                }
                resting += dt * 1000;
                if (resting <= REST_MS) return true;   // ten seconds on the rail
                alpha = 1 - (resting - REST_MS) / FADE_MS;
                if (alpha <= 0) return false;          // finished: coin3d disposes us
                mesh.traverse((n) => {
                    const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
                    for (const m of mats) {
                        const base = (m.userData && typeof m.userData.gpeBaseOpacity === "number")
                            ? m.userData.gpeBaseOpacity : 1;
                        m.opacity = base * alpha;
                    }
                });
                return true;
            },
        };
        // Start where it starts, so frame one doesn't flash at the origin.
        mesh.position.set(start.x, -start.y, 3);
        return actor;
    }

    // Same signature as GPE_COIN.toss so the caller doesn't branch on the item.
    // False means "not ready" — content.js awaits ready() first, which is what
    // keeps a scripted sequence's timing honest.
    let warned = false;
    function warnOnce(why) {
        if (warned) return false;
        warned = true;
        console.warn("[gpe] beer3d: nothing to slide — " + why);
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
        if (!tableRect || !tableRect.width) return warnOnce("the table is not laid out");
        const o = (typeof opts === "function") ? { onArrive: opts } : (opts || {});

        const felt = GPE_COIN.feltBounds(tableRect);
        if (!felt) return false;   // table not laid out yet
        const to = centreOf(toRect);
        const end = railPoint(felt, to.x, to.y);
        // No sender rect (they're off-screen, or it's me watching): come in from
        // the near rail instead of from nowhere.
        const start = (fromRect && fromRect.width)
            ? railPoint(felt, centreOf(fromRect).x, centreOf(fromRect).y)
            : { x: felt.cx, y: felt.cy + felt.by * RAIL_OUT };

        const actor = slide(T, felt, start, end, o);
        if (!actor) return false;
        if (!GPE_COIN.addActor(actor)) return false;
        live.push(actor);
        // A tableful of beers resting for ten seconds each would bury the cards.
        live = live.filter((a) => a.object3D && a.object3D.parent);
        while (live.length > MAX_BEERS) {
            const oldest = live.shift();
            if (oldest && oldest.step) oldest.step = () => false;  // retire on the next tick
        }
        return true;
    }

    function register() {
        return !!(window.GPE_COIN && typeof GPE_COIN.addActor === "function");
    }

    window.GPE_BEER = {
        toss,
        ready,
        isRunning: () => live.some((a) => a.object3D && a.object3D.parent),
        disable: () => { live = []; if (window.GPE_COIN) GPE_COIN.disable(); },
        _registered: register(),
    };
})();
