/*
 * deck-svg.js — a vector deck for the classic table.
 *
 * gpokr's new UI (/?ui=new) draws its cards as SVG rather than the 53x69 PNGs
 * the classic table uses. It does not ship a deck of images: it composes each
 * card at runtime from a handful of path strings and a layout table, and only
 * the twelve court cards are separate files. Those tables are reproduced below —
 * lifted verbatim from assets/embed-main-*.cache.js, which is a minified Vite
 * bundle, so they are a SNAPSHOT and not a link: the names they had in it
 * (Yz/Wz/Mw/aa) will not survive gpokr rebuilding it. tools/gen_deck.py is the
 * script that pulled them and can pull them again.
 *
 * What is data from there, and what is ours:
 *   SUIT_PATH   4 paths, one per suit          (theirs)
 *   RANK_PATH   13 paths, stroked glyphs       (theirs)
 *   PIPS        per-rank pip layout            (theirs; also the centuries-old
 *                                               standard arrangement)
 *   GEO         card box, corner positions     (theirs)
 *   the courts  12 SVG files, fetched          (theirs, never copied here)
 *   compose()   everything below               (ours, following their own
 *                                               composition so a card comes out
 *                                               looking like the one they draw)
 *
 * The court cards are FETCHED on demand and never bundled or stored: they are
 * 471KB between them, they are the part with real artistry in it, and the files
 * answer with `access-control-allow-origin: *` when a browser actually asks (the
 * header is conditional on Origin, which is easy to miss with curl). They cache
 * for a day, so it is one request per court card per day at worst, and a card
 * whose art has not arrived yet simply keeps the site's own image.
 *
 * Each file defines six layered symbols named <SUIT><RANK><1..6> and refers to
 * `#S<SUIT>` for the suit pip, which it does not define — so the pip symbol here
 * is named to match, and the court art picks up the four-colour ink for free.
 *
 * Exposes window.GPE_DECK = { faceUrl, onReady, has }.
 */
