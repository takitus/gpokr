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
 * The same layer also powers confetti(): a celebratory burst of chips flung up
 * out of a seat that rains back down onto the felt (see the "celebratory burst"
 * section), reusing the very same chip art and land/settle/fade physics.
 *
 * Loaded as a content script after vendor/three.iife.js and chips3d.js; exposes
 * window.GPE_COIN = { toss, confetti, isRunning, disable, ... }. Purely cosmetic
 * and local to each viewer — nothing extra is sent to the site.
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

    // ---------- celebratory burst (confetti) ----------
    const CONFETTI_COUNT = 40;         // chips flung per celebration
    const CONFETTI_MAX = 80;           // hard cap, however loud the caller asks
    const CONFETTI_VH = [700, 1100];   // upward launch speed range, px/s (sets peak height)
    const CONFETTI_SPREAD = 260;       // max horizontal drift, px/s — how wide the burst fans out
    const CONFETTI_BIAS = 150;         // toward-table drift added to the spread, px/s — 0 is fully
                                       // omnidirectional, larger leans the burst onto the felt
    const CONFETTI_SCALE = 0.25;       // these chips render at a quarter of a tossed chip's size
    const VOID_DEPTH = 400;            // px below the table a missed chip falls before it's retired

    // ---------- felt (art-space fractions, as measured in table3d.js) ----------
    const ART_W = 790;
    const FELT_CX_PX = 395, FELT_CY_PX = 190;
    const FELT_HALF_W_PX = 290, FELT_HALF_D_PX = 102;
    const FELT_EDGE = 0.92;      // furthest the chip's CENTER may rest, so its body stays on
    const RAIL_REST = 0.35;      // how much of the outward speed the rail gives back

    const STEP = 1 / 120;        // fixed physics step
    const MAX_SUBSTEPS = 8;

    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    // Used by the deal; the ballistic paths above are integrated, not eased.
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
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

    // Two lights, on the cards' layer only.
    //
    // The numbers are solved, not taste: a Lambert surface comes out at
    // ambient + key * max(0, n·l), and a card facing the viewer has n·l ≈ 0.56
    // against this direction. 0.66 + 0.6*0.56 = 1.0, so the FACE renders at
    // exactly its own colour and the artwork reads true — which is what the
    // unlit material used to guarantee and what would otherwise be lost.
    //
    // Everything that is not the face then falls out for free: the underside rim
    // faces away from the light and gets ambient alone, 34% darker, which is the
    // shading that stops a thick card looking like a white block. The left rim
    // catches a little, the right rim less. And as a card turns over during the
    // deal its face slides down that curve on its own.
    function cardLights(T, s) {
        const amb = new T.AmbientLight(0xffffff, CARD_AMBIENT);
        amb.layers.set(CARD_LAYER);
        const key = new T.DirectionalLight(0xfff8ec, CARD_KEY);
        key.position.set(CARD_KEY_DIR[0], CARD_KEY_DIR[1], CARD_KEY_DIR[2]);
        key.layers.set(CARD_LAYER);
        s.scene.add(amb, key);
    }

    // The shadow a card drops. Card-shaped and blurred, rather than the coin's
    // radial blob: a rectangle's shadow has corners, and at this size the
    // difference between the two is the difference between a card lying on felt
    // and a card floating over a smudge.
    function cardShadowTexture(T) {
        const S = 128, PAD = 18, R = 12;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const g = cv.getContext("2d");
        if (!g) return null;
        try { g.filter = "blur(9px)"; } catch (e) { /* drawn hard, still passable */ }
        g.fillStyle = "rgba(0,0,0,0.55)";
        const w = S - PAD * 2, h = S - PAD * 2;
        g.beginPath();
        g.moveTo(PAD + R, PAD);
        g.arcTo(PAD + w, PAD, PAD + w, PAD + h, R);
        g.arcTo(PAD + w, PAD + h, PAD, PAD + h, R);
        g.arcTo(PAD, PAD + h, PAD, PAD, R);
        g.arcTo(PAD, PAD, PAD + w, PAD, R);
        g.closePath();
        g.fill();
        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
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

    // The canvas is fixed at width:100%/height:100%, so its CSS box is the viewport
    // WITHOUT the scrollbars — which is documentElement.clientWidth, not
    // window.innerWidth. Sizing the backing store from innerWidth made the two
    // disagree by the width of a scrollbar, and the browser then resampled the
    // whole canvas to fit: measured on a real table at devicePixelRatio 1.75, a
    // backing store of 1214 shown in a 684px box, a 1.5% non-integer downscale.
    // That is enough to visibly soften anything with fine detail in it — a dealt
    // card's glyphs above all — and since the camera frustum was built from the
    // same number, every prop was also drawn 1.5% small and slightly off from
    // whatever it was standing on.
    //
    // clientWidth is also the space getBoundingClientRect coordinates run over,
    // which is what everything here positions with, so this makes one CSS pixel
    // of the page one world unit and one device pixel per dpr, exactly.
    function viewportSize() {
        const d = document.documentElement;
        return {
            w: Math.max(1, (d && d.clientWidth) || window.innerWidth || 1),
            h: Math.max(1, (d && d.clientHeight) || window.innerHeight || 1),
        };
    }

    function syncViewport(s) {
        const vp = viewportSize();
        const w = vp.w, h = vp.h;
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
        s.cardShadowTex = cardShadowTexture(T);
        cardLights(T, s);

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

    // One chip mesh — art, geometry, face-on pose — for anything that wants to
    // DRAW a chip without throwing one (props3d's river floats a shoal of them
    // downstream). It goes through the same projectile definition a tossed chip
    // is built from, so there is still exactly one chip in the codebase, and
    // through ensureSession so the caller gets the art whether or not anything
    // has been thrown yet.
    function chipMesh(denom) {
        const s = ensureSession();
        if (!s) return null;
        const T = window.THREE;
        const def = projectiles.chip;
        const mesh = def.make(T, s, { denom: denom });
        if (mesh) def.basePose(T, mesh.quaternion);
        return mesh;
    }

    // ---------- dealing a community card ----------
    // A card slides in from off the top of the screen, face down, spinning, and
    // flips over as it lands on the spot the real one occupies — and then it
    // stays there, as the board's card, with the site's own <img> covered behind
    // it for as long as it lives. Nothing here expires; the caller owns it (see
    // the handle dealCard returns).
    //
    // The face is the site's OWN card image, used as a texture directly from the
    // decoded <img> — GWT inlines the deck as data: URIs, so there is nothing to
    // fetch and nothing to taint the texture. A cross-origin card would fail the
    // upload, so callers hand us the element and we say no rather than guess.
    //
    // MeshBasicMaterial, not a lit one. Unlit means the texture renders exactly
    // as the browser draws the same image in the page, which is what lets this
    // stand in for a real card indefinitely without the board looking different —
    // and what makes the fallback invisible if a card is ever handed back.
    // Shading would look better in flight and wrong for as long as it sits still.
    // The edge, faked as three flat tones rather than lit: the renderer's lights
    // are aimed at chips, and a card wants its top brighter than its underside
    // whatever they happen to be doing.
    // The edge. One tone, not lit: the renderer's lights are aimed at chips, and
    // the lean means it is almost always the underside you are looking at.
    const CARD_EDGE = 0xf6f2e9;   // paper, before any light touches it
    // Cards are LIT, and on their own layer so they can be lit differently from
    // the chips without disturbing them. three decides what a light touches by
    // intersecting layers, so cards sit alone on this one with their own rig and
    // the chip lights (layer 0, ambient 1.35 plus a 1.5 key) never reach them —
    // that rig is aimed at a glossy disc and would blow a sheet of paper out.
    const CARD_LAYER = 1;
    // Aimed from where the TABLE's key light is (table3d's KEY_POS), so the two
    // canvases agree about where the light is coming from: upper left, toward the
    // viewer. Intensities are solved rather than picked — see cardLights().
    const CARD_KEY_DIR = [-6, 15, 11];
    const CARD_AMBIENT = 0.66, CARD_KEY = 0.6;
    // The slab's corner radius, in the card's own 1x1 box. TWO numbers because
    // the group scales x and y independently (a 53x69 card out of a unit
    // geometry), so a corner that comes out circular on screen has to be
    // elliptical here. These are the site's own deck geometry — rx 12 on a
    // 210x280 card — which is exactly what our SVG faces are drawn with, so the
    // slab's outline turns the same corner as the picture on it.
    const CARD_RX = 12 / 210, CARD_RY = 12 / 280;
    const CARD_RADIUS = 0.07;    // corner radius, as a fraction of the card's width

    // The back. Nothing ships a single-card back — assets/backs/*.png are the
    // PAIR still-life gpokr draws at a seat, 23x26, which is the wrong shape — so
    // it is drawn here, the same way the river's ground is drawn rather than
    // sampled. One design, tinted: a border, a panel inset inside it, and a
    // lattice of thin diagonals, which is what survives being 53px wide.
    const CARD_BACK_TINTS = {
        rosette: "#8d2230", lattice: "#1f4f86", fan: "#1f6b45", deco: "#8a6a1e",
        "": "#8d2230",           // gpokr's own back is red, so the default matches
    };
    let backTexCache = Object.create(null);
    let cardGeo = null;

    function cardBackTexture(T, style) {
        const key = style || "";
        if (backTexCache[key]) return backTexCache[key];
        const w = 106, h = 138;                  // 2x the card, for a HiDPI display
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const g = cv.getContext("2d");
        if (!g) return null;
        const tint = CARD_BACK_TINTS[key] || CARD_BACK_TINTS[""];
        const r = w * CARD_RADIUS * 2;
        // Rounded, and transparent outside the corners, so the silhouette matches
        // the face image's own rounded corners instead of squaring them off.
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
        round(0, 0, w, h, r);
        g.fill();
        g.fillStyle = tint;
        round(3, 3, w - 6, h - 6, r * 0.8);
        g.fill();
        // The lattice. Clipped to the panel so it cannot spill onto the border,
        // and drawn in both directions so it reads as a weave at any size.
        g.save();
        round(7, 7, w - 14, h - 14, r * 0.6);
        g.clip();
        g.strokeStyle = "rgba(255,255,255,0.20)";
        g.lineWidth = 1.5;
        for (let i = -h; i < w + h; i += 9) {
            g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
            g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke();
        }
        g.restore();
        const tex = new T.CanvasTexture(cv);
        tex.colorSpace = T.SRGBColorSpace;
        tex.anisotropy = 4;
        backTexCache[key] = tex;
        return tex;
    }

    // Two planes back to back rather than a box: a box cannot have the face's
    // rounded corners, and the face image carries them in its own alpha. At
    // exactly edge-on the pair is a zero-width sliver for one frame, which is
    // what an edge-on card looks like anyway.
    // A card is drawn near 1:1 in screen space, so it wants no mip chain: mipmaps
    // soften a sprite at that scale, and on a WebGL1 fallback a non-power-of-two
    // texture with mipmapping gets RESIZED to a power of two — 150 down to 128 —
    // which is blur baked in before anything is drawn. LinearFilter with no mips
    // is the sharp choice here, and the slight aliasing it trades for only shows
    // if the texture is much larger than the card, which the caller controls.
    function cardTexture(T, src) {
        const tex = new T.Texture(src);
        tex.colorSpace = T.SRGBColorSpace;   // matches the renderer's output
        tex.generateMipmaps = false;
        tex.minFilter = T.LinearFilter;
        tex.magFilter = T.LinearFilter;
        tex.needsUpdate = true;
        return tex;
    }

    // The card's outline, as a shape to extrude. Built in 0..1 rather than centred
    // because both geometries below take their UVs straight from vertex x/y; the
    // positions are recentred afterwards, which leaves the UVs alone.
    function cardOutline(T) {
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
        return sh;
    }

    // A rounded slab plus two rounded caps, all unit-sized and shared.
    //
    // The caps are separate meshes rather than the extrusion's own ends because
    // an ExtrudeGeometry puts BOTH ends in one material group, and a card needs a
    // different picture on each. So the extrusion wears paper everywhere and the
    // textured caps sit a thousandth outside its ends — close enough to be the
    // same object, far enough not to z-fight.
    function cardGeometries(T) {
        if (cardGeo) return cardGeo;
        const shape = cardOutline(T);
        const body = new T.ExtrudeGeometry(shape, {
            depth: 0.995, bevelEnabled: false, curveSegments: 8,
        });
        body.translate(-0.5, -0.5, -0.4975);
        const cap = new T.ShapeGeometry(shape, 8);
        cap.translate(-0.5, -0.5, 0);
        // The shadow gets a plain square, not the card's outline: the blur in its
        // texture lives OUTSIDE the card's footprint, and a quad cut to that
        // outline would clip exactly the soft part off.
        cardGeo = { body: body, cap: cap, quad: new T.PlaneGeometry(1, 1) };
        return cardGeo;
    }

    function cardMesh(T, faceImg, backStyle) {
        let faceTex = null;
        try {
            faceTex = cardTexture(T, faceImg);
        } catch (e) { return null; }
        const backTex = cardBackTexture(T, backStyle);
        if (!backTex) return null;

        // Shared and never disposed, like the chip's cylinder.
        const geo = cardGeometries(T);
        // Lambert, not Basic: paper is diffuse, and this is what gives the rim its
        // shading and the face its slight fall-off as it turns. The face was
        // deliberately UNLIT while a dealt card handed back to the site's <img> —
        // unlit meant the two matched to the pixel at the swap. Nothing hands back
        // any more, so the card can be a thing in the light instead.
        const faceMat = new T.MeshLambertMaterial({ map: faceTex, transparent: true });
        const backMat = new T.MeshLambertMaterial({ map: backTex, transparent: true });
        const slab = new T.Mesh(geo.body, new T.MeshLambertMaterial({ color: CARD_EDGE }));
        const front = new T.Mesh(geo.cap, faceMat);
        front.position.z = 0.5;
        const back = new T.Mesh(geo.cap, backMat);
        back.position.z = -0.5;
        back.rotation.y = Math.PI;   // faces outward, and mirrors the back's art

        // The shadow, as a child so it is carried along and scaled by the card's
        // own transform: local x and y are the card's box, so a quad of 1.1 is
        // 10% wider than the card whatever size the card is. Unlit and on the
        // card layer, behind everything else in z.
        const shTex = ensureSession() && session.cardShadowTex;
        const shadow = shTex ? new T.Mesh(geo.quad, new T.MeshBasicMaterial({
            map: shTex, transparent: true, depthWrite: false, opacity: 0.9,
        })) : null;

        const group = new T.Group();
        group.add(slab, front, back);
        if (shadow) group.add(shadow);
        // Layers are per-object and NOT inherited from the group, so every mesh
        // has to be moved onto the cards' layer by hand.
        for (const m of group.children) m.layers.set(CARD_LAYER);
        group.userData.gpeShadow = shadow;
        // The face texture is per-card and has to be freed by hand: three's
        // Material.dispose() releases the material, never the textures on it.
        // The back is cached and shared, so it is deliberately left alone.
        group.userData.gpeFaceTex = faceTex;
        group.userData.gpeFaceMat = faceMat;
        return group;
    }

    // The deal itself. Timings are one choreography: it slides in over FLY,
    // holds for a beat, turns over FLIP, and the caller is told the instant the
    // face is square to the screen — which is when the real card underneath can
    // be uncovered, one frame before this comes away.
    const DEAL = {
        // The whole thing is 0.55s per card, and that is a budget rather than a
        // taste: it is how long the site's own card is covered up, and a player
        // may be looking at the board to decide something. Slower reads better
        // and is not ours to spend.
        FLY: 0.28,          // s, off-screen to the slot
        HOLD: 0.04,         // s, a beat face-down before it turns
        FLIP: 0.18,         // s, the turn
        REST: 0.05,         // s, square to the screen before the handoff
        OVER: 90,           // px above the viewport it starts
        SPIN: 0.55,         // rad of in-plane spin on the way in, unwinding to 0
        LEAD: 26,           // px it comes in from the side, so it arcs rather than drops
        GROW: 1.14,         // scale it arrives at, easing to 1 as it lands
        Z: 12,              // over the felt and the props, under nothing that matters
        THICK: 2,           // default card thickness, CSS px
        // A card lying flat under an orthographic camera shows NO thickness: its
        // depth runs straight down the view axis, so a 20px slab looks exactly
        // like paper. So a thick card is leaned a little toward the viewer, which
        // is the only thing that puts its edge on screen, and its height is
        // divided by cos(lean) so the face still fills the slot it stands in for.
        // The lean grows with the thickness, because the two are the same
        // question: how much of the card's footprint is edge rather than face.
        // At 2px there is nothing to show and it stays nearly flat; wound up to
        // 24 it is a third of a right angle and the edge is a good tenth of the
        // card. Paper does not need tilting, a slab does.
        LEAN_MAX_DEG: 32,
        LEAN_FROM: 0.6,     // thinner than this stays perfectly flat
        MAX_THICK: 24,
    };

    const clampThick = (t) => {
        const n = (typeof t === "number" && isFinite(t)) ? t : DEAL.THICK;
        // Never zero: at zero the two faces are coincident and z-fight.
        return Math.max(0.2, Math.min(DEAL.MAX_THICK, n));
    };
    const leanFor = (thick) => (thick <= DEAL.LEAN_FROM ? 0
        : DEAL.LEAN_MAX_DEG * Math.PI / 180 * Math.min(1, thick / DEAL.MAX_THICK));

    // rect is where the real card sits (viewport px). faceImg is the site's own
    // decoded <img>. onFaceUp fires once, at the end of the turn.
    //
    // The card STAYS when the animation finishes — it is the card on the board
    // from then on, and the site's own image stays covered behind it. So the mesh
    // is added to the scene directly and the animation drives it from the
    // outside: the actor's own object3D is an empty stand-in, which is what lets
    // the actor end (and the loop idle) while the card remains.
    //
    // Returns a handle. The caller owns the card's life from that point: move()
    // it when the slot moves, remove() it when the board changes. Nothing here
    // expires on its own.
    function dealCard(rect, faceImg, opts) {
        const s = ensureSession();
        if (!s || !rect || !rect.width || !faceImg) return null;
        const T = window.THREE;
        if (!T) return null;
        const o = opts || {};
        const group = cardMesh(T, faceImg, o.backStyle);
        if (!group) return null;
        s.scene.add(group);

        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        // Scaling the unit planes is what sizes the card, so it lands exactly the
        // size of the element it is standing in for however the table is scaled.
        const w = rect.width, h = rect.height;
        const fromX = cx + (o.lead == null ? DEAL.LEAD : o.lead);
        const fromY = -DEAL.OVER;                  // off the top of the viewport
        const delay = Math.max(0, o.delay || 0);

        let t = -delay, facedUp = false, parked = false, gone = false;
        let thick = clampThick(o.thickness);
        let lean = leanFor(thick);
        // Mutable, so move() can follow the slot after the card has landed.
        let atX = cx, atY = cy, atW = w, atH = h;
        const put = (x, y, turn, spin, scale) => {
            group.position.set(x, -y, DEAL.Z);
            // Turn about screen Y is the flip; the camera is orthographic, so the
            // card's width is simply scaled by cos(turn) — which is what an
            // edge-on card does, no perspective needed. The lean is outermost of
            // the three (Euler XYZ applies z, then y, then x), so a leaning card
            // flips rather than a flipping card leaning.
            // NEGATIVE: rotating +x tips the card's top toward the viewer, which
            // shows its top edge and reads as a card leaning back. The table is
            // seen from above, so the edge that should show is the near one —
            // tip the top AWAY and the underside band lands below the face.
            group.rotation.set(-lean, turn, spin);
            // z is NOT scaled to the card's box: local z runs -0.5..+0.5, so this
            // is the thickness in CSS px.
            //
            // The face is sized so the whole SLAB fills the slot, edge included:
            // a leaned card projects its face at cos(lean) of its height and adds
            // thick*sin(lean) of edge below it, so solving for the face height
            // keeps the card's footprint exactly the box it stands in for however
            // fat it gets. Fatten it and the edge eats into the face rather than
            // the card growing out of its slot.
            const edge = thick * Math.sin(lean);
            const faceH = Math.max(1, atH * scale - edge) / Math.cos(lean);
            group.scale.set(atW * scale, faceH, thick);

            const sh = group.userData.gpeShadow;
            if (sh) {
                // Positioned in LOCAL units, so it is a fraction of the card
                // whatever size the card is, and it grows and slides further out
                // as the card thickens — a card standing higher off the felt
                // throws its shadow further. Down and to the right, because the
                // light is up and to the left (CARD_KEY_DIR).
                const drop = 0.03 + thick * 0.006;
                sh.position.set(drop * 0.6, -drop, -0.55);
                // 1.39, because the blur is padding INSIDE the texture: 18px of
                // 128 at each edge leaves the solid part 72% of it, so the quad
                // has to be 1/0.72 for that part to cover the card.
                const spread = 1.39 + thick * 0.004;
                sh.scale.set(spread, spread, 1);
                sh.material.opacity = Math.min(0.95, 0.4 + thick * 0.025);
            }
        };
        // Face down: the back is the side pointing at us, so start turned over.
        put(fromX, fromY, Math.PI, DEAL.SPIN, DEAL.GROW);
        group.visible = false;                     // nothing to see during the delay

        const actor = {
            object3D: group,
            step(dt) {
                t += dt;
                if (t < 0) return true;
                group.visible = true;
                if (t < DEAL.FLY) {
                    const p = easeOutCubic(t / DEAL.FLY);
                    put(fromX + (atX - fromX) * p, fromY + (atY - fromY) * p,
                        Math.PI, DEAL.SPIN * (1 - p), DEAL.GROW + (1 - DEAL.GROW) * p);
                    return true;
                }
                const afterFly = t - DEAL.FLY;
                if (afterFly < DEAL.HOLD) { put(atX, atY, Math.PI, 0, 1); return true; }
                const fp = (afterFly - DEAL.HOLD) / DEAL.FLIP;
                if (fp < 1) {
                    // Lifts as it turns and settles back, so the card looks like
                    // it is being turned over rather than swivelling in place.
                    const lift = Math.sin(fp * Math.PI) * 7;
                    put(atX, atY - lift, Math.PI * (1 - easeInOutCubic(fp)), 0,
                        1 + Math.sin(fp * Math.PI) * 0.06);
                    return true;
                }
                put(atX, atY, 0, 0, 1);
                if (!facedUp) {
                    facedUp = true;
                    if (o.onFaceUp) { try { o.onFaceUp(); } catch (e) {} }
                }
                if (afterFly - DEAL.HOLD - DEAL.FLIP < DEAL.REST) return true;
                // Done animating; the card stays exactly here. The actor ends so
                // the loop can idle, and the mesh is not the actor's to take with
                // it — see the stand-in object3D below.
                parked = true;
                return false;
            },
            // Deliberately an empty group: addActor puts this in the scene and
            // removeActor takes it out again, which must not touch the card.
            object3D: new T.Group(),
        };
        if (!addActor(actor)) { s.scene.remove(group); return null; }

        return {
            // Follow the slot. Called when the layout has shifted under a card
            // that has already landed; while the loop is idle nothing would
            // redraw on its own, hence the dirty flag.
            move(r) {
                if (gone || !r || !r.width) return;
                atX = r.left + r.width / 2;
                atY = r.top + r.height / 2;
                atW = r.width; atH = r.height;
                if (parked) put(atX, atY, 0, 0, 1);
                s.dirty = true;
                kick(s);
            },
            remove() {
                if (gone) return;
                gone = true;
                actor.step = () => false;           // stop it if still animating
                s.scene.remove(group);
                // Ours to free: the per-card materials and the face texture.
                // (three's Material.dispose() never frees the textures on it, and
                // the back is shared across every card so it is left alone.)
                eachMaterial(group, (m) => m.dispose());
                const tex = group.userData && group.userData.gpeFaceTex;
                if (tex) { try { tex.dispose(); } catch (e) {} }
                s.dirty = true;
                kick(s);
            },
            // Swap the face for a sharper (or recoloured) copy of itself, without
            // disturbing the animation. The card is a TEXTURE, so it is only as
            // sharp as the image it was uploaded from — and the image the page
            // shows is authored at the size the page lays out at, not the size
            // this is drawn at. Rather than delay the deal waiting for a bigger
            // one to rasterise, it starts with what is there and is upgraded the
            // moment the better copy exists.
            retexture(src) {
                if (gone || !src) return false;
                const mat = group.userData && group.userData.gpeFaceMat;
                if (!mat) return false;
                let tex = null;
                try { tex = cardTexture(T, src); } catch (e) { return false; }
                const old = group.userData.gpeFaceTex;
                mat.map = tex;
                mat.needsUpdate = true;
                group.userData.gpeFaceTex = tex;
                if (old) { try { old.dispose(); } catch (e) {} }
                // A parked card is not being drawn every frame, so ask for one.
                s.dirty = true;
                kick(s);
                return true;
            },
            // Live from the slider: no geometry is rebuilt, because thickness is
            // only the group's z scale.
            setThickness(t) {
                if (gone) return;
                const next = clampThick(t);
                if (next === thick) return;
                thick = next;
                lean = leanFor(thick);
                if (parked) put(atX, atY, 0, 0, 1);
                s.dirty = true;
                kick(s);
            },
            thickness() { return thick; },
            isParked() { return parked && !gone; },
            isGone() { return gone; },
        };
    }

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

        // --- reaching table height
        if (c.h <= 0) {
            // Confetti coming down off the felt is never caught: it keeps dropping
            // through the table plane and out of sight (h just goes on negative),
            // rather than resting on the black surround. Retired once well below.
            // Chips that come down ON the felt land and settle as usual.
            if (c.fallThrough && (!c.felt || !overFelt(c.felt, c.p))) {
                if (c.h < -VOID_DEPTH) { c.phase = "fade"; c.alpha = 0; }
            } else {
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
            c.shadow.scale.setScalar(clamp(k, 0.35, 1) * (c.shadowScale || 1));
            // Once a chip drops below the table plane (only confetti does), it has
            // left the table — kill its shadow so it doesn't linger on the felt.
            c.shadow.material.opacity = c.h < 0 ? 0 : 0.38 * k * c.alpha;
        }
    }

    function frame(s, now) {
        if (!s.enabled) return;
        s.raf = requestAnimationFrame((t) => frame(s, t));
        const dt = Math.min((now - (s.last || now)) / 1000, 0.05);
        s.last = now;

        if (!s.coins.length && !s.actors.length) {
            // Nothing in the air: idle the loop rather than burning frames.
            //
            // Cards PARKED on the board are still in the scene and still on
            // screen while it idles: the context keeps its last frame, because
            // the renderer is built with preserveDrawingBuffer. So a board full
            // of dealt cards costs nothing per frame — it only has to be drawn
            // again when one of them moves, which is what dirty is for (a window
            // resize, or the table being scaled under them).
            if (s.dirty) {
                s.dirty = false;
                syncViewport(s);
                s.renderer.render(s.scene, s.camera);
            }
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
            s.camera.layers.enable(CARD_LAYER);   // ...or the cards are not drawn
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
            from = { x: to.x, y: viewportSize().h - 20, h: 40 };
        }
        const coin = addCoin(s, from, to, feltBounds(tableRect), o);
        if (!coin) return false;
        coin.onHit = o.onHit || null;
        kick(s);
        return true;
    }

    // ---------- celebratory burst ----------
    // A spray of chips out of a seat, up into the air and back down onto the felt,
    // like confetti. Unlike toss() there is no target to bounce off: each chip is
    // spawned straight into the ballistic "table" phase with an upward kick and a
    // random landing spot on the felt, then rides the very same land / flatten /
    // rest / fade path a tossed chip does — stepCoin, place, and removeCoin handle
    // it, so this adds a launcher, not a second physics.
    //   fromRect   the celebrant's avatar rect; the burst originates here
    //   tableRect  the table element's rect, for scattering the chips onto the felt
    //   opts       { count } — how many chips (clamped to CONFETTI_MAX)
    function confetti(fromRect, tableRect, opts) {
        if (!fromRect || !fromRect.width) return false;
        const s = ensureSession();
        if (!s) return false;
        const T = window.THREE;
        const o = opts || {};
        const felt = feltBounds(tableRect);
        const count = clamp(Math.round(o.count || CONFETTI_COUNT), 1, CONFETTI_MAX);

        const ox = fromRect.left + fromRect.width / 2;
        const oy = fromRect.top + fromRect.height * 0.45;  // out of the middle of the avatar
        const h0 = fromRect.height * 0.5;                  // starting a little off the ground

        // A gentle drift toward the table center, added to every chip's random
        // spread, so the burst leans onto the felt (more chips land) without
        // becoming an aimed stream. Zero when there's no table to lean toward.
        let bx = 0, by = 0;
        if (felt) {
            const dx = felt.cx - ox, dy = felt.cy - oy;
            const d = Math.hypot(dx, dy) || 1;
            bx = (dx / d) * CONFETTI_BIAS;
            by = (dy / d) * CONFETTI_BIAS;
        }

        let made = 0;
        for (let i = 0; i < count; i++) {
            const def = projectileFor("chip");
            const mesh = def.make(T, s, {});   // no denom -> a random one, so colors mix
            if (!mesh) break;                  // chip art unavailable
            mesh.userData.gpeBaseScale = CONFETTI_SCALE;   // place() honors this for the mesh
            const shadow = new T.Mesh(s.shadowGeo, s.shadowMat.clone());
            s.scene.add(mesh, shadow);

            // Straight up with a strong pop, plus a random horizontal drift in any
            // direction so the burst fans out. No aiming: where a chip comes down
            // is wherever it comes down — onto the felt, or off it into the void.
            const vh = rand(CONFETTI_VH[0], CONFETTI_VH[1]);
            const ang = rand(0, Math.PI * 2);
            const sp = Math.sqrt(Math.random()) * CONFETTI_SPREAD;

            const c = {
                mesh, shadow,
                p: { x: ox, y: oy },
                v: { x: Math.cos(ang) * sp + bx, y: Math.sin(ang) * sp + by },
                h: h0, vh: vh,
                phase: "table", landed: false,   // straight to the drop-toward-felt phase
                fallThrough: true,               // off the felt -> keep falling into the void
                to: null, felt, land: null,
                shadowScale: CONFETTI_SCALE,      // match the shrunk chip (place() reads this)
                q: new T.Quaternion(),
                // Tumble about a random axis, so they flutter like confetti rather
                // than all spinning end-over-end along one line of travel.
                tumbleAxis: new T.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)),
                tumbleRate: rand(TUMBLE[0], TUMBLE[1]) * (Math.random() < 0.5 ? -1 : 1),
                flatT: 0, flatFrom: null, flatTo: null,
                restT: 0, alpha: 1,
                kind: "chip",
            };
            if (c.tumbleAxis.lengthSq() < 1e-6) c.tumbleAxis.set(1, 0, 0);
            c.tumbleAxis.normalize();
            if (def.basePose) def.basePose(T, c.q);
            s.coins.push(c);   // pushed directly, past addCoin's MAX_COINS trim
            made++;
        }
        if (!made) return false;
        kick(s);
        return true;
    }

    // Is a point over the playable felt? Used to decide whether a falling confetti
    // chip is caught by the table or drops past it into the void.
    function overFelt(f, p) {
        const dx = (p.x - f.cx) / f.ax, dy = (p.y - f.cy) / f.by;
        return dx * dx + dy * dy <= FELT_EDGE * FELT_EDGE;
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
        toss, confetti, disable, registerProjectile, addActor, feltBounds, chipMesh, dealCard,
        // Draw once more. Needed because parked cards are held on a canvas the
        // loop is allowed to stop rendering — a resize clears it, and nothing
        // else would put them back.
        redraw: () => { const s = session; if (s) { s.dirty = true; kick(s); } },
        hasCanvas: () => !!(session && session.canvas && session.canvas.isConnected),
        isRunning: () => !!(session && (session.coins.length || session.actors.length)),
        _session: () => session,
    };
})();
