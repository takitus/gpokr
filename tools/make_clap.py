#!/usr/bin/env python3
"""
Synthesize assets/audio/clap.mp3 — eight hand claps timed to the "stand up and
clap" celebration.

The rhythm here is not free: LEAD/CLAPS/PERIOD must match MOTIONS.clap in
3d/props3d.js and standAndClap() in content.js, or the sound drifts off the
hands. Change one, change all three.

A clap is broadband noise, not a tone. Two things will make a synthetic one ring
like a tin can, and this file avoids both:

  * Narrow resonant filters. A high-Q bandpass leaves a pitched ring behind the
    transient. The shaping here is gentle — a wide bandpass blended with plainly
    high-passed noise, so the spectrum stays broad and the "note" never appears.

  * A handful of discrete echoes. Three taps at fixed delays is a comb filter,
    and a comb filter is exactly what a tin can is. The room here is a Schroeder
    network (parallel combs into series allpasses) applied once to the whole
    mix, which is dense enough to read as a space rather than as repeats.

Usage, from the repo root:
    python3 tools/make_clap.py
    ffmpeg -y -i clap.wav -codec:a libmp3lame -b:a 128k -ac 1 -ar 44100 \
        assets/audio/clap.mp3
    rm clap.wav
128kbps mono 44.1k matches the other tracks in assets/audio.
"""
import math
import os
import random
import struct
import wave

SR = 44100
OUT_WAV = os.environ.get("CLAP_WAV", "clap.wav")

LEAD = 0.42      # the avatar's rise, before the first clap
CLAPS = 8
PERIOD = 0.33    # one clap every 330ms — brisk applause, ~3/sec
TAIL = 0.62      # room to let the last clap ring out

DUR = LEAD + CLAPS * PERIOD + TAIL

random.seed(7)   # fixed: regenerating must not silently change the track


# ---------- biquads (RBJ cookbook), direct form I ----------
def _run(x, b0, b1, b2, a1, a2):
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, s in enumerate(x):
        o = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, s
        y2, y1 = y1, o
        y[i] = o
    return y


