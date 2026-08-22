#!/usr/bin/env python3
"""
Generate assets/backs/*.png — the alternate card backs players can pick in place
of gpokr's own.

    python3 tools/make_cardbacks.py            # write the PNGs
    python3 tools/make_cardbacks.py --preview  # also write comparison sheets

Stdlib only; the vector rasterizer and PNG writer below are why.

WHAT IT HAS TO FIT INTO

gpokr draws a player's two face-down cards as ONE image — not two — placed once
per seat. So a replacement is not "a card back", it is that whole little still
life: two cards, the rear one peeking out up and to the left, both on a soft grey
halo, with transparent corners. Get the footprint wrong and the swap reads as
misaligned rather than as a different deck. The geometry constants below
reproduce it, at SCALE times the site's own 23x26.

WHY IT IS DRAWN AT 4x, WITH VECTORS

The site's asset is 23x26 and GWT pins the display size with width/height
attributes on the <img>, so the intrinsic size of a replacement does not affect
layout at all (verified in the browser: swapping a much larger image in leaves
the box exactly where it was). That means we can ship a 4x image. The browser
downsamples it, and on a HiDPI display — most laptops — there are 2x the device
pixels to fill, so the extra detail survives instead of being thrown away.

Hence vectors rather than hand-set pixels. Everything here is defined as arcs and
slabs and sampled SS x SS times per output pixel, so curves get anti-aliased
edges and the art is resolution-independent: raise SCALE and it just gets finer.

The catch is that the composition still has to survive being squashed to 23x26
for anyone on a 1x display, where fine detail becomes mush however it was
authored. So each design is built from three coarse, high-contrast elements —
border, all-over ground, center medallion — and the filigree inside them is a
bonus for HiDPI rather than the thing carrying the design. `--preview` renders
both sizes so that stays honest.

ON THE DESIGNS

Original drawings in the idiom of classic casino backs: a light border, an
all-over ornamental ground, and a center medallion holding an ornate G for gpokr.
They take inspiration from that tradition without reproducing any house's
artwork — Bicycle's Rider Back, Bee's diamond back, a Bellagio deck and the rest
are live trademarks and trade dress, and copying them into a distributed
extension would be infringement. What carries the look is the *structure*, which
is generic and centuries old, plus the ornamental vocabulary below — rosettes,
diamond lattice, radiating fans, deco chevrons — which likewise belongs to nobody.
"""

import argparse
import math
import os
import struct
import zlib

SCALE = 4                                  # 4x the site's asset; see the docstring
W, H = 23 * SCALE, 26 * SCALE              # 92 x 104
CARD_W, CARD_H = 19 * SCALE, 23 * SCALE    # one card
FRONT = (3 * SCALE, 2 * SCALE)             # top-left of the front card
BACK = (1 * SCALE, 1 * SCALE)              # the rear card, peeking up-and-left
CORNER = 1 * SCALE                         # clipped corner, in output pixels
SHADOW, SHADOW_A = (100, 100, 100), 92     # the halo the cards sit on
SS = 3                                     # supersamples per axis, for smooth edges
OUT_DIR = "assets/backs"                   # shipped: pack.sh copies all of assets/
PREVIEW_DIR = "assets-src"                 # NOT shipped, which is the point

BORDER = 1.6 * SCALE                       # the light rim, in output pixels
MEDALLION_R = 0.315                        # medallion radius, in card widths


# --------------------------------------------------------------- the ornate G
# Built from arcs and slabs rather than a font: no dependency, and it stays sharp
# at whatever scale it is asked for. Coordinates are a unit box centred on the
# glyph, +y up, bowl outer radius 1.
def glyph_g(x, y):
    r = math.hypot(x, y)
    # Everything is clipped to the bowl's circle. Without this the bar and spur
    # poke out past the curve and the letter reads as a C with a tab stuck on —
    # which is exactly how the first attempt looked.
    if r > 1.0:
        return False
    a = math.degrees(math.atan2(y, x))           # -180..180
    RI = 0.68                                    # inner radius; the stroke weight
    # The bowl: a ring with a generous aperture on the right. Narrower and it
    # closes up into an O at small sizes; this was tuned by rendering the glyph
    # at the three sizes it actually gets drawn at.
    if r >= RI and not (-62.0 <= a <= 16.0):
        return True
    # The crossbar, reaching well into the counter so it still registers as a
    # horizontal when the whole letter is only a handful of pixels wide.
    if -0.13 <= y <= 0.13 and x >= 0.14:
        return True
    # The spur dropping from the crossbar's right end, trimmed by the clip above.
    if x >= 0.62 and -0.55 <= y <= 0.13:
        return True
    return False


