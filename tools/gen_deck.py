# Emits deck-svg.js: the deck tables lifted from the new UI's bundle, plus our
# own composition code around them. Run by hand when gpokr reships that bundle.
import re, io, os

SP = os.path.dirname(os.path.abspath(__file__))
src = io.open(os.path.join(SP, "embed.js"), encoding="utf-8", errors="replace").read()


def literal(name):
    m = re.search(r"(?:const |,|;|\b)" + name + r"\s*=\s*([\[{])", src)
    if not m:
        raise SystemExit("not found: " + name)
    start, op = m.start(1), m.group(1)
    cl = "]" if op == "[" else "}"
    depth, i, ins, q = 0, start, False, ""
    while i < len(src):
        c = src[i]
        if ins:
            if c == "\\":
                i += 2
                continue
            if c == q:
                ins = False
        elif c in "\"'":
            ins, q = True, c
        elif c == op:
            depth += 1
        elif c == cl:
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        i += 1
    raise SystemExit("unbalanced " + name)


T = {k: literal(v) for k, v in
     {"GEO": "aa", "SUIT_PATH": "Yz", "RANK_PATH": "Wz", "PIPS": "Mw"}.items()}

# Wrap the numeric-keyed rank tables so they are valid as written: {2:"..."} is
# fine in JS, so they go in verbatim. Only reformat for line length.
def wrap(js, indent="    "):
    out, line = [], indent
    for part in re.split(r"(?<=,)(?=[A-Za-z0-9_\"]+:)", js):
        if len(line) + len(part) > 110 and line.strip():
            out.append(line)
            line = indent + part
        else:
            line += part
    out.append(line)
    return "\n".join(out)


HEAD = '''/*
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
'''

TAIL = '''
    // Ink. Their deck is the standard two colours; the four-colour option gets
    // the same blue and green the SVG filters use on the site's own PNGs
    // (overlay.css), so switching decks doesn't switch palettes underneath you.
    const INK = {
        two: { C: "black", D: "red", H: "red", S: "black" },
        four: { C: "#008000", D: "#0000ff", H: "red", S: "black" },
    };

    // Authored at 2x the size the new UI uses (60x84), so the raster is sharp on
    // a HiDPI display; preserveAspectRatio="none" because the element we stand in
    // for is 53x69, very slightly narrower than this 3:4 box, and a letterboxed
    // card would sit wrong in its slot.
    const OUT_W = 120, OUT_H = 168;
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
                const m = /<defs[^>]*>([\\s\\S]*)<\\/defs>/i.exec(text || "");
                courtArt[name] = m ? m[1] : "";
                courtBusy[name] = false;
                if (m && readyCb) { try { readyCb(name); } catch (e) { /* not ours */ } }
            })
            .catch(() => { courtArt[name] = ""; courtBusy[name] = false; });
    }

    // Follows the bundle's own Zz / $z / Kz, so the result is the card they draw.
    function compose(rank, suit, ink) {
        const g = GEO, court = isCourt(rank), col = ink[suit];
        const o = [];
        const use = (id, x, y, w, h, extra) =>
            '<use href="#' + id + '" x="' + x + '" y="' + y + '" width="' + w +
            '" height="' + h + '"' + (extra || "") + "/>";

        o.push('<svg xmlns="http://www.w3.org/2000/svg" id="gpe-face-' + rank +
            suit.toLowerCase() + '" width="' + OUT_W + '" height="' + OUT_H +
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
    function faceUrl(card, fourColor) {
        if (typeof card !== "string" || card.length !== 2) return null;
        const rank = card[0].toUpperCase(), suit = card[1].toUpperCase();
        if (!RANK_PATH[rank] || !SUIT_PATH[suit]) return null;
        const key = rank + suit + (fourColor ? "|4" : "|2");
        if (urlCache[key]) return urlCache[key];
        if (isCourt(rank)) {
            const art = courtArt[rank + suit];
            if (art === undefined) { ensureCourt(rank + suit); return null; }
            if (!art) return null;
        }
        const url = "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(compose(rank, suit, fourColor ? INK.four : INK.two));
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
'''

body = []
for name in ["GEO", "SUIT_PATH", "RANK_PATH", "PIPS"]:
    body.append("    const %s = %s;" % (name, wrap(T[name], "        ").lstrip()))
    body.append("")

out = HEAD + "\n".join(body) + TAIL
io.open(os.path.join(SP, "deck-svg.js"), "w", encoding="utf-8").write(out)
print("wrote deck-svg.js  %.1f KB" % (len(out) / 1024.0))