(function () {
    "use strict";

    // Their tables, verbatim. Suits are upper case here (S/H/D/C) and ranks use
    // T for ten, which is how they key them; content.js's own card codes are
    // rank-upper suit-lower ("Th"), so faceUrl() converts.
    const GEO = {viewBox:{x:-120,y:-168,width:210,height:280},background:{x:-119.5,y:-167.5,width:210,height:280,
        rx:12},innerBox:{x:-52,y:-150,width:130,height:250},cornerRank:{x:-122,y:-156,size:70},
        cornerSuit:{x:-116.279,y:-81,size:58.558}};

    const SUIT_PATH = {C:"M30 150C35 385 85 400 130 500L-130 500C-85 400 -35 385 -30 150A10 10 0 0 0 -50 150A210 210 0 1 1 -124 -51A10 10 0 0 0 -110 -65A230 230 0 1 1 110 -65A10 10 0 0 0 124 -51A210 210 0 1 1 50 150A10 10 0 0 0 30 150Z",
        D:"M-400 0L0 -500L400 0L0 500Z",
        H:"M0 -300C0 -400 100 -500 200 -500C300 -500 400 -400 400 -250C400 0 0 400 0 500C0 400 -400 0 -400 -250C-400 -400 -300 -500 -200 -500C-100 -500 0 -400 -0 -300Z",
        S:"M0 -500C100 -250 355 -100 355 185A150 150 0 0 1 55 185A10 10 0 0 0 35 185C35 385 85 400 130 500L-130 500C-85 400 -35 385 -35 185A10 10 0 0 0 -55 185A150 150 0 0 1 -355 185C-355 -100 -100 -250 0 -500Z"};

    const RANK_PATH = {2:"M-225 -225C-245 -265 -200 -460 0 -460C 200 -460 225 -325 225 -225C225 -25 -225 160 -225 460L225 460L225 300",
        3:"M-250 -320L-250 -460L200 -460L-110 -80C-100 -90 -50 -120 0 -120C200 -120 250 0 250 150C250 350 170 460 -30 460C-230 460 -260 300 -260 300",
        4:"M50 460L250 460M150 460L150 -460L-300 175L-300 200L270 200",
        5:"M170 -460L-175 -460L-210 -115C-210 -115 -200 -200 0 -200C100 -200 255 -80 255 120C255 320 180 460 -20 460C-220 460 -255 285 -255 285",
        6:"M-250 100A250 250 0 0 1 250 100L250 210A250 250 0 0 1 -250 210L-250 -210A250 250 0 0 1 0 -460C150 -460 180 -400 200 -375",
        7:"M-265 -320L-265 -460L310 -460L310 -320L-60 460",
        8:"M-1 -50A205 205 0 1 1 1 -50L-1 -50A255 255 0 1 0 1 -50Z",
        9:"M250 -100A250 250 0 0 1 -250 -100L-250 -210A250 250 0 0 1 250 -210L250 210A250 250 0 0 1 0 460C-150 460 -180 400 -200 375",
        T:"M-260 430L-260 -430M-50 0L-50 -310A150 150 0 0 1 250 -310L250 310A150 150 0 0 1 -50 310Z",
        J:"M50 -460L250 -460M150 -460L150 250A100 100 0 0 1 -250 250L-250 220",
        Q:"M-260 100C40 100 -40 460 260 460M-175 0L-175 -285A175 175 0 0 1 175 -285L175 285A175 175 0 0 1 -175 285Z",
        K:"M-285 -460L-85 -460M-185 -460L-185 460M-285 460L-85 460M85 -460L285 -460M185 -440L-170 155M85 460L285 460M185 440L-10 -70",
        A:"M-270 460L-110 460M-200 450L0 -460L200 450M110 460L270 460M-120 130L120 130"};

    const PIPS = {2:[{x:-7,y:-130,size:40},{x:-33,y:-80,size:40,rotate:!0}],3:[{x:-7,y:-130,size:40},{x:-7,y:-45,
        size:40},{x:-33,y:-80,size:40,rotate:!0}],4:[{x:-40,y:-130,size:40},{x:26,y:-130,size:40},{x:-66,
        y:-80,size:40,rotate:!0},{x:0,y:-80,size:40,rotate:!0}],5:[{x:-40,y:-130,size:40},{x:26,y:-130,
        size:40},{x:-7,y:-45,size:40},{x:-66,y:-80,size:40,rotate:!0},{x:0,y:-80,size:40,rotate:!0}],
        6:[{x:-40,y:-130,size:40},{x:26,y:-130,size:40},{x:-40,y:-45,size:40},{x:26,y:-45,size:40},{x:-66,
        y:-80,size:40,rotate:!0},{x:0,y:-80,size:40,rotate:!0}],7:[{x:-40,y:-130,size:40},{x:26,y:-130,
        size:40},{x:-40,y:-45,size:40},{x:26,y:-45,size:40},{x:-7,y:-85,size:40},{x:-66,y:-80,size:40,
        rotate:!0},{x:0,y:-80,size:40,rotate:!0}],8:[{x:-40,y:-130,size:40},{x:26,y:-130,size:40},{x:-40,
        y:-45,size:40},{x:26,y:-45,size:40},{x:-7,y:-85,size:40},{x:-66,y:-80,size:40,rotate:!0},{x:0,y:-80,
        size:40,rotate:!0},{x:-33,y:-40,size:40,rotate:!0}],9:[{x:-40,y:-130,size:40},{x:26,y:-130,
        size:40},{x:-40,y:-75,size:40},{x:26,y:-75,size:40},{x:-7,y:-45,size:40},{x:-66,y:-80,size:40,
        rotate:!0},{x:0,y:-80,size:40,rotate:!0},{x:-66,y:-25,size:40,rotate:!0},{x:0,y:-25,size:40,
        rotate:!0}],T:[{x:-40,y:-130,size:40},{x:26,y:-130,size:40},{x:-40,y:-75,size:40},{x:26,y:-75,
        size:40},{x:-7,y:-100,size:40},{x:-66,y:-80,size:40,rotate:!0},{x:0,y:-80,size:40,rotate:!0},{x:-66,
        y:-25,size:40,rotate:!0},{x:0,y:-25,size:40,rotate:!0},{x:-33,y:-50,size:40,rotate:!0}],A:[{x:-7,
        y:-45,size:40}],AS:[{x:-52,y:-90,size:130}]};

    // Ink. Their deck is the standard two colours; the four-colour option gets
    // the same blue and green the SVG filters use on the site's own PNGs
    // (overlay.css), so switching decks doesn't switch palettes underneath you.
    const INK = {
        two: { C: "black", D: "red", H: "red", S: "black" },
        four: { C: "#008000", D: "#0000ff", H: "red", S: "black" },
    };

    // Authored at the size of the image it replaces, which the caller passes in.
    //
    // This is layout, not resolution: an SVG's declared width/height decide how
    // big the element WANTS to be, while the rasterizer always draws at device
    // resolution — so matching the site's own 53x69 costs nothing in sharpness
    // and means swapping the src cannot move anything. Authoring bigger (it was
    // 120x168) changes the intrinsic size under gpokr's layout, and then needs
    // width/height attributes to compensate, which is two ways to fight the page
    // at once. preserveAspectRatio="none" for the same reason: 53x69 is slightly
    // narrower than this 3:4 box and a letterboxed card would sit wrong.
    const DEF_W = 53, DEF_H = 69;
    const FACE_BASE = "https://web.gpokr.com/card-symbols/faces/";
    const RANKS_COURT = { J: 1, Q: 1, K: 1 };

    const courtArt = Object.create(null);   // "JS" -> defs markup, or "" once failed
    const courtBusy = Object.create(null);
    const urlCache = Object.create(null);   // "Th|four" -> data: URI
    let readyCb = null;

    const isCourt = (rank) => !!RANKS_COURT[rank];
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

    // One request per court card, ever (per page). A failure is remembered as ""
    // so it is not retried on every sweep — the card keeps the site's own art.
    function ensureCourt(name) {
        if (courtArt[name] !== undefined || courtBusy[name]) return;
        courtBusy[name] = true;
        fetch(FACE_BASE + name + ".svg", { credentials: "omit", cache: "force-cache" })
            .then((r) => (r.ok ? r.text() : ""))
            .then((text) => {
                // The files are <defs>…</defs> with an XML prologue and no <svg>
                // root, so what we want is the inside of that one element.
                const m = /<defs[^>]*>([\s\S]*)<\/defs>/i.exec(text || "");
                courtArt[name] = m ? m[1] : "";
                courtBusy[name] = false;
                if (m && readyCb) { try { readyCb(name); } catch (e) { /* not ours */ } }
            })
            .catch(() => { courtArt[name] = ""; courtBusy[name] = false; });
    }

    // Follows the bundle's own Zz / $z / Kz, so the result is the card they draw.
    function compose(rank, suit, ink, outW, outH) {
        const g = GEO, court = isCourt(rank), col = ink[suit];
        const o = [];
        const use = (id, x, y, w, h, extra) =>
            '<use href="#' + id + '" x="' + x + '" y="' + y + '" width="' + w +
            '" height="' + h + '"' + (extra || "") + "/>";

        o.push('<svg xmlns="http://www.w3.org/2000/svg" id="gpe-face-' + rank +
            suit.toLowerCase() + '" width="' + outW + '" height="' + outH +
            '" viewBox="' + g.viewBox.x + " " + g.viewBox.y + " " + g.viewBox.width +
            " " + g.viewBox.height + '" preserveAspectRatio="none">');
        o.push("<defs>");
        // Named S<SUIT> because that is what the court art asks for; our own
        // pips and corners use it too, so there is one pip in the document.
        o.push('<symbol id="S' + suit + '" viewBox="-600 -600 1200 1200">' +
            '<path d="' + esc(SUIT_PATH[suit]) + '" fill="' + col + '"/></symbol>');
        o.push('<symbol id="RK" viewBox="-500 -500 1000 1000"><path d="' + esc(RANK_PATH[rank]) +
            '" stroke="' + col + '" stroke-width="80" stroke-linecap="square" ' +
            'stroke-miterlimit="1.5" fill="none"/></symbol>');
        if (court) o.push(courtArt[rank + suit] || "");
        o.push("</defs>");

        o.push('<rect x="' + g.background.x + '" y="' + g.background.y + '" width="' +
            g.background.width + '" height="' + g.background.height + '" rx="' +
            g.background.rx + '" fill="white"/>');
        if (!court) {
            o.push('<rect x="' + g.innerBox.x + '" y="' + g.innerBox.y + '" width="' +
                g.innerBox.width + '" height="' + g.innerBox.height + '" stroke="#88f" fill="#FFC"/>');
        }
        o.push(use("RK", g.cornerRank.x, g.cornerRank.y, g.cornerRank.size, g.cornerRank.size));
        o.push(use("S" + suit, g.cornerSuit.x, g.cornerSuit.y, g.cornerSuit.size, g.cornerSuit.size));

        const pips = PIPS[rank] || [];
        const up = pips.filter((p) => !p.rotate);
        const down = pips.filter((p) => p.rotate);

        if (!court && rank === "A") {
            // The ace's single pip, twice: a white halo under a solid one. The
            // ace of spades gets the big one.
            const a = (suit === "S" && PIPS.AS) ? PIPS.AS[0] : up[0];
            if (a) {
                o.push(use("S" + suit, a.x, a.y, a.size, a.size, ' stroke="white" stroke-width="50"'));
                o.push(use("S" + suit, a.x, a.y, a.size, a.size));
            }
        } else if (!court) {
            for (const p of up) o.push(use("S" + suit, p.x, p.y, p.size, p.size));
            if (down.length) {
                o.push('<g transform="rotate(180)">');
                for (const p of down) o.push(use("S" + suit, p.x, p.y, p.size, p.size));
                o.push("</g>");
            }
        } else {
            // Court: six layers, each drawn upright and again rotated a half turn,
            // which is what makes the mirrored figure.
            const id = suit + rank;
            for (let layer = 1; layer <= 6; layer++) {
                o.push(use(id + layer, -52, -150, 130, 250));
                o.push('<g transform="rotate(180)">' + use(id + layer, -80, -100, 130, 250) + "</g>");
            }
            o.push('<rect x="' + g.innerBox.x + '" y="' + g.innerBox.y + '" width="' +
                g.innerBox.width + '" height="' + g.innerBox.height + '" stroke="#44F" fill="none"/>');
            // The pip beside the figure sits on the other side for the suits whose
            // court faces the other way.
            const left = (suit === "H" || suit === "S");
            o.push(use("S" + suit, left ? -50 : 45, -147, 34.4, 34.4));
            o.push('<g transform="rotate(180)">' +
                use("S" + suit, left ? -75 : 21.334, -97.2, 34.4, 34.4) + "</g>");
        }
        o.push("</svg>");
        return o.join("");
    }

    // A data: URI for one card, or null when there is nothing to draw yet — a
    // court card whose art is still on its way, or a card code we don't know.
    // Deliberately NOT base64: the id in the markup is how content.js recognises
    // its own faces, and it has to be readable in the URI to do that.
    // size is the intrinsic size to author at — pass the natural size of the
    // image being replaced, so the swap is invisible to layout.
    function faceUrl(card, fourColor, size) {
        if (typeof card !== "string" || card.length !== 2) return null;
        const rank = card[0].toUpperCase(), suit = card[1].toUpperCase();
        if (!RANK_PATH[rank] || !SUIT_PATH[suit]) return null;
        const w = (size && size.w > 0) ? Math.round(size.w) : DEF_W;
        const h = (size && size.h > 0) ? Math.round(size.h) : DEF_H;
        const key = rank + suit + (fourColor ? "|4" : "|2") + "|" + w + "x" + h;
        if (urlCache[key]) return urlCache[key];
        if (isCourt(rank)) {
            const art = courtArt[rank + suit];
            if (art === undefined) { ensureCourt(rank + suit); return null; }
            if (!art) return null;
        }
        const url = "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(compose(rank, suit, fourColor ? INK.four : INK.two, w, h));
        urlCache[key] = url;
        return url;
    }

    window.GPE_DECK = {
        faceUrl: faceUrl,
        // Called when a court card's art lands, so the caller can sweep again.
        onReady: (fn) => { readyCb = fn; },
        has: (card) => !!(card && RANK_PATH[card[0].toUpperCase()] && SUIT_PATH[card[1].toUpperCase()]),
    };
})();
