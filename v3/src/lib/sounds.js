/* Sound for interactions. Two sources: the site's own set (/gpokr2/sound/:
 * bet, check, fold, slide_chips, shuffle_deck), so a throw sounds like the
 * rest of the table, and our bundled tracks for what the site has no sound for
 * (a cheer, applause). Each name gets a pool of preloaded voices, rewound on
 * reuse, so a cue fires on time and two landings don't cut each other off. */

const SITE_BASE = "/gpokr2/sound/";
const VOICES = 4;
const SITE_VOLUME = 0.55;
const ASSET_VOLUME = 0.7;
const FADE_STEP_MS = 40;

const pools = new Map();

function pool(url, volume, voices = VOICES) {
    let p = pools.get(url);
    if (!p) {
        p = { els: [], next: 0, volume };
        for (let i = 0; i < voices; i++) {
            const el = new Audio(url);
            el.preload = "auto";
            el.volume = volume;
            try { el.load(); } catch (e) { /* decode at play instead */ }
            p.els.push(el);
        }
        pools.set(url, p);
    }
    return p;
}

function play(p, fade) {
    try {
        const el = p.els[p.next];
        p.next = (p.next + 1) % p.els.length;
        el.gptFade = (el.gptFade || 0) + 1;   // abandon a fade still running on this voice
        el.volume = p.volume;
        el.currentTime = 0;
        const r = el.play();
        if (r && r.catch) r.catch(() => {});   // autoplay policy or offline: stay quiet
        if (fade && fade.fadeMs > 0) fadeOut(el, p.volume, fade.holdMs, fade.fadeMs);
    } catch (e) { /* no audio */ }
}

/* Ride a track that outlasts its animation down to silence. A replay on the
 * same voice bumps the token, which cancels the ramp. */
function fadeOut(el, volume, holdMs, fadeMs) {
    const token = el.gptFade;
    setTimeout(() => {
        let left = fadeMs;
        const tick = setInterval(() => {
            if (el.gptFade !== token) { clearInterval(tick); return; }
            left -= FADE_STEP_MS;
            if (left > 0) { el.volume = volume * (left / fadeMs); return; }
            clearInterval(tick);
            try { el.pause(); } catch (e) { /* ignore */ }
            el.volume = volume;
        }, FADE_STEP_MS);
    }, holdMs);
}

export function playSite(name) {
    if (name) play(pool(SITE_BASE + name + ".mp3", SITE_VOLUME));
}

export function playAsset(ctx, name, fade) {
    if (!name) return;
    const file = /\.[a-z0-9]+$/i.test(name) ? name : name + ".mp3";
    play(pool(ctx.assets.url("assets/audio/" + file), ASSET_VOLUME), fade);
}

/* One chip landing. A twenty-chip bet lands twenty times in half a second, so
 * each clink gets its own pitch and level (one recording repeated reads as a
 * stutter, slightly different ones as a pile), and landings closer together
 * than the ear can separate are skipped. */
const CLINK_MIN_MS = 38;
let lastClink = 0;
export function playClink(ctx) {
    const now = Date.now();
    if (now - lastClink < CLINK_MIN_MS) return;
    lastClink = now;
    try {
        const p = pool(ctx.assets.url("assets/audio/chip.m4a"), 0.5, 8);
        const el = p.els[p.next];
        p.next = (p.next + 1) % p.els.length;
        el.playbackRate = 0.94 + Math.random() * 0.13;
        el.volume = 0.5 * (0.85 + Math.random() * 0.3);
        el.currentTime = 0;
        const r = el.play();
        if (r && r.catch) r.catch(() => {});
    } catch (e) { /* no audio */ }
}

export function warm(ctx, siteNames, assetNames) {
    for (const n of siteNames) pool(SITE_BASE + n + ".mp3", SITE_VOLUME);
    for (const n of assetNames) pool(ctx.assets.url("assets/audio/" + n + ".mp3"), ASSET_VOLUME);
}
