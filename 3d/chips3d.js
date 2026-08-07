/*
 * chips3d.js — "chip portal": a WebGL gag that opens a glowing portal above the
 * poker table and dumps a stream of 3D chips onto the felt, where they bounce,
 * scatter, and pile into stacks.
 *
 * Loaded as a content script after vendor/three.iife.js (which sets THREE) and
 * before content.js; exposes window.GPE_CHIPS = { drop, isRunning } in the same
 * isolated world, the way odds.js exposes window.GPE_ODDS.
 *
 * The canvas is a transparent, pointer-events:none layer pinned over
 * .iogc-GameWindow-table, so the game underneath keeps working normally. It is
 * created on demand and fully disposed when the animation ends — a leaked WebGL
 * context per click would eventually kill the tab.
 *
 * NOTE: this is a test feature with no settings toggle yet. The tuning knobs
 * below are all in one block on purpose so the look can be dialed in quickly.
 */
(function () {
    "use strict";

    // ---------- how the painted table maps into 3D ----------
    // The felt art (assets/table.png, and the site's own light jpg) is 790x451,
    // drawn flat top-down, and painted into .iogc-GameWindow-table at `0 -30px`.
    // Measured off that art, the playable felt inside the rail is a stadium:
    // center (395, 220) in image space, 290px half-length, 102px half-depth. The
    // -30px background offset puts that center FELT_CY_PX below the element top.
    const ART_W = 790;           // art width the pixel constants below were measured at
    const FELT_CX_PX = 395;
    const FELT_CY_PX = 190;      // 220 in the art, less the 30px background offset
    const FELT_HALF_W_PX = 290;
    const FELT_HALF_D_PX = 102;  // as drawn, i.e. already foreshortened

    // The art is top-down but a portal hanging in the air needs a tilted camera
    // to read as "above" the table, so we compromise: a steep elevation keeps
    // the felt close to its painted shape while still giving the portal vertical
    // room on screen and letting chip edges/stacks show. 90 = straight down.
    const ELEV_DEG = 55;
    const FOV = 42;
    const VIEW_W = 40;           // world units spanning the table element's width
    const PAD_TOP = 48;          // extra canvas above the element, for portal glow

    // ---------- tuning ----------
    const CHIP_COUNT = 180;
    const CHIP_R = 0.55;
    const CHIP_H = 0.17;
    const SPAWN_PER_SEC = 95;
    const G = 46;                // world units/s^2 (deliberately slow; real gravity at this scale is a blur)
    const REST = 0.36;           // bounce restitution
    const FRICTION = 0.72;       // lateral velocity kept per bounce
    const SETTLE_V = 1.5;        // below this impact/slide speed a chip comes to rest
    const SCATTER = 3.4;         // outward kick when a chip lands on a pile, so stacks spread
    // Land on top of a settled chip only on a fairly centered hit; glancing
    // overlaps instead reach the felt and get pushed aside (separateResting).
    const STACK_R = CHIP_R * 0.9;
    // The chip faces are flat 2D art, so the target is to reproduce their albedo
    // almost exactly and let the directional add only a little top-light shaping.
    //
    // Beware the units: three's Lambert BRDF carries a 1/PI factor, so an
    // AmbientLight of intensity 1.0 reproduces only ~32% of a texture's albedo —
    // the chips' #f8f8f8 whites came out as mid-grey (~160/255). Reproducing the
    // art 1:1 therefore needs intensities around PI, not around 1. These are set
    // so a face lit only by ambient still reads near-white, and one facing the
    // directional lands just about exactly at the authored albedo.
    const LIGHT_AMBIENT = 2.7;   // ~0.86 of albedo on its own
    const LIGHT_DIR = 0.55;      // + ~0.15 on faces turned toward it
    const PORTAL_R = 3.4;
    const PORTAL_H = 8.5;        // height of the portal above the felt
    const PORTAL_A = "#7de3ff";  // swirl colors
    const PORTAL_B = "#b06bff";
    const OPEN_MS = 520;
    const CLOSE_MS = 480;
    const HOLD_MS = 1400;        // time to admire the pile before it fades
    const FADE_MS = 700;

    // Chip faces are drawn to match the site's own chip art: a colored body with
    // six white edge spots (EDGE_SPOTS below), a big white inner disc, and the
    // denomination in outlined gray. Every body color here was sampled off a
    // screenshot of a live table, so the set matches what the site actually draws:
    // $1 is grey (not the casino-standard white), $5 is a deep red rather than an
    // orange one, and the two largest are abbreviated ("2.5K" blue, "10K" pale
    // green) exactly as the site abbreviates them.
    const CHIP_TYPES = [
        { denom: 1,     body: "#8a8a8a" },
        { denom: 5,     body: "#a82026" },
        { denom: 25,    body: "#189040" },
        { denom: 100,   body: "#0d0d0d" },
        { denom: 500,   body: "#a4007c" },
        // The site abbreviates the big two on the chip face rather than printing
        // all the digits, so they carry explicit labels. Kept in ascending order.
        // The 2500's blue takes the default glyph colour; the 10,000's pale green
        // needs a darker one, because #606060 goes muddy on a body that light.
        { denom: 2500,  body: "#5292d0", label: "2.5K" },
        { denom: 10000, body: "#bde9a4", label: "10K", text: "#3c3c3c" },
    ];
    const CHIP_SPOT = "#f8f8f8";   // edge spots and inner disc
    const CHIP_TEXT = "#606060";   // denomination glyphs
    const CHIP_TEXT_EDGE = "#2a2a2a";
    const EDGE_SPOTS = 6;

    const STEP = 1 / 120;        // fixed physics step (stable stacking)
    const MAX_SUBSTEPS = 8;

    let session = null;          // the one live animation, or null

    // ---------- small helpers ----------
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    // Overshoot ease, so the portal snaps open with a bit of spring.
    function easeOutBack(t) {
        const c = 1.70158;
        return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    }

    function tableEl() {
        return document.querySelector(".iogc-GameWindow-table");
    }

    // ---------- chip artwork ----------
    // Faces are drawn once per denomination into a 2D canvas and uploaded as a
    // texture. CylinderGeometry's caps inscribe the circle in the [0,1] uv
    // square, so a circle drawn to the edge of a square canvas lands exactly.
    function chipFaceTexture(T, type) {
        const S = 256, R = S / 2;
        const spot = type.spot || CHIP_SPOT;   // the pale $1 chip overrides these
        const disc = type.disc || CHIP_SPOT;
        const text = type.text || CHIP_TEXT;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const g = cv.getContext("2d");

        g.fillStyle = type.body;
        g.beginPath();
        g.arc(R, R, R - 1, 0, Math.PI * 2);
        g.fill();

        // Edge spots: wedges from the rim inward, one every 360/EDGE_SPOTS.
        // half-width as a fraction of the spot-to-spot spacing, so the white
        // spokes take 2*this of the rim and the body color keeps the rest.
        const half = ((Math.PI * 2) / EDGE_SPOTS) * 0.2;
        g.fillStyle = spot;
        for (let i = 0; i < EDGE_SPOTS; i++) {
            const a = (i / EDGE_SPOTS) * Math.PI * 2 - Math.PI / 2;
            g.beginPath();
            g.arc(R, R, R * 0.985, a - half, a + half);
            g.arc(R, R, R * 0.78, a + half, a - half, true);
            g.closePath();
            g.fill();
        }

        // Inner disc. Its radius is what sets the width of the body-colored ring
        // around the denomination (the ring runs from here out to the spots).
        g.fillStyle = disc;
        g.beginPath();
        g.arc(R, R, R * 0.51, 0, Math.PI * 2);
        g.fill();

        // Denomination, shrunk to fit the disc, outlined the way the site's is.
        // A type may carry its own label: the site prints "10K", not "10000", and
        // the auto-shrink would otherwise squeeze five digits into an unreadable
        // smear.
        const label = type.label != null ? String(type.label) : String(type.denom);
        const font = (px) => "bold " + px + "px Arial, Helvetica, sans-serif";
        let px = Math.round(R * 0.66);
        g.font = font(px);
        const maxW = R * 0.88;   // fit inside the (now smaller) inner disc
        const w = g.measureText(label).width;
        if (w > maxW) { px = Math.round(px * (maxW / w)); g.font = font(px); }
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.lineJoin = "round";
        g.lineWidth = Math.max(2, R * 0.05);
        g.strokeStyle = CHIP_TEXT_EDGE;
        g.strokeText(label, R, R + R * 0.015);
        g.fillStyle = text;
        g.fillText(label, R, R + R * 0.015);

        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
        tex.anisotropy = 4;
        return tex;
    }

    // The rim: body color banded with the same eight spots, so a chip on edge
    // still reads as the same chip. Side uvs run once around the circumference.
    function chipRimTexture(T, type) {
        const W = 256, H = 32;
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        const g = cv.getContext("2d");
        g.fillStyle = type.body;
        g.fillRect(0, 0, W, H);
        g.fillStyle = type.spot || CHIP_SPOT;
        const bw = (W / EDGE_SPOTS) * 0.4;   // matches the face spokes' width
        for (let i = 0; i < EDGE_SPOTS; i++) {
            g.fillRect((i / EDGE_SPOTS) * W - bw / 2, 0, bw, H);
            if (i === 0) g.fillRect(W - bw / 2, 0, bw / 2, H);   // wrap the seam
        }
        // Slight vertical shading so the edge doesn't look like flat paper.
        const grad = g.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "rgba(0,0,0,0.28)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.10)");
        grad.addColorStop(1, "rgba(0,0,0,0.32)");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);

        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
    }

    // ---------- the layer over the table ----------
    function makeLayer() {
        const layer = document.createElement("div");
        layer.id = "gpe-chips-layer";
        const canvas = document.createElement("canvas");
        layer.appendChild(canvas);
        document.body.appendChild(layer);
        return { layer, canvas };
    }

    // Pin the layer over the table element and frame the camera so world-space
    // (0,0,0) lands exactly on the painted felt's center. Called every frame;
    // returns early unless the element actually moved or resized (scroll,
    // window resize, the side panel opening, ...).
    function syncToTable(s, force) {
        const el = tableEl();
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        const p = s.placed;
        if (!force && p && p.w === r.width && p.h === r.height &&
            p.l === r.left && p.t === r.top) return true;

        const cw = Math.round(r.width);
        const ch = Math.round(r.height + PAD_TOP);
        s.layer.style.left = r.left + "px";
        s.layer.style.top = (r.top - PAD_TOP) + "px";
        s.layer.style.width = cw + "px";
        s.layer.style.height = ch + "px";

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        s.renderer.setPixelRatio(dpr);
        s.renderer.setSize(cw, ch, false);

        // World units per CSS pixel, fixed to the element's width so the felt
        // keeps the same world size whatever the table is scaled to.
        const wpp = VIEW_W / r.width;
        const scale = r.width / ART_W;   // art pixels -> element pixels

        // Distance that makes the canvas's vertical extent cover exactly
        // ch * wpp world units at the felt plane.
        const d = (ch * wpp) / (2 * Math.tan((FOV * Math.PI) / 180 / 2));

        // Aim the camera so the felt center projects onto the pixel the art
        // paints it at. Screen-vertical offsets on the ground plane are
        // foreshortened by sin(elev); screen-horizontal ones are not.
        const dxPx = FELT_CX_PX * scale - cw / 2;
        const dyPx = (PAD_TOP + FELT_CY_PX * scale) - ch / 2;
        const tx = -dxPx * wpp;
        const tz = -dyPx * wpp / s.sinE;

        s.camera.fov = FOV;
        s.camera.aspect = cw / ch;
        s.camera.position.set(tx, d * s.sinE, tz + d * s.cosE);
        s.camera.lookAt(tx, 0, tz);
        s.camera.updateProjectionMatrix();

        // Felt bounds in world space. The on-screen half-depth is foreshortened,
        // so the real half-depth is larger by 1/sin(elev).
        s.feltA = FELT_HALF_W_PX * scale * wpp;
        s.feltB = (FELT_HALF_D_PX * scale * wpp) / s.sinE;
        // The plane is built in XY and rotated flat, so its LOCAL y is world z.
        if (s.ground) {
            s.ground.scale.set((s.feltA * 1.15) / 10, (s.feltB * 1.15) / 10, 1);
        }

        s.placed = { w: r.width, h: r.height, l: r.left, t: r.top };
        return true;
    }

    // ---------- scene ----------
    function buildScene(s) {
        const T = window.THREE;
        s.scene = new T.Scene();

        s.scene.add(new T.AmbientLight(0xffffff, LIGHT_AMBIENT));
        const dir = new T.DirectionalLight(0xffffff, LIGHT_DIR);
        dir.position.set(-8, 16, 7);
        dir.castShadow = true;
        dir.shadow.mapSize.set(1024, 1024);
        dir.shadow.bias = -0.0015;
        dir.shadow.normalBias = 0.02;
        const sc = dir.shadow.camera;
        sc.left = -20; sc.right = 20; sc.top = 16; sc.bottom = -16;
        sc.near = 1; sc.far = 60;
        sc.updateProjectionMatrix();
        s.scene.add(dir);

        // Portal glow spilling onto the chips below it.
        s.portalLight = new T.PointLight(new T.Color(PORTAL_A), 0, 26);
        s.portalLight.position.set(0, PORTAL_H - 1, 0);
        s.scene.add(s.portalLight);

        // Shadow-only ground: catches chip shadows on the painted felt without
        // drawing a surface of its own. Unit-ish plane, scaled in syncToTable.
        s.groundGeo = new T.PlaneGeometry(20, 20);
        s.groundMat = new T.ShadowMaterial({ opacity: 0.42 });
        s.ground = new T.Mesh(s.groundGeo, s.groundMat);
        s.ground.rotation.x = -Math.PI / 2;
        s.ground.receiveShadow = true;
        s.scene.add(s.ground);

        // One instanced mesh per denomination: each needs its own face texture,
        // which per-instance color can't express. Five draw calls, shared
        // geometry. CylinderGeometry's material groups are [side, top, bottom].
        s.chipGeo = new T.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 28, 1);
        s.textures = [];
        s.chipMats = [];
        s.chipMeshes = CHIP_TYPES.map((type) => {
            const face = chipFaceTexture(T, type);
            const rim = chipRimTexture(T, type);
            s.textures.push(face, rim);
            const faceMat = new T.MeshStandardMaterial({ map: face, roughness: 0.5, metalness: 0.05 });
            const rimMat = new T.MeshStandardMaterial({ map: rim, roughness: 0.62, metalness: 0.04 });
            s.chipMats.push(faceMat, rimMat);
            const mesh = new T.InstancedMesh(s.chipGeo, [rimMat, faceMat, faceMat], CHIP_COUNT);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.count = 0;
            // Chips move every frame and always sit within the framed felt, so
            // skip culling rather than recomputing instance bounding spheres.
            mesh.frustumCulled = false;
            s.scene.add(mesh);
            return mesh;
        });

        buildPortal(s);
    }

    function buildPortal(s) {
        const T = window.THREE;
        s.portal = new T.Group();
        s.portal.position.set(0, PORTAL_H, 0);
        s.portal.scale.setScalar(0.001);
        s.scene.add(s.portal);

        // Rim, plus a fatter, fainter one for bloom-ish falloff.
        s.ringGeo = new T.TorusGeometry(PORTAL_R, 0.2, 12, 96);
        s.ringMat = new T.MeshBasicMaterial({
            color: new T.Color(PORTAL_A), transparent: true, opacity: 0.95,
            blending: T.AdditiveBlending, depthWrite: false,
        });
        const ring = new T.Mesh(s.ringGeo, s.ringMat);
        ring.rotation.x = -Math.PI / 2;
        s.portal.add(ring);

        s.haloGeo = new T.TorusGeometry(PORTAL_R + 0.16, 0.62, 10, 72);
        s.haloMat = new T.MeshBasicMaterial({
            color: new T.Color(PORTAL_B), transparent: true, opacity: 0.22,
            blending: T.AdditiveBlending, depthWrite: false,
        });
        const halo = new T.Mesh(s.haloGeo, s.haloMat);
        halo.rotation.x = -Math.PI / 2;
        s.portal.add(halo);

        // The swirl the chips come out of. Polar coordinates are derived from
        // local position rather than uv, since RingGeometry's uvs are mapped to
        // its bounding square.
        s.swirlGeo = new T.RingGeometry(0.06, PORTAL_R * 0.99, 96, 1);
        s.swirlMat = new T.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: T.AdditiveBlending,
            side: T.DoubleSide,
            uniforms: {
                uTime: { value: 0 },
                uR: { value: PORTAL_R },
                uOpacity: { value: 1 },
                uColA: { value: new T.Color(PORTAL_A) },
                uColB: { value: new T.Color(PORTAL_B) },
            },
            vertexShader: `
                varying vec2 vP;
                void main() {
                    vP = position.xy;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float uTime, uR, uOpacity;
                uniform vec3 uColA, uColB;
                varying vec2 vP;
                void main() {
                    float r = length(vP) / uR;
                    float a = atan(vP.y, vP.x);
                    float s1 = sin(a * 3.0 + uTime * 2.4 - r * 11.0);
                    float s2 = sin(a * 5.0 - uTime * 1.7 + r * 7.0);
                    float bands = clamp(0.5 + 0.35 * s1 + 0.22 * s2, 0.0, 1.0);
                    // hollow-ish center, faded rim
                    float radial = smoothstep(0.0, 0.30, r) * (1.0 - smoothstep(0.80, 1.0, r));
                    float glow = pow(max(0.0, 1.0 - abs(r - 0.68) / 0.68), 2.0);
                    vec3 col = mix(uColA, uColB, bands) * (0.7 + 0.9 * bands);
                    float alpha = uOpacity * radial * (0.30 + 0.70 * bands) * (0.5 + 0.5 * glow);
                    gl_FragColor = vec4(col, alpha);
                }
            `,
        });
        const swirl = new T.Mesh(s.swirlGeo, s.swirlMat);
        swirl.rotation.x = -Math.PI / 2;
        s.portal.add(swirl);
    }

    // ---------- chips ----------
    function spawnChip(s) {
        if (s.live.length >= CHIP_COUNT) return;
        const T = window.THREE;
        // Somewhere inside the portal mouth (sqrt keeps it area-uniform).
        const a = rand(0, Math.PI * 2);
        const rr = PORTAL_R * 0.78 * Math.sqrt(Math.random());
        const c = {
            x: Math.cos(a) * rr,
            y: PORTAL_H - rand(0, 0.5),
            z: Math.sin(a) * rr,
            vx: Math.cos(a) * rand(-0.5, 1.6) - Math.sin(a) * rand(0.6, 2.2), // outward + a swirl tangent
            vy: -rand(2, 5),
            vz: Math.sin(a) * rand(-0.5, 1.6) + Math.cos(a) * rand(0.6, 2.2),
            wx: rand(-11, 11), wy: rand(-7, 7), wz: rand(-11, 11),
            q: new T.Quaternion(),
            resting: false,
            type: s.live.length % CHIP_TYPES.length,   // even mix of denominations
        };
        // Random tumble to start.
        c.q.setFromEuler(new T.Euler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)));
        s.live.push(c);
    }

    // Height a chip at (x,z) rests at: the felt, or the top of the highest
    // settled chip it overlaps. Only settled chips are considered, so a falling
    // chip never rides another falling one.
    function supportAt(s, x, z, self) {
        let top = CHIP_H / 2;
        const r2 = STACK_R * STACK_R;
        for (let i = 0; i < s.rested.length; i++) {
            const o = s.rested[i];
            if (o === self) continue;
            const dx = o.x - x, dz = o.z - z;
            if (dx * dx + dz * dz < r2) {
                const t = o.y + CHIP_H;
                if (t > top) top = t;
            }
        }
        return top;
    }

    // Keep chips on the painted felt: a stadium, i.e. everything within
    // (feltB - r) of the centerline segment.
    function confine(s, c) {
        const A = s.feltA - CHIP_R;
        const B = s.feltB - CHIP_R;
        const spineHalf = Math.max(0, A - B);
        const sx = clamp(c.x, -spineHalf, spineHalf);
        let dx = c.x - sx, dz = c.z;
        let dist = Math.hypot(dx, dz);
        if (dist <= B) return;
        if (dist < 1e-6) { dx = 1; dz = 0; dist = 1; }
        const nx = dx / dist, nz = dz / dist;
        c.x = sx + nx * B;
        c.z = nz * B;
        const vn = c.vx * nx + c.vz * nz;
        if (vn > 0) {                 // moving outward: reflect, half energy
            c.vx -= 1.5 * vn * nx;
            c.vz -= 1.5 * vn * nz;
        }
    }

    // Chips that come to rest at the same height with centers closer than a chip
    // diameter would visibly clip through each other, so nudge the arriving chip
    // out of any same-layer overlap. Only the new chip moves — shoving settled
    // ones would slide piles out from under the chips stacked on them.
    function separateResting(s, c) {
        const min = CHIP_R * 2 * 0.97;
        for (let it = 0; it < 8; it++) {
            let worst = 0, nx = 0, nz = 0;
            for (let i = 0; i < s.rested.length; i++) {
                const o = s.rested[i];
                if (o === c || Math.abs(o.y - c.y) > CHIP_H * 0.6) continue;
                let dx = c.x - o.x, dz = c.z - o.z;
                let d = Math.hypot(dx, dz);
                if (d >= min) continue;
                if (d < 1e-6) { const a = rand(0, Math.PI * 2); dx = Math.cos(a); dz = Math.sin(a); d = 1e-6; }
                const overlap = min - d;
                if (overlap > worst) { worst = overlap; nx = dx / (d || 1); nz = dz / (d || 1); }
            }
            if (worst <= 0) break;
            c.x += nx * worst;
            c.z += nz * worst;
        }
    }

    function settle(s, c) {
        const T = window.THREE;
        separateResting(s, c);
        confine(s, c);
        // It may have been nudged off whatever it landed on, so re-seat it.
        c.y = supportAt(s, c.x, c.z, c);
        c.vx = c.vy = c.vz = 0;
        c.wx = c.wy = c.wz = 0;
        c.resting = true;
        // Chips lie flat: the cylinder's axis is already +y, so a rotation about
        // y alone is "face up". Slerp there over a few frames instead of
        // snapping, which reads as the chip rocking to a stop.
        c.qTarget = new T.Quaternion().setFromEuler(new T.Euler(0, rand(0, Math.PI * 2), 0));
        s.rested.push(c);
    }

    function stepPhysics(s, dt) {
        for (let i = 0; i < s.live.length; i++) {
            const c = s.live[i];
            if (c.resting) {
                if (c.qTarget) {
                    c.q.slerp(c.qTarget, 0.22);
                    if (1 - Math.abs(c.q.dot(c.qTarget)) < 1e-4) {
                        c.q.copy(c.qTarget);
                        c.qTarget = null;
                    }
                }
                continue;
            }

            c.vy -= G * dt;
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.z += c.vz * dt;

            // Spin: small-angle rotation about the angular-velocity axis.
            const w = Math.hypot(c.wx, c.wy, c.wz);
            if (w > 1e-4) {
                const ang = w * dt;
                const sh = Math.sin(ang / 2) / w;
                s.dq.set(c.wx * sh, c.wy * sh, c.wz * sh, Math.cos(ang / 2));
                c.q.premultiply(s.dq).normalize();
            }

            confine(s, c);

            const support = supportAt(s, c.x, c.z, c);
            if (c.y <= support) {
                c.y = support;
                const impact = -c.vy;
                const slide = Math.hypot(c.vx, c.vz);
                if (impact > 0) {
                    c.vy = impact * REST;
                    c.vx *= FRICTION;
                    c.vz *= FRICTION;
                    c.wx *= 0.5; c.wy *= 0.82; c.wz *= 0.5;
                    // Landing on a pile shoves the chip off-center, which is
                    // what keeps stacks from growing into towers.
                    if (support > CHIP_H && impact < 7) {
                        const a = rand(0, Math.PI * 2);
                        c.vx += Math.cos(a) * SCATTER;
                        c.vz += Math.sin(a) * SCATTER;
                    }
                } else {
                    c.vy = 0;
                    c.vx *= 0.86;      // resting contact: bleed off the slide
                    c.vz *= 0.86;
                }
                if (impact < SETTLE_V && slide < SETTLE_V) settle(s, c);
            }
        }
    }

    function writeInstances(s) {
        const fill = s.fill;
        fill.fill(0);
        for (let i = 0; i < s.live.length; i++) {
            const c = s.live[i];
            s.pos.set(c.x, c.y, c.z);
            s.mat4.compose(s.pos, c.q, s.scl);
            s.chipMeshes[c.type].setMatrixAt(fill[c.type]++, s.mat4);
        }
        for (let t = 0; t < s.chipMeshes.length; t++) {
            const mesh = s.chipMeshes[t];
            mesh.count = fill[t];
            mesh.instanceMatrix.needsUpdate = true;
        }
    }

    // ---------- lifecycle ----------
    function dispose(s) {
        if (s.raf) cancelAnimationFrame(s.raf);
        s.raf = 0;
        [s.chipGeo, s.groundGeo, s.ringGeo, s.haloGeo, s.swirlGeo].forEach((g) => g && g.dispose());
        [s.groundMat, s.ringMat, s.haloMat, s.swirlMat].forEach((m) => m && m.dispose());
        (s.chipMats || []).forEach((m) => m.dispose());
        (s.textures || []).forEach((t) => t.dispose());
        (s.chipMeshes || []).forEach((m) => m.dispose());
        if (s.renderer) {
            s.renderer.dispose();
            // Hand the GPU context back now rather than waiting on GC; without
            // this, repeated clicks march toward the browser's context limit.
            if (s.renderer.forceContextLoss) s.renderer.forceContextLoss();
        }
        if (s.layer && s.layer.parentNode) s.layer.remove();
        if (session === s) session = null;
    }

    function frame(s, now) {
        s.raf = requestAnimationFrame((t) => frame(s, t));
        const dt = Math.min(0.05, (now - s.last) / 1000) || 0;
        s.last = now;
        s.t += dt;
        const ms = s.t * 1000;

        if (!syncToTable(s, false)) {   // table went away mid-animation
            dispose(s);
            return;
        }

        // --- portal open / spin / close ---
        let pScale;
        if (ms < OPEN_MS) {
            pScale = easeOutBack(clamp(ms / OPEN_MS, 0, 1));
        } else if (ms < s.closeAt) {
            pScale = 1;
        } else {
            pScale = 1 - clamp((ms - s.closeAt) / CLOSE_MS, 0, 1);
        }
        pScale = Math.max(0.0001, pScale);
        s.portal.scale.setScalar(pScale);
        s.portal.rotation.y += dt * 0.9;
        s.swirlMat.uniforms.uTime.value = s.t;
        s.swirlMat.uniforms.uOpacity.value = pScale;
        s.ringMat.opacity = 0.95 * pScale;
        s.haloMat.opacity = 0.22 * pScale;
        s.portalLight.intensity = 30 * pScale;

        // --- chip stream ---
        if (ms > s.spawnFrom && s.spawned < CHIP_COUNT) {
            s.spawnAcc += dt * SPAWN_PER_SEC;
            while (s.spawnAcc >= 1 && s.spawned < CHIP_COUNT) {
                s.spawnAcc -= 1;
                spawnChip(s);
                s.spawned++;
            }
        }

        // --- physics, fixed step ---
        s.acc += dt;
        let steps = 0;
        while (s.acc >= STEP && steps < MAX_SUBSTEPS) {
            stepPhysics(s, STEP);
            s.acc -= STEP;
            steps++;
        }
        if (steps === MAX_SUBSTEPS) s.acc = 0;   // fell behind; drop the backlog
        writeInstances(s);

        // --- fade out and tear down ---
        if (ms > s.fadeAt) {
            const k = clamp((ms - s.fadeAt) / FADE_MS, 0, 1);
            s.layer.style.opacity = String(1 - k);
            if (k >= 1) { dispose(s); return; }
        }

        s.renderer.render(s.scene, s.camera);
    }

    // Every refusal says why: the caller only sees false, and "nothing happened"
    // is otherwise indistinguishable from a silent WebGL/layout failure.
    function bail(why, err) {
        console.warn("[gpe] chip portal: " + why, err || "");
        return false;
    }

    function drop() {
        if (session) return bail("already running");
        const T = window.THREE;
        if (!T) return bail("three.js missing");
        if (!tableEl()) return bail("no .iogc-GameWindow-table on the page");

        const { layer, canvas } = makeLayer();
        const e = (ELEV_DEG * Math.PI) / 180;
        const s = {
            layer, canvas,
            sinE: Math.sin(e), cosE: Math.cos(e),
            feltA: 14, feltB: 6,
            live: [], rested: [],
            spawned: 0, spawnAcc: 0, acc: 0, t: 0, last: 0, raf: 0,
            placed: null,
            // Scratch objects, reused every frame so the loop doesn't allocate.
            mat4: new T.Matrix4(), pos: new T.Vector3(), scl: new T.Vector3(1, 1, 1),
            dq: new T.Quaternion(),
            fill: new Uint16Array(CHIP_TYPES.length),   // per-denomination instance counts
        };

        try {
            s.renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true });
        } catch (err) {
            layer.remove();
            return bail("no WebGL context", err);
        }
        s.renderer.setClearAlpha(0);
        s.renderer.shadowMap.enabled = true;
        s.renderer.outputColorSpace = T.SRGBColorSpace;
        // No tone mapping on purpose: the chip colors should read the same as the
        // site's flat 2D chip art, not be filmically rolled off.
        s.camera = new T.PerspectiveCamera(FOV, 1, 0.5, 400);

        try {
            buildScene(s);
        } catch (err) {
            dispose(s);
            return bail("scene build failed", err);
        }
        if (!syncToTable(s, true)) { dispose(s); return bail("could not measure the table"); }

        // Timeline: portal springs open, chips stream through, portal shuts, the
        // pile holds for a beat, then the whole layer fades and is disposed.
        s.spawnFrom = OPEN_MS * 0.72;
        const streamMs = (CHIP_COUNT / SPAWN_PER_SEC) * 1000;
        s.closeAt = s.spawnFrom + streamMs + 400;
        s.fadeAt = s.closeAt + CLOSE_MS + HOLD_MS;

        session = s;
        s.last = performance.now();
        s.raf = requestAnimationFrame((t) => frame(s, t));
        return true;
    }

    // The chip artwork is shared, not private to the portal: coin3d.js throws
    // these same chips at players, and drawing its own would mean a second set
    // of denominations to keep in step with the site's. `textures` mints a fresh
    // pair per call — the caller owns them and must dispose them.
    const art = {
        types: CHIP_TYPES.map((t) => ({ denom: t.denom, body: t.body })),
        proportions: { r: CHIP_R, h: CHIP_H },   // for anything drawn at another scale
        textures(T, i) {
            const type = CHIP_TYPES[((i | 0) % CHIP_TYPES.length + CHIP_TYPES.length) % CHIP_TYPES.length];
            return { face: chipFaceTexture(T, type), rim: chipRimTexture(T, type), type };
        },
    };

    // _session is a debugging handle (camera/felt/chip state) for the harness in
    // scratch; nothing in the extension reads it.
    window.GPE_CHIPS = { drop, art, isRunning: () => !!session, _session: () => session };
})();
