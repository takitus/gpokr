#!/usr/bin/env python3
"""
Regenerate the DECK_HASHES table in content.js — the four-color deck's map from
a card image to the card it depicts.

Why a table at all. Recoloring diamonds blue and clubs green means aiming a
filter at individual cards, and nothing in gpokr's DOM says which card an <img>
is: GWT inlines all 52 faces into its bundle as data: URIs (so there is no
filename in the src), the bundle is minified (so no identifier survives), and the
<img>s are recycled between hands with their src swapped (so position is no
anchor either). What is stable is the artwork, so identity is a hash of the src.
Exact, and incapable of guessing a suit wrong.

How the cards get their names. The bundle's payloads are anonymous, so they are
matched against the CDN copies at img.iogc.org/GPokr/cards/<card>.png, which are
named. Those two copies are *not* byte-identical — they were encoded separately,
and differ in the RGB left under fully transparent pixels — so the comparison is
on visible color only: every pixel composited over white. On that basis all 52
match exactly, one CDN card each, which is what makes the naming trustworthy
rather than a nearest-neighbour guess.

Run it when the recoloring stops working, which is what a reshipped deck looks
like from the outside (content.js also logs a warning when it meets a 53x69 image
it cannot name). Paste the printed block over DECK_HASHES in content.js and
re-run `node deck.test.js`.

Usage:  python3 tools/deck_hashes.py
Stdlib only — no third-party image library, hence the small PNG reader below.
"""

import collections
import re
import struct
import urllib.request
import zlib
from base64 import b64decode

HOME = "https://gpokr.com/"
CDN = "https://img.iogc.org/GPokr/cards/{}.png"
RANKS = "23456789TJQKA"
SUITS = "cdhs"
CARD_W, CARD_H = 53, 69


def get(url):
    # Both hosts sit behind Cloudflare, which 403s urllib's default User-Agent.
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


# ---------------------------------------------------------------- PNG decoding
def png_visible(raw):
    """Every pixel of an 8-bit RGBA PNG, composited over white.

    Compositing is the whole point: it throws away the arbitrary RGB that sits
    under alpha-0 pixels, which is the only place the bundle's copy of a card and
    the CDN's copy disagree. What is left is what a player actually sees, so two
    encodings of the same artwork compare equal.
    """
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    idat, ihdr, i = b"", None, 8
    while i < len(raw):
        (ln,) = struct.unpack(">I", raw[i:i + 4])
        typ, data = raw[i + 4:i + 8], raw[i + 8:i + 8 + ln]
        if typ == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", data)
        elif typ == b"IDAT":
            idat += data
        i += 12 + ln
    if not ihdr:
        return None
    w, h, depth, color = ihdr[0], ihdr[1], ihdr[2], ihdr[3]
    if (depth, color) != (8, 6):          # 8-bit RGBA is all the deck uses
        return None

    bpp, stride = 4, w * 4
    lines, prev, buf, p = [], bytearray(stride), zlib.decompress(idat), 0
    for _ in range(h):
        filt = buf[p]
        p += 1
        line = bytearray(buf[p:p + stride])
        p += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if filt == 1:
                line[x] = (line[x] + a) & 255
            elif filt == 2:
                line[x] = (line[x] + b) & 255
            elif filt == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif filt == 4:                # Paeth
                est = a + b - c
                pa, pb, pc = abs(est - a), abs(est - b), abs(est - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        lines.append(bytes(line))
        prev = line

    out = []
    for line in lines:
        for x in range(w):
            r, g, b, alpha = line[x * 4:x * 4 + 4]
            f = alpha / 255
            out.append((round(r * f + 255 * (1 - f)),
                        round(g * f + 255 * (1 - f)),
                        round(b * f + 255 * (1 - f))))
    return (w, h), tuple(out)


def fnv1a32(s):
    """Must stay identical to fnv1a32() in content.js."""
    h = 0x811C9DC5
    for ch in s.encode("ascii"):
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


# ------------------------------------------------------------------- the bundle
def bundle_payloads():
    """Every base64 payload the GWT bundle inlines, and a note on the permutations.

    GWT ships one compiled permutation per browser profile. They are checked
    against each other because a card that hashed differently per permutation
    would make the table browser-dependent — the deck is in fact shared, so one
    table covers every visitor.
    """
    home = get(HOME).decode("utf-8", "replace")
    m = re.search(r'src="(/[^"]*?\.nocache\.js)"', home) or re.search(r"(/gpokr2/gpokr2\.nocache\.js)", home)
    if not m:
        raise SystemExit("could not find the GWT selection script on " + HOME)
    selector = get(HOME.rstrip("/") + m.group(1)).decode("utf-8", "replace")
    base = HOME.rstrip("/") + m.group(1).rsplit("/", 1)[0]
    perms = sorted(set(re.findall(r"\b[0-9A-F]{32}\b", selector)))
    if not perms:
        raise SystemExit("no permutation strong names in the selection script")

    sets = []
    for p in perms:
        js = get("{}/{}.cache.js".format(base, p)).decode("utf-8", "replace")
        sets.append(set(re.findall(r"data:image/png;base64,([A-Za-z0-9+/=]+)", js)))
    shared = "identical" if all(s == sets[0] for s in sets) else "DIFFER"
    print("# {} permutation(s), inlined images {}".format(len(perms), shared))
    if shared == "DIFFER":
        raise SystemExit("permutations inline different images — one table cannot cover both")
    return sets[0]


def main():
    print("# reading the deck the CDN names...")
    refs = {}
    for r in RANKS:
        for s in SUITS:
            card = r + s
            got = png_visible(get(CDN.format(card)))
            if not got or got[0] != (CARD_W, CARD_H):
                raise SystemExit("unexpected CDN art for " + card)
            refs[got[1]] = card
    if len(refs) != 52:
        raise SystemExit("CDN deck is not 52 distinct images (got {})".format(len(refs)))

    print("# reading the deck the site ships...")
    table, unmatched = {}, 0
    for payload in bundle_payloads():
        got = png_visible(b64decode(payload))
        if not got or got[0] != (CARD_W, CARD_H):
            continue                        # chips, avatars, the card back
        card = refs.get(got[1])
        if card is None:
            unmatched += 1
            continue
        table[card] = fnv1a32(payload)

    if unmatched:
        raise SystemExit("{} card-sized image(s) matched no CDN card — the site's deck "
                         "artwork has changed, so it can no longer be named this way".format(unmatched))
    if len(table) != 52:
        raise SystemExit("named {} of 52 cards".format(len(table)))
    dupes = [h for h, n in collections.Counter(table.values()).items() if n > 1]
    if dupes:
        raise SystemExit("hash collision: " + ", ".join(dupes))

    print("# 52/52 named, no collisions — paste over DECK_HASHES in content.js\n")
    print("    const DECK_HASHES = {")
    for s in SUITS:
        print('        {}: "{}",'.format(s, " ".join(table[r + s] for r in RANKS)))
    print("    };")


if __name__ == "__main__":
    main()
