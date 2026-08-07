/*
 * coin3d.js — toss a 3D chip at another player.
 *
 * A click on the button in a seat's avatar corner launches a real 3D chip from
 * your own seat, arcing across the screen; it bounces off the target's avatar
 * and drops onto the felt just in front of them, where it barely bounces before
 * falling flat.
 *
 * The chip itself is chips3d.js's artwork (GPE_CHIPS.art) — the same
 * $1/$5/$25/$100/$500/$2.5K/$10K denominations the chip portal drops, drawn to match
 * the site's own chip art — so there is only ever one set of chips to keep in
 * step. Add a denomination there and it appears here without any change.
 *
 * Rendered into one full-viewport WebGL layer (canvas, pointer-events:none) that
 * sits over the page. Avatars and the table live in different corners of the GWT
 * DOM, so the throw is simulated in SCREEN space rather than table space: the
 * page plane is the ground (x, y in CSS px, y down), plus a `h` height axis that
 * is drawn by lifting the chip up-screen. That makes the whole viewport reachable
 * without caring where any element sits in the document, and it matches how the
 * near-top-down table already reads.
 *
 * (The file and its "coin" identifiers predate the switch to real chip art; the
 * thing it throws is a gpokr chip.)
 *
 * Loaded as a content script after vendor/three.iife.js and chips3d.js; exposes
 * window.GPE_COIN = { toss, isRunning, disable }. Purely cosmetic and local —
 * nothing is sent to the site, and the other player sees nothing.
 */