def lowpass(x, f0, q=0.707):
    w = 2 * math.pi * f0 / SR
    c, s = math.cos(w), math.sin(w)
    al = s / (2 * q)
    a0 = 1 + al
    return _run(x, (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0,
                -2 * c / a0, (1 - al) / a0)


def highpass(x, f0, q=0.707):
    w = 2 * math.pi * f0 / SR
    c, s = math.cos(w), math.sin(w)
    al = s / (2 * q)
    a0 = 1 + al
    return _run(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0,
                -2 * c / a0, (1 - al) / a0)


def bandpass(x, f0, q):
    """Constant 0 dB peak gain, so changing f0 does not change loudness."""
    w = 2 * math.pi * f0 / SR
    c, s = math.cos(w), math.sin(w)
    al = s / (2 * q)
    a0 = 1 + al
    return _run(x, al / a0, 0.0, -al / a0, -2 * c / a0, (1 - al) / a0)


def one_clap(fc, gain, decay):
    """A single dry clap as a float list. No room on it — that is added once, to
    the whole mix, further down."""
    n = int(0.14 * SR)
    noise = [random.uniform(-1.0, 1.0) for _ in range(n)]

    # Wide bandpass for the character, blended with high-passed noise so the
    # spectrum stays broad. Q well under 1 — nothing here should ring.
    body_band = bandpass(noise, fc, 0.62)
    open_air = highpass(noise, 900.0, 0.707)
    mixed = [0.58 * body_band[i] + 0.42 * open_air[i] for i in range(n)]
    # Take the fizz off the very top; a clap is not a hi-hat.
    mixed = lowpass(mixed, 7200.0, 0.707)

    # The palm's thud: low-passed noise, NOT a sine. A pure tone at 240Hz was
    # the other thing reading as "boxy" — it gave every clap the same pitch.
    thud = lowpass(noise, 260.0, 0.9)

    out = [0.0] * n
    for i in range(n):
        t = i / SR
        atk = min(1.0, t / 0.0006)                  # 0.6ms attack
        env = atk * math.exp(-t / decay)
        # Fingers do not all land together: a second, softer, slower layer
        # smears the transient a little, which is what stops it sounding clicky.
        spread = atk * math.exp(-t / (decay * 3.2)) * 0.22
        out[i] = (env + spread) * mixed[i] + math.exp(-t / 0.012) * 0.30 * thud[i]

    peak = max(abs(s) for s in out) or 1.0
    return [s * gain / peak for s in out]


# ---------- Schroeder room ----------
def _comb(x, delay, fb, damp):
    buf = [0.0] * delay
    out = [0.0] * len(x)
    i = 0
    store = 0.0
    for k, s in enumerate(x):
        v = buf[i]
        out[k] = v
        # one-pole damping in the loop, so the tail loses its highs like a real
        # room instead of ringing bright forever
        store = v * (1 - damp) + store * damp
        buf[i] = s + store * fb
        i = (i + 1) % delay
    return out


def _allpass(x, delay, g):
    buf = [0.0] * delay
    out = [0.0] * len(x)
    i = 0
    for k, s in enumerate(x):
        v = buf[i]
        out[k] = -s + v
        buf[i] = s + v * g
        i = (i + 1) % delay
    return out


# Freeverb's eight comb delays. Eight rather than four because comb density is
# what separates "a room" from "a metal pipe" — with four, the individual
# repeats stay audible and the tail takes on a pitch.
_COMBS = (1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)


def room(dry):
    """Parallel combs into series allpasses. Delays are mutually prime so the
    echo density fills in instead of lining up into a pitch.

    Feedback is LOW on purpose. This is a small, fast room, not a hall: at 0.35 a
    comb is 30dB down inside ~120ms, so each clap has cleared before the next one
    lands 330ms later. An earlier pass at 0.71-0.76 rang for 280ms, and eight
    overlapping tails is precisely the metallic smear this is meant to avoid.
    """
    wet = [0.0] * len(dry)
    for d in _COMBS:
        c = _comb(dry, d, 0.35, 0.5)
        for i in range(len(wet)):
            wet[i] += c[i] * 0.125
    for d, g in ((556, 0.5), (441, 0.5), (341, 0.5)):
        wet = _allpass(wet, d, g)
    # Rooms absorb treble. Dulling the tail keeps the bright part of the sound in
    # the transient, where a clap's brightness actually lives.
    return lowpass(wet, 3500.0, 0.707)


def main():
    n = int(DUR * SR)
    dry = [0.0] * n

    for i in range(CLAPS):
        # Applause builds: the first two are a touch softer, then it settles.
        ramp = 0.82 + 0.18 * min(1.0, i / 2.0)
        fc = 1650 * random.uniform(0.85, 1.15)
        gain = ramp * random.uniform(0.86, 1.0)
        decay = 0.030 * random.uniform(0.85, 1.18)
        # A human does not clap on a grid: ±9ms of drift.
        at = LEAD + i * PERIOD + random.uniform(-0.009, 0.009)

        clap = one_clap(fc, gain, decay)
        start = int(at * SR)
        for j, s in enumerate(clap):
            k = start + j
            if 0 <= k < n:
                dry[k] += s

    wet = room(dry)
    mix = [dry[i] + 0.22 * wet[i] for i in range(n)]

    peak = max(abs(s) for s in mix) or 1.0
    scale = 0.89 / peak            # ~-1 dBFS, leaving the limiter alone
    frames = b"".join(
        struct.pack("<h", max(-32768, min(32767, int(s * scale * 32767))))
        for s in mix
    )

    with wave.open(OUT_WAV, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)

    print("duration %.3fs, %d claps, last at %.3fs -> %s"
          % (DUR, CLAPS, LEAD + (CLAPS - 1) * PERIOD, OUT_WAV))


if __name__ == "__main__":
    main()