# ------------------------------------------------------------ ornamental grounds
# Each takes card-local coordinates in PIXELS plus the card size, and returns True
# where the ground's ink falls. Periods are expressed in SCALE so they keep their
# apparent size if SCALE changes.
def ground_rosette(x, y, w, h):
    """Four-petal rosettes on a lattice — the Victorian 'wallpaper' register."""
    P = 5.0 * SCALE
    cx, cy = (x % P) - P / 2, (y % P) - P / 2
    pr, off = 0.9 * SCALE, 1.15 * SCALE
    for dx, dy in ((0, off), (0, -off), (off, 0), (-off, 0)):
        if math.hypot(cx - dx, cy - dy) <= pr:
            return True
    return math.hypot(cx, cy) <= 0.55 * SCALE       # the pip at the centre


def ground_lattice(x, y, w, h):
    """An all-over diamond lattice drawn as outlines. Geometry as old as cards."""
    P = 3.4 * SCALE
    d = abs((x % P) - P / 2) + abs((y % P) - P / 2)
    return abs(d - P / 2.6) <= 0.55 * SCALE


def ground_fan(x, y, w, h):
    """Radiating scalloped arcs, struck from a point below the card."""
    ox, oy = w / 2.0, h * 1.30
    r = math.hypot(x - ox, y - oy)
    return (r % (2.6 * SCALE)) <= 1.1 * SCALE


def ground_deco(x, y, w, h):
    """Stepped chevrons — the deco register, and the boldest at small sizes."""
    P = 4.0 * SCALE
    v = abs((x % (2 * P)) - P)
    return ((y + v) % P) <= 1.5 * SCALE


GROUNDS = {"rosette": ground_rosette, "lattice": ground_lattice,
           "fan": ground_fan, "deco": ground_deco}

# One color family each, so no two backs are confusable across the table.
BACKS = {
    "rosette": dict(ground="rosette", body=(0x8C, 0x1C, 0x28), ink=(0xD9, 0x9A, 0xA2),
                    border=(0xF6, 0xEF, 0xE2), disc=(0xF6, 0xEF, 0xE2),
                    ring=(0xB8, 0x5A, 0x60), glyph=(0x8C, 0x1C, 0x28)),
    "lattice": dict(ground="lattice", body=(0x1C, 0x3F, 0x8C), ink=(0x8E, 0xA8, 0xE8),
                    border=(0xF4, 0xF7, 0xFF), disc=(0xF4, 0xF7, 0xFF),
                    ring=(0x5A, 0x74, 0xB8), glyph=(0x1C, 0x3F, 0x8C)),
    "fan":     dict(ground="fan", body=(0x14, 0x50, 0x3C), ink=(0x7C, 0xB8, 0x9C),
                    border=(0xF2, 0xF6, 0xEC), disc=(0xF2, 0xF6, 0xEC),
                    ring=(0x4A, 0x80, 0x6C), glyph=(0x14, 0x50, 0x3C)),
    "deco":    dict(ground="deco", body=(0x14, 0x15, 0x18), ink=(0x9A, 0x7B, 0x36),
                    border=(0xC8, 0xA1, 0x4A), disc=(0x14, 0x15, 0x18),
                    ring=(0xC8, 0xA1, 0x4A), glyph=(0xE4, 0xC1, 0x6A)),
}


def in_card(x, y):
    """Inside the card rect, with the corner clipped on a diagonal."""
    if not (0 <= x < CARD_W and 0 <= y < CARD_H):
        return False
    return min(x, CARD_W - 1 - x) + min(y, CARD_H - 1 - y) >= CORNER - 1


def card_layers(spec):
    """Ordered (predicate, color) layers for one card, in card-local pixels.

    Later layers paint over earlier ones; the rasterizer resolves each subsample
    against the whole stack, so a curve's edge lands as a blend, not a stair.
    """
    ground = GROUNDS[spec["ground"]]
    w, h = float(CARD_W), float(CARD_H)
    mcx, mcy = w / 2.0, h / 2.0
    mr = MEDALLION_R * w
    gr = mr * 0.72                     # the glyph sits inside the medallion

    def is_field(x, y):                # inside the light border
        return BORDER <= x <= w - BORDER and BORDER <= y <= h - BORDER

    return [
        (lambda x, y: True, spec["border"]),
        (is_field, spec["body"]),
        (lambda x, y: is_field(x, y) and ground(x, y, w, h), spec["ink"]),
        (lambda x, y: math.hypot(x - mcx, y - mcy) <= mr, spec["ring"]),
        (lambda x, y: math.hypot(x - mcx, y - mcy) <= mr - 0.75 * SCALE, spec["disc"]),
        # A hairline concentric ring inside the medallion — the small classical
        # touch that keeps a plain disc from looking like a sticker.
        (lambda x, y: abs(math.hypot(x - mcx, y - mcy) - (mr - 1.6 * SCALE)) <= 0.2 * SCALE,
         spec["ring"]),
        # +y is down in image space, so the glyph's y is flipped.
        (lambda x, y: glyph_g((x - mcx) / gr, (mcy - y) / gr), spec["glyph"]),
    ]


