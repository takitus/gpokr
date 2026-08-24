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
    const ELEV_DEG = 64;         // 90 = straight down; lower tilts the table back more
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
    const KEY_POS = [-6, 15, 11]; // upper, slightly left, toward the viewer
    const FILL = 0.16;
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

    function tableEl() { return document.querySelector(".iogc-GameWindow-table"); }

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
            const host = document.querySelector(".iogc-GameWindow-table");
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
    function placeSeats(s) {

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

        const ray = new T.Raycaster();
        const plane = new T.Plane(new T.Vector3(0, 1, 0), -seatY);
        const ndc = new T.Vector2();
        const hit = new T.Vector3();
        SEATS_ART.forEach(([ax, ay], i) => {
            const seat = s.seats.children[i];
            if (!seat) return;
            ndc.set((ax * scale) / r.width * 2 - 1, -((ay * scale) / r.height * 2 - 1));
            ray.setFromCamera(ndc, s.camera);
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

    // Load the bundled gpokr logo (one of our own resources either way, so no
    // cross-origin taint) and hand back a CanvasTexture + its aspect ratio.
    function loadLogoTexture(T, onReady) {
        const url = assetUrl("assets/gpokr-logo.svg");
        if (!url) return;
        const img = new Image();
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

    // ---------- card shadow casters ----------
    // Invisible stand-ins for the cards, so the felt they lie on can show a real
    // shadow of them.
    //
    // The cards themselves are drawn by coin3d, on its own canvas over the page,
    // and a shadow cannot cross two WebGL contexts. But nothing says the CASTER
    // has to be the thing you see: a card-shaped box in this scene, lit by this
    // scene's key light, drops a real shadow on a felt that already has
    // receiveShadow — as do the rail, the floor and the seats.
    //
    // The obvious way to hide it does NOT work, and that is worth writing down
    // because it invites being tidied up. three's shadow pass reads:
    //
    //     if (object.visible === false) return;
    //     const visible = object.layers.test(camera.layers);
    //     if (visible && object.isMesh) { if (object.castShadow) ... }
    //
    // and that camera is the MAIN camera. An object parked on a layer the camera
    // never draws does not cast either, and an invisible one is skipped outright.
    // So a caster stays on the default layer, stays visible, and draws nothing
    // instead: colorWrite off, depthWrite off. The shadow pass builds its own
    // depth material and consults neither.

    // A whole-set call rather than add/update/remove: content.js already re-states
    // what is on the table every poll, and a set call needs no reconciliation to
    // survive this renderer being torn down and rebuilt on every GWT re-render.
    //
    // Each entry is a card's viewport rect in CSS px plus its thickness:
    //   { left, top, width, height, thick }
    function setCardCasters(list) {
        const s = session;
        if (!s || !s.cardCasters) return false;
        const T = window.THREE;
        const el = tableEl();
        const r = el && el.getBoundingClientRect();
        // Only cards that are ON the felt. A player's own two cards sit at their
        // seat, well outside it, and their screen position maps to a point beyond
        // the rail — where a caster would plant a card-shaped smudge on the
        // leather, or on the floor ten units below, since both receive shadows.
        // Those keep coin3d's own shadow instead.
        const items = (r && r.width >= 40) ? (list || []).filter((c) => {
            if (!s.feltA || !s.feltB) return true;
            const wpp0 = VIEW_W / r.width, scale0 = r.width / ART_W;
            const X = (c.left + c.width / 2 - r.left - FELT_CX_PX * scale0) * wpp0;
            const Z = (c.top + c.height / 2 - r.top - (FELT_CY_PX + FELT_Y_NUDGE) * scale0) * wpp0 / s.sinE;
            // The felt is a stadium; an ellipse through the same half-extents is
            // close enough to decide whether a card is on the cloth at all.
            const ex = X / (s.feltA * 0.98), ez = Z / (s.feltB * 0.98);
            return ex * ex + ez * ez <= 1;
        }) : [];
        const kids = s.cardCasters.children;

        while (kids.length > items.length) s.cardCasters.remove(kids[kids.length - 1]);
        while (kids.length < items.length) {
            const m = new T.Mesh(s.casterGeo, s.casterMat);
            m.castShadow = true;
            s.cardCasters.add(m);
        }

        const wpp = r ? VIEW_W / r.width : 0;              // world units per css px
        const scale = r ? r.width / ART_W : 0;
        let changed = kids.length !== s.casterCount;
        s.casterCount = kids.length;
        items.forEach((c, i) => {
            const m = kids[i];
            if (!m || !r) return;
            // The same conversion projectAbove uses, in the same direction: a page
            // point onto the felt plane. Z carries the 1/sinE stretch, because a
            // plane seen at an angle covers more world per screen pixel.
            const cxPage = c.left + c.width / 2, cyPage = c.top + c.height / 2;
            const X = (cxPage - r.left - FELT_CX_PX * scale) * wpp;
            const Z = (cyPage - r.top - (FELT_CY_PX + FELT_Y_NUDGE) * scale) * wpp / s.sinE;
            const h = Math.max(0.02, (c.thick || 2) * wpp);
            // Sitting ON the felt rather than above it: the underside is the felt
            // top, so what it drops is a contact shadow, not a hovering one.
            const sx = Math.max(0.01, c.width * wpp);
            const sz = Math.max(0.01, c.height * wpp / s.sinE);
            const y = -FELT_DROP + h / 2;
            // Only mark the scene dirty when something actually MOVED. This is
            // called on the 300ms poll for as long as a board is out, and a
            // static board must cost nothing: an unconditional bump re-renders
            // the felt, rail, floor, nine stools and a 2048 shadow map several
            // times a second forever, where today an unchanged table renders zero
            // times (see the needsRender counter in loop()).
            if (Math.abs(m.position.x - X) > 0.002 || Math.abs(m.position.z - Z) > 0.002 ||
                Math.abs(m.position.y - y) > 0.002 || Math.abs(m.scale.x - sx) > 0.002 ||
                Math.abs(m.scale.y - h) > 0.002 || Math.abs(m.scale.z - sz) > 0.002) {
                changed = true;
            }
            m.position.set(X, y, Z);
            m.scale.set(sx, h, sz);
        });
        if (changed) s.needsRender = Math.max(s.needsRender, 2);
        return true;
    }

    function projectAbove(pageX, pageY, hCss) {
        const s = session;
        if (!s || !s.camera || !s.placed) return null;
        const el = tableEl();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return null;
        const T = window.THREE;
        if (!T) return null;
        const wpp = VIEW_W / r.width;          // world units per css px
        const scale = r.width / ART_W;         // css px per art px
        const X = (pageX - r.left - FELT_CX_PX * scale) * wpp;
        const Z = (pageY - r.top - (FELT_CY_PX + FELT_Y_NUDGE) * scale) * wpp / s.sinE;
        const v = new T.Vector3(X, hCss * wpp, Z).project(s.camera);   // -> NDC
        return {
            x: r.left + (v.x * 0.5 + 0.5) * r.width,
            y: r.top + (-v.y * 0.5 + 0.5) * r.height,
        };
    }

    function buildScene(s) {
        const T = window.THREE;
        s.scene = new T.Scene();

        s.scene.add(new T.AmbientLight(0xffffff, AMBIENT));
        const key = new T.DirectionalLight(0xffffff, KEY);
        key.position.set(KEY_POS[0], KEY_POS[1], KEY_POS[2]);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        const sc = key.shadow.camera;
        sc.left = -22; sc.right = 22; sc.top = 16; sc.bottom = -16;
        sc.near = 1; sc.far = 80;
        sc.updateProjectionMatrix();
        s.scene.add(key);
        const fill = new T.DirectionalLight(0xbfd0d8, FILL);
        fill.position.set(8, 9, -6);
        s.scene.add(fill);

        // Overhead table light with falloff -> center-bright felt (see notes).
        const overhead = new T.PointLight(OVERHEAD_COL, OVERHEAD, 0, OVERHEAD_DECAY);
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
        const B = FELT_HALF_D_PX * (VIEW_W / ART_W) / s.sinE;  // felt half-depth (un-foreshortened)
        s.feltA = A; s.feltB = B;
        s.feltAspect = A / B;

        // Holder for the card shadow casters (see setCardCasters). Empty until
        // content.js says what is on the table, and built with the scene, which is
        // what carries it through the disable/enable churn of a table re-render.
        s.casterGeo = new T.BoxGeometry(1, 1, 1);
        s.casterMat = new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
        s.cardCasters = new T.Group();
        s.scene.add(s.cardCasters);                                   // for ~square texture tiles

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
            // depthTest:false + renderOrder so it always composites onto the felt
            // (a plane at felt height otherwise loses the depth test against it).
            s.logoMat = new T.MeshBasicMaterial({
                map: tex, transparent: true, opacity: logoOpacity,
                depthWrite: false, depthTest: false,
            });
            const logo = new T.Mesh(s.logoGeo, s.logoMat);
            logo.renderOrder = 10;
            logo.rotation.x = -Math.PI / 2;
            logo.position.set(0, 0.05, 0);  // just above the felt, centered
            s.scene.add(logo);
            s.needsRender = Math.max(s.needsRender, 2); // redraw now it's in
        });
    }

    // ---------- lifecycle ----------
    function loop(s) {
        if (!s.enabled) return;
        s.raf = requestAnimationFrame(() => loop(s));
        const r = syncToTable(s);
        if (r === "gone") { disable(); return; }
        if (r) {
            s.needsRender = Math.max(s.needsRender, 2);
            placeSeats(s);    // reframed: the seat rays moved with the camera
        }
        // Dark mode toggles without a reload, so the floor has to follow it.
        if (s.floor && s.floorDark !== isDarkTheme()) {
            applyBackdrop(s);
        }
        if (s.needsRender > 0) { s.renderer.render(s.scene, s.camera); s.needsRender--; }
    }

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
        s.raf = requestAnimationFrame(() => loop(s));
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
        [s.feltGeo, s.railGeo, s.wallGeo, s.logoGeo, s.floorGeo,
            s.stoolSeatGeo, s.stoolLegGeo, s.stoolStretchGeo, s.casterGeo]
            .concat(s.chairGeos || []).forEach((g) => g && g.dispose());
        [s.feltMat, s.railMat, s.wallMat, s.logoMat, s.floorMat,
            s.stoolSeatMat, s.stoolWoodMat,
            s.chairPadMat, s.chairPrintMat, s.chairTubeMat,
            s.casterMat].forEach((m) => m && m.dispose());
        if (s.floorMat && s.floorMat.map) s.floorMat.map.dispose();
        if (s.chairWeave) s.chairWeave.dispose();
        if (s.chairPrint) s.chairPrint.dispose();
        if (s.feltNormal) s.feltNormal.dispose();
        if (s.feltColor) s.feltColor.dispose();
        if (s.railColor) s.railColor.dispose();
        if (s.railNormal) s.railNormal.dispose();
        if (s.logoTex) s.logoTex.dispose();
        if (s.renderer) {
            s.renderer.dispose();
            if (s.renderer.forceContextLoss) s.renderer.forceContextLoss();
        }
        if (s.canvas && s.canvas.parentNode) s.canvas.remove();
        restoreHost(s.host, s.saved);
        if (session === s) session = null;
    }

    function disable() { if (session) dispose(session); }

    window.GPE_TABLE3D = { enable, disable, setTexZoom, setTexDepth, setFeltColor, setLeatherColor, setLogoOpacity, setSurroundColor, setBackdrop, setSeats, projectAbove, feltMaskParams, setCardCasters, isOn: () => !!session, _session: () => session };
})();