(function () {
    "use strict";

    // ---------- chip ----------
    const COIN_R = 13;           // radius, CSS px (thickness follows chips3d's proportions)
    const MAX_COINS = 8;         // older ones are dropped rather than piling up

    // ---------- flight ----------
    const G = 2600;              // px/s^2 (screen-space "gravity")
    const SPEED = 1000;          // px/s the throw aims for; sets the flight time
    const T_MIN = 0.3, T_MAX = 0.8;
    const RICOCHET = 700;        // px/s the bounce off the avatar aims for
    const RIC_MIN = 0.25, RIC_MAX = 0.6;  // and the flight time it's held to
    // The chip drops just in front of whoever it hit rather than carrying on to
    // the middle of the table: a short step from their seat toward the felt.
    const DROP_DIST = 46;        // px in front of the avatar
    const DROP_SCATTER = 12;     // ± jitter, so repeat throws don't stack exactly
    // Barely bounces — it lands, gives one small hop and lies down where it fell.
    const REST = 0.22;           // bounce restitution on the felt
    const FRICTION = 0.28;       // horizontal speed kept per felt bounce
    const SETTLE_VH = 70;        // below this bounce speed the chip lies down
    const SLIDE_DECAY = 12;      // e-folds/s of the sliding skid once it's down
    const FLATTEN_MS = 320;      // wobble/fall-flat time
    const REST_MS = 1900;        // time lying on the felt before fading
    const FADE_MS = 700;

    const TUMBLE = [9, 15];      // end-over-end rate range, rad/s
    const SPIN_SETTLE = 2.6;     // rad of face-spin bled off while it lies down

    // ---------- felt (art-space fractions, as measured in table3d.js) ----------
    const ART_W = 790;
    const FELT_CX_PX = 395, FELT_CY_PX = 190;
    const FELT_HALF_W_PX = 290, FELT_HALF_D_PX = 102;
    const FELT_EDGE = 0.92;      // furthest the chip's CENTER may rest, so its body stays on
    const RAIL_REST = 0.35;      // how much of the outward speed the rail gives back

    const STEP = 1 / 120;        // fixed physics step
    const MAX_SUBSTEPS = 8;

    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    let session = null;
    let broken = false;

    // ---------- textures ----------
    // Soft round blob for the ground shadow (alpha falls off to nothing).
    function shadowTexture(T) {
        const S = 128, R = S / 2;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const g = cv.getContext("2d");
        const grad = g.createRadialGradient(R, R, 0, R, R, R);
        grad.addColorStop(0, "rgba(0, 0, 0, 0.85)");
        grad.addColorStop(0.55, "rgba(0, 0, 0, 0.4)");
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, S, S);
        const tex = new T.CanvasTexture(cv);
        return tex;
    }

    // ---------- layer ----------
    // One fixed, click-through canvas over the whole viewport. Everything is
    // drawn in CSS pixels: world x = screen x, world y = -screen y.
    function makeLayer() {
        const canvas = document.createElement("canvas");
        canvas.id = "gpe-coin-layer";
        document.body.appendChild(canvas);
        return canvas;
    }

    function syncViewport(s) {
        const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
        if (s.vw === w && s.vh === h) return;
        s.vw = w; s.vh = h;
        s.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        s.renderer.setSize(w, h, false);
        const cam = s.camera;
        cam.left = 0; cam.right = w; cam.top = 0; cam.bottom = -h;
        cam.updateProjectionMatrix();
    }

    function buildScene(s) {
        const T = window.THREE;
        s.scene = new T.Scene();
        s.scene.add(new T.AmbientLight(0xffffff, 1.35));
        const key = new T.DirectionalLight(0xfff3d8, 1.5);
        key.position.set(-0.4, 0.7, 1);
        s.scene.add(key);
        const rim = new T.DirectionalLight(0x9fc4ff, 0.5);
        rim.position.set(0.6, -0.5, 0.6);
        s.scene.add(rim);

        s.shadowTex = shadowTexture(T);

        // Same proportions as the chips the portal drops, scaled to CSS px.
        const prop = window.GPE_CHIPS.art.proportions;
        // CylinderGeometry's material groups are [side, top, bottom]; its axis is
        // local +Y, so the base orientation below turns the faces toward us.
        s.coinGeo = new T.CylinderGeometry(
            COIN_R, COIN_R, COIN_R * (prop.h / prop.r), 32, 1);
        s.shadowGeo = new T.PlaneGeometry(COIN_R * 2.4, COIN_R * 2.4);
        s.shadowMat = new T.MeshBasicMaterial({
            map: s.shadowTex, transparent: true, depthWrite: false, opacity: 0.35,
        });
        s.art = [];   // per-denomination { face, rim, faceMat, rimMat }, built on demand
    }

    // Materials for one denomination, minted once and shared by every chip of
    // that value (each thrown chip clones them so it can fade independently).
    // Only lightly metallic: with no environment map in the scene a fully
    // metallic material has no diffuse term and renders near-black, and the
    // emissive copy of the map floors the brightness so the chip keeps its
    // color whichever way it's facing as it tumbles.
    function artFor(s, i) {
        if (s.art[i]) return s.art[i];
        const T = window.THREE;
        const { face, rim, type } = window.GPE_CHIPS.art.textures(T, i);
        const a = {
            face, rim, type,
            faceMat: new T.MeshStandardMaterial({
                map: face, roughness: 0.5, metalness: 0.06, transparent: true,
                emissiveMap: face, emissive: 0xffffff, emissiveIntensity: 0.3,
            }),
            rimMat: new T.MeshStandardMaterial({
                map: rim, roughness: 0.62, metalness: 0.04, transparent: true,
                emissiveMap: rim, emissive: 0xffffff, emissiveIntensity: 0.3,
            }),
        };
        s.art[i] = a;
        return a;
    }

    // ---------- projectiles ----------
    // Everything below this section — the throw arc, the bounce off the avatar,
    // the felt bounces, the skid, the fade — is indifferent to what is being
    // thrown. Only three things are chip-specific: the mesh, the pose it flies
    // in, and the pose it settles into. A projectile registers those and reuses
    // the rest, which is how 3d/beer3d.js adds a bottle without a second copy of
    // the physics.
    const projectiles = Object.create(null);

    function registerProjectile(key, def) {
        if (typeof key === "string" && def && typeof def.make === "function") projectiles[key] = def;
    }

    function projectileFor(kind) { return projectiles[kind] || projectiles.chip; }

    registerProjectile("chip", {
        make(T, s, o) {
            const a = artFor(s, denomIndex(o.denom));
            // CylinderGeometry's groups are [side, top, bottom]; cloned per throw
            // so each chip can fade on its own.
            return new T.Mesh(s.coinGeo, [a.rimMat.clone(), a.faceMat.clone(), a.faceMat.clone()]);
        },
        // Face-on: the disc's axis points at the viewer.
        basePose: (T, q) => q.setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI / 2),
        // Lie flat from wherever the tumble left off — the shortest rotation that
        // turns the disc's own axis back toward the viewer.
        settlePose(T, c) {
            const axis = new T.Vector3(0, 1, 0).applyQuaternion(c.q);
            const fix = new T.Quaternion().setFromUnitVectors(axis, new T.Vector3(0, 0, 1));
            return c.q.clone().premultiply(fix);
        },
    });

    // A projectile is either a Mesh (one material, or an array of them) or a whole
    // Group from a loaded model, so fading and disposal walk it generically.
    // Geometry is shared and deliberately never disposed here — only the
    // per-throw material clones are.
    function eachMaterial(obj, fn) {
        obj.traverse((n) => {
            const m = n.material;
            if (!m) return;
            if (Array.isArray(m)) m.forEach(fn);
            else fn(m);
        });
    }

    // ---------- geometry helpers ----------
    function centerOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    // An element standing on the ground plane: its footprint is the bottom edge,
    // and its middle (where a coin would strike) is half its height up.
    function standing(r) {
        return { x: r.left + r.width / 2, y: r.bottom, h: r.height / 2 };
    }

    // The painted felt as a screen-space ellipse, using the same art-space
    // measurements the 3D table is built from.
    function feltBounds(tableRect) {
        if (!tableRect || tableRect.width < 40) return null;
        const sc = tableRect.width / ART_W;
        return {
            cx: tableRect.left + FELT_CX_PX * sc,
            cy: tableRect.top + FELT_CY_PX * sc,
            ax: FELT_HALF_W_PX * sc,
            by: FELT_HALF_D_PX * sc,
        };
    }

    // Pull a point inside the felt ellipse (no-op if it's already in).
    function clampToFelt(f, p, edge) {
        const dx = (p.x - f.cx) / f.ax, dy = (p.y - f.cy) / f.by;
        const r = Math.hypot(dx, dy);
        if (r <= edge || r === 0) return p;
        const k = edge / r;
        return { x: f.cx + (p.x - f.cx) * k, y: f.cy + (p.y - f.cy) * k };
    }

    // Where the chip comes down: a short step from the seat it hit toward the
    // middle of the table, so it lands right in front of that player instead of
    // sailing on to the center. Clamped onto the felt, since a seat sitting well
    // back from the rail would otherwise put the drop on the black surround.
    function dropPoint(to, f) {
        const jitter = () => (Math.random() * 2 - 1) * DROP_SCATTER;
        if (!f) return { x: to.x + jitter(), y: to.y + DROP_DIST };
        const dx = f.cx - to.x, dy = f.cy - to.y;
        const len = Math.hypot(dx, dy) || 1;
        return clampToFelt(f, {
            x: to.x + (dx / len) * DROP_DIST + jitter(),
            y: to.y + (dy / len) * DROP_DIST + jitter(),
        }, FELT_EDGE);
    }

    // The rail is a wall. A chip that lands near the edge keeps bouncing and
    // skidding outward, and without this it drifts over the rail and comes to
    // rest off the table — so anything past the boundary is pushed back onto it
    // and its outward velocity is reversed and damped, i.e. it bounces off the
    // rail. (The normal is taken in the ellipse's normalized space; it isn't the
    // exact geometric normal, but for a nudge at the edge it reads the same.)
    function confine(c) {
        const f = c.felt;
        if (!f) return;
        const dx = (c.p.x - f.cx) / f.ax, dy = (c.p.y - f.cy) / f.by;
        const r = Math.hypot(dx, dy);
        if (r <= FELT_EDGE || r === 0) return;
        const k = FELT_EDGE / r;
        c.p.x = f.cx + (c.p.x - f.cx) * k;
        c.p.y = f.cy + (c.p.y - f.cy) * k;
        const nx = dx / r, ny = dy / r;
        const vn = c.v.x * nx + c.v.y * ny;     // outward speed
        if (vn > 0) {
            c.v.x -= (1 + RAIL_REST) * vn * nx;
            c.v.y -= (1 + RAIL_REST) * vn * ny;
        }
    }

    // ---------- a coin ----------
    function addCoin(s, from, to, felt, o) {
        const T = window.THREE;
        const kind = (o && o.item) || "chip";
        const def = projectileFor(kind);
        const mesh = def.make(T, s, o || {});
        if (!mesh) return null;   // a projectile whose model hasn't loaded yet
        const shadow = new T.Mesh(s.shadowGeo, s.shadowMat.clone());
        s.scene.add(mesh, shadow);

        const dx = to.x - from.x, dy = to.y - from.y;
        const dist = Math.hypot(dx, dy) || 1;
        const t = clamp(dist / SPEED, T_MIN, T_MAX);

        const c = {
            mesh, shadow,
            p: { x: from.x, y: from.y },
            v: { x: dx / t, y: dy / t },
            h: from.h,
            // Reach the target's height exactly at t, arcing over the way there.
            vh: (to.h - from.h) / t + 0.5 * G * t,
            phase: "flight",
            flightLeft: t,
            to, felt, land: dropPoint(to, felt),
            q: new T.Quaternion(),
            tumbleAxis: new T.Vector3(),
            tumbleRate: rand(TUMBLE[0], TUMBLE[1]) * (Math.random() < 0.5 ? -1 : 1),
            flatT: 0, flatFrom: null, flatTo: null,
            restT: 0, alpha: 1,
            kind: kind,
        };
        if (def.basePose) def.basePose(T, c.q);
        setTumbleAxis(c);
        s.coins.push(c);
        while (s.coins.length > MAX_COINS) removeCoin(s, s.coins[0]);
        return c;
    }

    // End-over-end: spin about the horizontal axis square to the direction of
    // travel (screen y is flipped going into world space).
    function setTumbleAxis(c) {
        const len = Math.hypot(c.v.x, c.v.y) || 1;
        c.tumbleAxis.set(c.v.y / len, c.v.x / len, 0).normalize();
    }

    function removeCoin(s, c) {
        const i = s.coins.indexOf(c);
        if (i >= 0) s.coins.splice(i, 1);
        s.scene.remove(c.mesh, c.shadow);
        eachMaterial(c.mesh, (m) => m.dispose());
        c.shadow.material.dispose();
    }

    // ---------- actors ----------
    // An actor is anything that wants this layer's canvas, camera and clock but
    // its own motion: { object3D, step(dt) -> false when finished, dispose? }.
    // Screen-space convention is the same as everywhere else here — world x is
    // screen x, world y is NEGATIVE screen y.
    function addActor(actor) {
        const s = ensureSession();
        if (!s || !actor || typeof actor.step !== "function" || !actor.object3D) return null;
        s.scene.add(actor.object3D);
        s.actors.push(actor);
        kick(s);
        return actor;
    }

    function removeActor(s, actor) {
        const i = s.actors.indexOf(actor);
        if (i >= 0) s.actors.splice(i, 1);
        s.scene.remove(actor.object3D);
        // Same rule as coins: per-instance materials are ours to free, shared
        // geometry and the caller's template are not.
        eachMaterial(actor.object3D, (m) => m.dispose());
        if (typeof actor.dispose === "function") { try { actor.dispose(); } catch (e) {} }
    }

    // ---------- physics ----------
    function stepCoin(s, c, dt) {
        const T = window.THREE;

        if (c.phase === "rest" || c.phase === "fade") {
            c.restT += dt;
            if (c.phase === "rest" && c.restT * 1000 >= REST_MS) { c.phase = "fade"; c.restT = 0; }
            if (c.phase === "fade") c.alpha = clamp(1 - (c.restT * 1000) / FADE_MS, 0, 1);
            return;
        }

        // --- flatten: the coin has stopped bouncing and lies down, bleeding off
        // the last of its spin as it goes.
        if (c.phase === "flatten") {
            c.flatT += dt;
            const k = clamp(c.flatT * 1000 / FLATTEN_MS, 0, 1);
            const e = easeOut(k);
            c.q.slerpQuaternions(c.flatFrom, c.flatTo, e);
            const spin = new T.Quaternion().setFromAxisAngle(
                new T.Vector3(0, 0, 1), SPIN_SETTLE * (1 - e));
            c.q.premultiply(spin);
            // keep skidding to a stop underneath the wobble
            const decay = Math.exp(-SLIDE_DECAY * dt);
            c.v.x *= decay; c.v.y *= decay;
            c.p.x += c.v.x * dt; c.p.y += c.v.y * dt;
            if (c.landed) confine(c);
            if (k >= 1) { c.phase = "rest"; c.restT = 0; c.v.x = c.v.y = 0; }
            return;
        }

        // --- ballistic: flight toward the avatar, or the drop onto the felt
        c.p.x += c.v.x * dt;
        c.p.y += c.v.y * dt;
        c.vh -= G * dt;
        c.h += c.vh * dt;

        const spin = new T.Quaternion().setFromAxisAngle(c.tumbleAxis, c.tumbleRate * dt);
        c.q.premultiply(spin);

        if (c.phase === "flight") {
            c.flightLeft -= dt;
            if (c.flightLeft <= 0) bounceOffAvatar(s, c);
            return;
        }

        // --- on the felt
        if (c.h <= 0) {
            c.h = 0;
            c.landed = true;
            if (-c.vh < SETTLE_VH) {
                startFlatten(c);
            } else {
                c.vh = -c.vh * REST;
                c.v.x *= FRICTION; c.v.y *= FRICTION;
                c.tumbleRate *= 0.55;
            }
        }
        // Only once it's actually touched down: this phase STARTS at the avatar,
        // which is off the felt, so confining before the first landing would
        // yank the chip onto the felt edge while it's still in the air.
        if (c.landed) confine(c);
    }

    // The coin reaches the target's face: kick it up and away, and solve the arc
    // so it comes down on a chosen spot on the felt.
    function bounceOffAvatar(s, c) {
        c.p.x = c.to.x; c.p.y = c.to.y; c.h = c.to.h;
        c.phase = "table";
        const land = c.land || { x: c.p.x, y: c.p.y + 40 };
        const dist = Math.hypot(land.x - c.p.x, land.y - c.p.y);
        const t2 = clamp(dist / RICOCHET, RIC_MIN, RIC_MAX);
        // Rise off the avatar and be back down to felt height exactly at t2.
        c.vh = (0.5 * G * t2 * t2 - c.h) / t2;
        c.v.x = (land.x - c.p.x) / t2;
        c.v.y = (land.y - c.p.y) / t2;
        setTumbleAxis(c);
        c.tumbleRate = rand(TUMBLE[0], TUMBLE[1]) * (Math.random() < 0.5 ? -1 : 1);
        if (c.onHit) { try { c.onHit(); } catch (e) {} c.onHit = null; }
    }

    // Settle into the projectile's resting pose from wherever the tumble left off.
    function startFlatten(c) {
        const T = window.THREE;
        const def = projectileFor(c.kind);
        c.vh = 0;
        if (!def.settlePose) {           // no resting pose: just stop where it is
            c.phase = "rest";
            c.restT = 0;
            c.v.x = c.v.y = 0;
            return;
        }
        c.phase = "flatten";
        c.flatT = 0;
        c.flatFrom = c.q.clone();
        c.flatTo = def.settlePose(T, c);
    }

    // ---------- draw ----------
    function place(s) {
        for (const c of s.coins) {
            const lift = c.h;
            const sc = 1 + c.h / 1400;   // a touch bigger the higher it is
            c.mesh.position.set(c.p.x, -(c.p.y - lift), 2 + c.h * 0.02);
            c.mesh.quaternion.copy(c.q);
            // Multiply the projectile's OWN scale rather than replacing it. The chip
            // is built at 1:1 so this is a no-op for it, but a loaded model arrives
            // pre-scaled to a sensible on-screen size (props3d normalizes arbitrary
            // authoring units — one model measured ~445,000 units across, another
            // 0.7) and setScalar() threw that away. Everything then rendered at raw
            // model size: invisible for two of them, tiny for one, huge for another.
            const base = (c.mesh.userData && c.mesh.userData.gpeBaseScale) || 1;
            c.mesh.scale.setScalar(base * sc);
            // Fade multiplies the material's AUTHORED opacity rather than
            // replacing it: a loaded model can have genuinely translucent parts
            // (beer.glb's glass is baseColorFactor alpha 0.4) and forcing those to
            // 1 while it flies would turn the glass solid.
            eachMaterial(c.mesh, (m) => {
                const base = (m.userData && typeof m.userData.gpeBaseOpacity === "number")
                    ? m.userData.gpeBaseOpacity : 1;
                m.opacity = base * c.alpha;
            });

            const k = 1 / (1 + c.h / 240);
            c.shadow.position.set(c.p.x, -c.p.y, 0);
            c.shadow.scale.setScalar(clamp(k, 0.35, 1));
            c.shadow.material.opacity = 0.38 * k * c.alpha;
        }
    }

    function frame(s, now) {
        if (!s.enabled) return;
        s.raf = requestAnimationFrame((t) => frame(s, t));
        const dt = Math.min((now - (s.last || now)) / 1000, 0.05);
        s.last = now;

        if (!s.coins.length && !s.actors.length) {
            // Nothing in the air: idle the loop rather than burning frames.
            s.idle += dt;
            if (s.idle > 0.5) { cancelAnimationFrame(s.raf); s.raf = 0; s.running = false; }
            return;
        }
        s.idle = 0;

        syncViewport(s);
        s.acc = Math.min(s.acc + dt, STEP * MAX_SUBSTEPS);
        while (s.acc >= STEP) {
            for (const c of s.coins.slice()) stepCoin(s, c, STEP);
            // Actors move themselves: they get the same fixed step and are done
            // when they say so. (The beer slide is one — it is not ballistic, so
            // it cannot share stepCoin's phases.)
            for (const a of s.actors.slice()) {
                let alive = false;
                try {
                    alive = a.step(STEP) !== false;
                } catch (e) {
                    // Don't swallow it: an actor that throws on its first step
                    // vanishes without trace otherwise.
                    console.warn("[gpe] coin3d: actor step failed, dropping it", e);
                    alive = false;
                }
                if (!alive) removeActor(s, a);
            }
            s.acc -= STEP;
        }
        for (const c of s.coins.slice()) if (c.phase === "fade" && c.alpha <= 0) removeCoin(s, c);
        place(s);
        s.renderer.render(s.scene, s.camera);
    }

    function kick(s) {
        if (s.running) return;
        s.running = true;
        s.idle = 0;
        s.last = 0;
        s.raf = requestAnimationFrame((t) => { s.last = t; frame(s, t); });
    }

    // ---------- lifecycle ----------
    function bail(why, err) { console.warn("[gpe] coin3d: " + why, err || ""); return null; }

    function ensureSession() {
        if (session) return session;
        if (broken) return null;
        const T = window.THREE;
        if (!T) return bail("three.js missing");
        if (!(window.GPE_CHIPS && window.GPE_CHIPS.art)) return bail("chips3d missing");
        const canvas = makeLayer();
        const s = { canvas, coins: [], actors: [], enabled: true, raf: 0, acc: 0, idle: 0, running: false, vw: 0, vh: 0 };
        try {
            s.renderer = new T.WebGLRenderer({
                canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
            });
            s.renderer.setClearColor(0x000000, 0);
            s.renderer.outputColorSpace = T.SRGBColorSpace;
            s.camera = new T.OrthographicCamera(0, 1, 0, -1, -2000, 2000);
            s.camera.position.set(0, 0, 500);
            buildScene(s);
            syncViewport(s);
        } catch (err) {
            broken = true;
            canvas.remove();
            return bail("init failed", err);
        }
        session = s;
        return s;
    }

    /*
     * Throw one chip.
     *   fromRect  the thrower's avatar rect (DOMRect-ish); null -> the near edge
     *             of the table, so a spectator's chip still comes from somewhere
     *   toRect    the target's avatar rect
     *   tableRect the table element's rect, for picking a spot on the felt
     *   opts      { onHit, denom } — onHit fires when the chip strikes the
     *             avatar; denom is a dollar value from GPE_CHIPS.art.types
     *             (default: a random one, so the colors vary)
     */
    function toss(fromRect, toRect, tableRect, opts) {
        if (!toRect || !toRect.width) return false;
        const s = ensureSession();
        if (!s) return false;
        const o = (typeof opts === "function") ? { onHit: opts } : (opts || {});

        const to = standing(toRect);
        let from;
        if (fromRect && fromRect.width) {
            from = standing(fromRect);
        } else if (tableRect && tableRect.width) {
            const c = centerOf(tableRect);
            from = { x: c.x, y: tableRect.bottom + 30, h: 40 };
        } else {
            from = { x: to.x, y: window.innerHeight - 20, h: 40 };
        }
        const coin = addCoin(s, from, to, feltBounds(tableRect), o);
        if (!coin) return false;
        coin.onHit = o.onHit || null;
        kick(s);
        return true;
    }

    // A dollar value -> its index in chips3d's set; anything unrecognized (or
    // omitted) picks at random so a flurry of throws isn't all one color.
    function denomIndex(denom) {
        const types = window.GPE_CHIPS.art.types;
        const i = types.findIndex((t) => t.denom === denom);
        return i >= 0 ? i : Math.floor(Math.random() * types.length);
    }

    function disable() {
        const s = session;
        if (!s) return;
        s.enabled = false;
        if (s.raf) cancelAnimationFrame(s.raf);
        s.coins.slice().forEach((c) => removeCoin(s, c));
        s.actors.slice().forEach((a) => removeActor(s, a));
        [s.coinGeo, s.shadowGeo].forEach((g) => g && g.dispose());
        (s.art || []).forEach((a) => {
            if (!a) return;
            a.faceMat.dispose(); a.rimMat.dispose();
            a.face.dispose(); a.rim.dispose();   // minted for us by GPE_CHIPS.art
        });
        [s.shadowMat].forEach((m) => m && m.dispose());
        [s.shadowTex].forEach((t) => t && t.dispose());
        if (s.renderer) {
            s.renderer.dispose();
            if (s.renderer.forceContextLoss) s.renderer.forceContextLoss();
        }
        if (s.canvas && s.canvas.parentNode) s.canvas.remove();
        session = null;
    }

    window.GPE_COIN = {
        toss, disable, registerProjectile, addActor, feltBounds,
        isRunning: () => !!(session && (session.coins.length || session.actors.length)),
        _session: () => session,
    };
})();