def draw(spec):
    """One card back as a W x H grid of (r, g, b, a)."""
    px = [[(0, 0, 0, 0)] * W for _ in range(H)]
    px = [list(row) for row in px]
    layers = card_layers(spec)
    step, off = 1.0 / SS, 1.0 / (2 * SS)

    def halo(ox, oy):
        for ly in range(-1, CARD_H + 1):
            for lx in range(-1, CARD_W + 1):
                x, y = ox + lx, oy + ly
                if not (0 <= x < W and 0 <= y < H) or px[y][x][3]:
                    continue
                if any(in_card(lx + dx, ly + dy)
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                    px[y][x] = SHADOW + (SHADOW_A,)

    def card(ox, oy):
        for ly in range(CARD_H):
            for lx in range(CARD_W):
                if not in_card(lx, ly):
                    continue
                x, y = ox + lx, oy + ly
                if not (0 <= x < W and 0 <= y < H):
                    continue
                acc, total = [0.0, 0.0, 0.0], 0
                for sy in range(SS):
                    for sx in range(SS):
                        sxx, syy = lx + off + sx * step, ly + off + sy * step
                        col = None
                        for pred, c in layers:
                            if pred(sxx, syy):
                                col = c
                        if col is None:
                            continue
                        for i in range(3):
                            acc[i] += col[i]
                        total += 1
                if not total:
                    continue
                px[y][x] = (int(round(acc[0] / total)), int(round(acc[1] / total)),
                            int(round(acc[2] / total)), 255)

    halo(*BACK)
    halo(*FRONT)
    card(*BACK)
    card(*FRONT)
    return px


# ------------------------------------------------------------------------- PNG
def write_png(path, px):
    h, w = len(px), len(px[0])
    raw = b"".join(b"\x00" + bytes(v for c in row for v in c) for row in px)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)   # 8-bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(raw, 9))
                + chunk(b"IEND", b""))


# --------------------------------------------------------------------- preview
def box_down(px, factor):
    """Area-average downsample, near enough to what a browser does."""
    h, w = len(px), len(px[0])
    out = []
    for y in range(h // factor):
        row = []
        for x in range(w // factor):
            r = g = b = a = 0.0
            for dy in range(factor):
                for dx in range(factor):
                    p = px[y * factor + dy][x * factor + dx]
                    f = p[3] / 255.0
                    r += p[0] * f; g += p[1] * f; b += p[2] * f; a += p[3]
            n = factor * factor
            if a / n < 1:
                row.append((0, 0, 0, 0))
            else:
                k = a / 255.0            # un-premultiply
                row.append((int(round(r / k)), int(round(g / k)),
                            int(round(b / k)), int(round(a / n))))
        out.append(row)
    return out


def on_felt(px, felt=(44, 87, 84)):
    return [[tuple(round(c * (p[3] / 255.0) + bg * (1 - p[3] / 255.0))
                   for c, bg in zip(p[:3], felt)) + (255,) for p in row] for row in px]


def upscale(px, k):
    return [[c for c in row for _ in range(k)] for row in px for _ in range(k)]


def sheet(path, panels, gap=14, bg=(20, 20, 20, 255)):
    ph = max(len(p) for p in panels)
    pw = sum(len(p[0]) for p in panels) + gap * (len(panels) - 1)
    img = [[bg] * pw for _ in range(ph)]
    x = 0
    for p in panels:
        for y, row in enumerate(p):
            img[y][x:x + len(row)] = row
        x += len(p[0]) + gap
    write_png(path, img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true",
                    help="also write comparison sheets to assets-src/ (not shipped)")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, OUT_DIR)
    os.makedirs(out, exist_ok=True)
    drawn = {}
    for name, spec in BACKS.items():
        drawn[name] = draw(spec)
        path = os.path.join(out, name + ".png")
        write_png(path, drawn[name])
        print("wrote {}  ({} bytes, {}x{})".format(
            os.path.relpath(path, root), os.path.getsize(path), W, H))

    if args.preview:
        pdir = os.path.join(root, PREVIEW_DIR)
        os.makedirs(pdir, exist_ok=True)
        sheet(os.path.join(pdir, "backs-preview.png"),
              [upscale(on_felt(drawn[n]), 3) for n in BACKS])
        # Squashed to the site's own 23x26 — what a 1x display really gets —
        # then magnified so it can be judged. If a design dies here the
        # composition is too fine, and that is a design bug, not a rendering one.
        sheet(os.path.join(pdir, "backs-preview-1x.png"),
              [upscale(on_felt(box_down(drawn[n], SCALE)), 8) for n in BACKS])
        print("wrote {}/backs-preview.png and backs-preview-1x.png  (not shipped)"
              .format(PREVIEW_DIR))


if __name__ == "__main__":
    main()
