/* Thrown props and celebrations.
 *
 * A small chip on the corner of every other player's avatar opens a menu of
 * things to throw at them; a 🥳 button on the felt opens the celebrations
 * (confetti, clap, dance, rail slide, river). A pick POSTs to /table/interact
 * through the host, the server broadcasts an InteractionEvent to the table,
 * and everyone — the thrower included — plays it from that event, so all of us
 * see the same throw at the same moment. Cosmetic only: the endpoint never
 * touches the game, and the server drops sends from watchers and the muted.
 *
 * The wire format is the classic add-on's ({v:1, s:seed, q:[[item]|["wait",
 * ms]]} under type "gpe.throw"), so classic and ui2 players see each other's
 * throws. Anyone can POST anything to that endpoint, so a received payload is
 * clamped into the limits below or dropped, never taken at its word.
 *
 * The models and their animation are the classic renderers (3d/coin3d.js,
 * 3d/props3d.js), loaded on first use and drawn in the classic table frame
 * fitted to ui2's felt (see lib/legacy3d.js). The avatar stunts clone the
 * seat's portrait over the table and hide the real one while it is away.
 *
 * Two switches: "interactions" (throwing and seeing throws) and
 * "celebrations" (sending and seeing celebrations). Celebrations only run
 * between hands: from the end of a hand until the next flop. */

import { slot } from "../slot.js";
import { ensureCoin, ensureCatalog, ensureProps, classicFrame } from "../lib/legacy3d.js";
import { playSite, playAsset, warm } from "../lib/sounds.js";
import { openPanel, button } from "../lib/panel.js";

export const INTERACT_TYPE = "gpe.throw";
const INTERACT_V = 1;
const COOLDOWN_MS = 2000;        // the server's own per-user window
const Q_MAX_STEPS = 30;
const Q_MAX_ITEMS = 15;
const Q_MAX_WAIT_MS = 3000;
const Q_MAX_TOTAL_MS = 15000;
const Q_MAX_PAYLOAD = 1024;
const Q_MAX_RUNNING = 3;
const EMOTE_MS = 2200;

// The clap's choreography: props3d's glove motion, the stand-and-sit below and
// the track's fade all run on these numbers.
const CLAP_LEAD = 420, CLAP_COUNT = 8, CLAP_PERIOD = 330, CLAP_TAIL = 620;

const PERSONAL = "personal";
const PERSONAL_ORDER = ["celebrate", "clap", "dance", "rail", "river"];

/* ---------- the wire ---------- */

export function seededRand(seed) {
    let a = (seed | 0) || 1;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function buildPayload(steps) {
    const q = [];
    let items = 0;
    for (const step of steps || []) {
        if (!Array.isArray(step) || !step.length) continue;
        const name = String(step[0]);
        if (name === "wait") q.push(["wait", step[1] | 0]);
        else { if (items >= Q_MAX_ITEMS) break; items += 1; q.push([name]); }
        if (q.length >= Q_MAX_STEPS) break;
    }
    if (!q.length) return null;
    const payload = JSON.stringify({ v: INTERACT_V, s: (Math.random() * 0x7FFFFFFF) | 0, q });
    return payload.length > Q_MAX_PAYLOAD ? null : payload;
}

/* A received payload as a sequence we are willing to play, or null. Written as
 * "prove it is acceptable", so a shape nobody anticipated fails closed. Items
 * this build does not know (a newer client's) are skipped, not fatal. */
export function parsePayload(raw, known) {
    if (typeof raw !== "string" || !raw || raw.length > Q_MAX_PAYLOAD) return null;
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if ((obj.v | 0) !== INTERACT_V || !Array.isArray(obj.q) || !obj.q.length) return null;
    const q = [];
    let total = 0, items = 0;
    for (const step of obj.q.slice(0, Q_MAX_STEPS)) {
        if (!Array.isArray(step) || typeof step[0] !== "string") continue;
        const name = step[0];
        if (name === "wait") {
            const ms = Math.max(0, Math.min(Q_MAX_WAIT_MS, step[1] | 0));
            if (!ms) continue;
            if (total + ms > Q_MAX_TOTAL_MS) break;
            total += ms;
            q.push(["wait", ms]);
            continue;
        }
        if (!known(name)) continue;
        if (items >= Q_MAX_ITEMS) break;
        items += 1;
        q.push([name]);
    }
    return q.length ? { seed: obj.s | 0, q } : null;
}

/* ---------- the feature ---------- */

export function startInteractions(ctx, tracker, editors) {
    const offs = [];
    const throwsOn = () => ctx.settings.get("interactions") !== false;
    const celebOn = () => throwsOn() && ctx.settings.get("celebrations") !== false;
    const state = () => ctx.state.get();
    const players = () => ((state().gameInfo || {}).playerInfo || []);
    const seatOfUser = (id) => players().findIndex((p) => p && p.user && p.user.id === id);
    const seatOfName = (name) => players().findIndex((p) => p && p.user && p.user.name === name);
    const amSeated = () => state().mySeat >= 0;

    /* ----- where things are ----- */
    const anchors = new Map();   // seat -> an element inside that seat (our badge slot)
    offs.push(ctx.ui.register("seat.badge", slot(ctx, (el, props) => {
        anchors.set(props.seat, el);
        let seat = props.seat;
        return {
            update(p) { if (anchors.get(seat) === el) anchors.delete(seat); seat = p.seat; anchors.set(seat, el); },
            destroy() { if (anchors.get(seat) === el) anchors.delete(seat); },
        };
    })));
    let overlay = null;          // the table.overlay layer, sized to ui2's table shape
    offs.push(ctx.ui.register("table.overlay", slot(ctx, (el) => {
        overlay = el;
        return { destroy() { if (overlay === el) overlay = null; } };
    })));

    const avatarOf = (seat) => {
        let el = anchors.get(seat);
        for (let i = 0; el && i < 6; i++, el = el.parentElement) {
            const img = el.querySelector && el.querySelector("img.iogc-PlayerPanel-avatar");
            if (img) return img;
        }
        return null;
    };
    const liveRect = (el) => {
        const r = el && el.getBoundingClientRect();
        return r && r.width > 0 ? r : null;
    };
    const tableFrame = () => classicFrame(liveRect(overlay));

    /* ----- what can be thrown ----- */
    const ITEMS = {
        chip: {
            label: "chip", glyph: "🪙", cooldownMs: COOLDOWN_MS,
            launchSound: "fold", sound: "bet",
            ensure: () => ensureCoin(ctx),
            throw: (from, to, table, opts) => window.GPE_COIN && GPE_COIN.toss(from, to, table, opts),
        },
        celebrate: {
            label: "celebrate", glyph: "🎉", emote: "🎉", category: PERSONAL, cooldownMs: 5000,
            assetSound: "hooray", flinch: false,
            ensure: () => ensureCoin(ctx),
            effect: (from, table) => window.GPE_COIN && GPE_COIN.confetti(from, table),
        },
        dance: {
            label: "dance", glyph: "🕺", category: PERSONAL, cooldownMs: 6000,
            assetSound: "celebrate", flinch: false,
            ensure: () => Promise.resolve(true),
            effect: (from, table, c) => danceAvatar(c.avatar, from, table),
        },
        clap: {
            label: "clap", glyph: "👏", category: PERSONAL, cooldownMs: 8000,
            assetSound: "golfclap",
            assetFade: { holdMs: CLAP_LEAD + CLAP_COUNT * CLAP_PERIOD, fadeMs: CLAP_TAIL },
            flinch: false,
            ensure: () => ensureProps(ctx).then((ok) => (ok ? GPE_PROPS.ready("clap") : false)),
            effect: (from, table, c) => standAndClap(c.avatar, from, table),
        },
        river: {
            label: "river", glyph: "🌊", category: PERSONAL, cooldownMs: 2000, flinch: false,
            ensure: () => ensureProps(ctx).then((ok) => (ok
                ? GPE_PROPS.ready("river").then((r) => (r ? GPE_PROPS.ready("beer").then(() => true) : false))
                : false)),
            effect: (from, table) => riverToWinner(from, table),
        },
        rail: {
            label: "rail slide", glyph: "🛹", category: PERSONAL, cooldownMs: 6000,
            assetSound: "railslide", flinch: false,
            ensure: () => Promise.resolve(true),
            effect: (from, table, c) => railSlideAvatar(c.avatar, from, table),
        },
    };
    const THROW_ORDER = ["chip"];

    // Fold props3d's catalog in: one row there is one throwable object here.
    const syncCatalog = () => {
        const props = window.GPE_PROPS;
        if (!props || !props.catalog) return;
        for (const key of props.order) {
            if (ITEMS[key] || !props.catalog[key]) continue;
            const spec = props.catalog[key];
            ITEMS[key] = {
                label: spec.label || key,
                glyph: spec.glyph || "•",
                cooldownMs: spec.cooldownMs || COOLDOWN_MS,
                sound: spec.sound || null,
                launchSound: spec.launchSound || null,
                flinch: spec.flinch !== false,
                ensure: () => ensureProps(ctx).then((ok) => (ok ? props.ready(key) : false)),
                throw: (from, to, table, opts) => window.GPE_PROPS && GPE_PROPS.toss(key, from, to, table, opts),
            };
            if (!THROW_ORDER.includes(key)) THROW_ORDER.push(key);
        }
        rebuildMenus();
    };
    ensureCatalog(ctx).then((ok) => { if (ok) syncCatalog(); });
    warm(ctx, ["bet", "check", "fold"], ["hooray", "celebrate", "railslide", "golfclap"]);

    /* ----- celebrations gate ----- */
    const celebrationsAllowed = () => {
        const h = tracker.get();
        return !h || h.ended || h.board.length === 0;
    };

    /* ----- playing one item ----- */
    function renderItem(key, fromSeat, toSeat, denom) {
        // Nothing animates in a hidden tab, so nothing may start in one: the
        // renderers would pile objects up and play them all on return.
        if (document.hidden) return Promise.resolve(false);
        const item = ITEMS[key];
        if (!item) return Promise.resolve(false);
        if (item.category === PERSONAL) {
            if (!celebOn() || !celebrationsAllowed()) return Promise.resolve(false);
            return item.ensure().then((ok) => {
                if (!ok) return false;
                playAsset(ctx, item.assetSound, item.assetFade);
                if (item.emote) emoteOver(toSeat, item.emote);
                const avatar = avatarOf(toSeat);
                const from = liveRect(avatar);
                if (item.effect && from) item.effect(from, tableFrame(), { avatar, seat: toSeat });
                return true;
            });
        }
        if (!throwsOn()) return Promise.resolve(false);
        return item.ensure().then((ok) => {
            if (!ok) return false;
            playSite(item.launchSound);
            const target = avatarOf(toSeat);
            const to = liveRect(target);
            if (!to) return false;                       // they left mid-sequence
            const from = fromSeat >= 0 ? liveRect(avatarOf(fromSeat)) : null;   // null: from the near rail
            const landed = () => { if (item.flinch !== false) flinch(target); playSite(item.sound); };
            return !!item.throw(from, to, tableFrame(), { denom, onHit: landed, onArrive: landed, avatar: target });
        });
    }

    /* ----- receiving ----- */
    const running = new Map();   // fromUserId -> true: one sequence per sender
    offs.push(ctx.events.on("InteractionEvent", ({ event }) => {
        if (!event || event.type !== INTERACT_TYPE || document.hidden) return;
        const fromId = Number(event.fromUserId) || 0;
        if (!fromId || running.has(fromId) || running.size >= Q_MAX_RUNNING) return;
        const parsed = parsePayload(event.payload, (k) => !!ITEMS[k]);
        if (!parsed) return;
        const toSeat = seatOfUser(Number(event.toUserId) || 0);
        if (toSeat < 0) return;
        const fromSeat = seatOfUser(fromId);
        const rand = seededRand(parsed.seed);
        const denoms = window.GPE_CHIPS && GPE_CHIPS.art && GPE_CHIPS.art.types;

        running.set(fromId, true);
        let chain = Promise.resolve();
        for (const [name, arg] of parsed.q) {
            if (name === "wait") {
                chain = chain.then(() => (document.hidden ? null : new Promise((r) => setTimeout(r, arg))));
                continue;
            }
            chain = chain.then(() => {
                if (document.hidden) return false;
                const denom = denoms && denoms.length ? denoms[Math.floor(rand() * denoms.length)].denom : undefined;
                return renderItem(name, fromSeat, toSeat, denom);
            });
        }
        // Never rely on the chain alone to free the sender: a renderer that hangs
        // would mute that player for the rest of the session.
        let budget = 4000;
        for (const [name, arg] of parsed.q) budget += name === "wait" ? arg : 900;
        const release = () => running.delete(fromId);
        const watchdog = setTimeout(release, Math.min(budget, Q_MAX_TOTAL_MS + 12000));
        chain.then(() => { clearTimeout(watchdog); release(); }, () => { clearTimeout(watchdog); release(); });
    }));

    /* ----- sending ----- */
    let lastSendAt = 0;
    const lastByItem = Object.create(null);
    const cooldownLeft = (key) => {
        const item = ITEMS[key];
        if (!item) return 0;
        const now = Date.now();
        return Math.max(0, COOLDOWN_MS - (now - lastSendAt), (item.cooldownMs || 0) - (now - (lastByItem[key] || 0)));
    };
    // Nothing renders here: the throw appears when the event comes back, so a
    // send the server drops honestly shows as nothing happening.
    const send = (toSeat, key) => {
        const p = players()[toSeat];
        if (!p || !p.user || cooldownLeft(key) > 0) return;
        const payload = buildPayload([[key]]);
        if (!payload) return;
        lastSendAt = lastByItem[key] = Date.now();
        ctx.actions.interact(INTERACT_TYPE, payload, p.user.id);
    };

    /* ----- menus ----- */
    const menus = [];
    function makeMenu(keys, onPick) {
        const panel = document.createElement("div");
        panel.className = "gpt-root gpt-interact-panel";
        let closeTimer = 0;
        const menu = {
            panel, target: null,
            fill() {
                panel.textContent = "";
                for (const key of keys()) {
                    const item = ITEMS[key];
                    if (!item) continue;
                    const b = document.createElement("button");
                    b.type = "button";
                    b.className = "gpt-interact-item";
                    b.dataset.item = key;
                    b.textContent = item.glyph + " " + item.label;
                    // Clicking does not close: five clicks are five throws.
                    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onPick(key, menu.target); menu.sync(); });
                    panel.append(b);
                }
            },
            open(anchor, target) {
                menu.hold();
                menu.target = target;
                const br = anchor.getBoundingClientRect();
                panel.style.left = br.left + "px";
                panel.style.top = br.bottom + 4 + "px";
                panel.classList.add("is-open");
                const pr = panel.getBoundingClientRect();
                if (pr.right > innerWidth - 4) panel.style.left = Math.max(4, innerWidth - pr.width - 4) + "px";
                if (pr.bottom > innerHeight - 4) panel.style.top = Math.max(4, br.top - pr.height - 4) + "px";
                menu.sync();
            },
            hold() { clearTimeout(closeTimer); closeTimer = 0; },
            later() { menu.hold(); closeTimer = setTimeout(menu.close, 320); },
            close() { menu.hold(); panel.classList.remove("is-open"); },
            isOpen: () => panel.classList.contains("is-open"),
            // What is still cooling, so a click isn't a silent drop.
            sync() {
                if (!menu.isOpen()) return;
                for (const b of panel.querySelectorAll(".gpt-interact-item")) {
                    const item = ITEMS[b.dataset.item];
                    const left = cooldownLeft(b.dataset.item);
                    b.classList.toggle("is-cool", left > 0);
                    b.textContent = item.glyph + " " + item.label + (left > 0 ? " " + Math.ceil(left / 1000) + "s" : "");
                }
            },
        };
        panel.addEventListener("mouseenter", menu.hold);
        panel.addEventListener("mouseleave", menu.later);
        menu.fill();
        document.body.append(panel);
        menus.push(menu);
        return menu;
    }
    const throwMenu = makeMenu(() => THROW_ORDER, (key, seat) => { if (seat != null) send(seat, key); });
    const personalMenu = makeMenu(() => PERSONAL_ORDER, (key) => {
        if (!celebOn() || !amSeated() || !celebrationsAllowed()) return;
        send(state().mySeat, key);
    });
    function rebuildMenus() { for (const m of menus) m.fill(); }
    const coolTimer = setInterval(() => menus.forEach((m) => m.sync()), 250);
    const onDown = (e) => {
        for (const m of menus) {
            if (!m.isOpen() || m.panel.contains(e.target)) continue;
            if (e.target.closest && e.target.closest(".gpt-interact-btn, .gpt-personal-btn")) continue;
            m.close();
        }
    };
    document.addEventListener("mousedown", onDown);

    /* ----- buttons ----- */
    const seatButtons = new Map();   // seat -> button
    const personalBtn = document.createElement("button");
    personalBtn.type = "button";
    personalBtn.className = "gpt-root gpt-personal-btn";
    personalBtn.textContent = "🥳";
    personalBtn.hidden = true;
    personalBtn.addEventListener("mouseenter", () => { if (!personalBtn.disabled) personalMenu.open(personalBtn, null); });
    personalBtn.addEventListener("mouseleave", personalMenu.later);
    personalBtn.addEventListener("click", (e) => { e.preventDefault(); if (!personalBtn.disabled) personalMenu.open(personalBtn, null); });
    document.body.append(personalBtn);

    let raf = 0;
    const place = () => {
        raf = requestAnimationFrame(place);
        const me = state().mySeat;
        const wanted = new Set();
        if (throwsOn() && me >= 0) {
            players().forEach((p, seat) => {
                if (!p || !p.user || seat === me) return;
                const r = liveRect(avatarOf(seat));
                if (!r) return;
                wanted.add(seat);
                let b = seatButtons.get(seat);
                if (!b) {
                    b = document.createElement("button");
                    b.type = "button";
                    b.className = "gpt-interact-btn";
                    b.addEventListener("mouseenter", () => throwMenu.open(b, seat));
                    b.addEventListener("mouseleave", throwMenu.later);
                    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); throwMenu.open(b, seat); });
                    document.body.append(b);
                    seatButtons.set(seat, b);
                }
                b.title = "throw something at " + p.user.name;
                // Top-right corner of the avatar, half on and half off.
                b.style.left = r.right - 5 + "px";
                b.style.top = r.top + 7 + "px";
            });
        }
        for (const [seat, b] of seatButtons) {
            if (wanted.has(seat)) continue;
            b.remove();
            seatButtons.delete(seat);
            if (throwMenu.target === seat) throwMenu.close();
        }
        // The 🥳 button sits on the felt's top-right edge while I'm seated.
        const f = tableFrame();
        const showP = celebOn() && me >= 0 && !!f;
        if (personalBtn.hidden === showP) personalBtn.hidden = !showP;
        if (showP) {
            const sc = f.width / 790;
            personalBtn.style.left = f.left + (395 + 262) * sc + "px";
            personalBtn.style.top = f.top + (190 - 96) * sc + "px";
            const open = celebrationsAllowed();
            personalBtn.disabled = !open;
            personalBtn.title = open ? "Celebrations" : "not while the hand is playing — free again once it's over";
            if (!open) personalMenu.close();
        } else personalMenu.close();
    };
    place();

    /* ----- effects ----- */
    function flinch(av) {
        if (!av || !av.isConnected) return;
        av.classList.remove("gpt-hit");
        void av.offsetWidth;
        av.classList.add("gpt-hit");
        clearTimeout(av._gptHit);
        av._gptHit = setTimeout(() => av.classList.remove("gpt-hit"), 460);
    }

    function emoteOver(seat, glyph) {
        const r = liveRect(avatarOf(seat));
        if (!r) return;
        const el = document.createElement("div");
        el.className = "gpt-emote";
        el.textContent = glyph;
        el.style.left = r.left + r.width / 2 + "px";
        el.style.top = r.top + r.height / 2 + "px";
        document.body.append(el);
        requestAnimationFrame(() => el.classList.add("is-shown"));
        setTimeout(() => { el.classList.remove("is-shown"); setTimeout(() => el.remove(), 200); }, EMOTE_MS);
    }

    // A seat's avatar stays hidden while its clone is away; counted, because
    // two stunts can overlap on one seat and the first to finish must not
    // uncover it under the second.
    const COVER = "data-gpt-covered";
    const coverHold = (el) => el.setAttribute(COVER, String((parseInt(el.getAttribute(COVER), 10) || 0) + 1));
    const coverRelease = (el) => {
        const n = (parseInt(el.getAttribute(COVER), 10) || 0) - 1;
        if (n > 0) el.setAttribute(COVER, String(n)); else el.removeAttribute(COVER);
    };
    const stunts = new Set();

    /* Clone the avatar into a click-through overlay and drive it each frame:
     * step(t, api) returns false when done. api.put(x, y, scale, rotZ, flipX,
     * spinY); api has the seat centre (sx, sy), size (w, h) and table frame. */
    function avatarStunt(avatarEl, fromRect, table, step, opts) {
        if (!avatarEl || !fromRect) return false;
        const src = avatarEl.currentSrc || avatarEl.src;
        if (!src) return false;
        const img = document.createElement("img");
        img.src = src;
        img.className = "gpt-stunt" + (opts && opts.cls ? " " + opts.cls : "");
        img.style.width = fromRect.width + "px";
        img.style.height = fromRect.height + "px";
        document.body.append(img);
        coverHold(avatarEl);
        let done = false;
        const cleanup = () => { if (done) return; done = true; img.remove(); coverRelease(avatarEl); stunts.delete(cleanup); };
        stunts.add(cleanup);
        const put = (x, y, scale, rotZ, flipX, spinY) => {
            img.style.transform = `perspective(600px) translate(${x}px,${y}px) translate(-50%,-50%) ` +
                `rotateX(${flipX || 0}deg) rotateY(${spinY || 0}deg) rotate(${rotZ || 0}deg) scale(${scale == null ? 1 : scale})`;
        };
        const api = { put, sx: fromRect.left + fromRect.width / 2, sy: fromRect.top + fromRect.height / 2, w: fromRect.width, h: fromRect.height, table };
        put(api.sx, api.sy, 1, 0, 0);
        const t0 = performance.now();
        const frame = (now) => {
            if (done) return;
            if (step(now - t0, api) === false) { cleanup(); return; }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        return true;
    }

    // The rail as a screen ellipse: the felt grown by pad art px.
    function railEllipse(table, pad) {
        if (!table || table.width < 40) return null;
        const sc = table.width / 790;
        return { cx: table.left + 395 * sc, cy: table.top + 190 * sc, ax: (290 + (pad || 0)) * sc, by: (102 + (pad || 0)) * sc };
    }

    // Leap to the middle, dance, backflip, hop back: ~4.25s, to the track.
    function danceAvatar(avatarEl, fromRect, table) {
        return avatarStunt(avatarEl, fromRect, table, (t, { put, sx, sy, h, table: tb }) => {
            const tx = tb ? tb.left + tb.width / 2 : sx;
            const ty = tb ? tb.top + 190 * (tb.width / 790) : sy - 140;
            const HOP = Math.min(130, h * 1.6);
            const JUMP = 520, DANCE = 2650, FLIP = 620, RET = 460;
            if (t >= JUMP + DANCE + FLIP + RET) return false;
            if (t < JUMP) {
                const k = t / JUMP, e = 1 - Math.pow(1 - k, 3);
                put(sx + (tx - sx) * e, sy + (ty - sy) * e - Math.sin(k * Math.PI) * HOP, 1 + 0.3 * e, 0, 0);
            } else if (t < JUMP + DANCE) {
                const d = (t - JUMP) / 1000;
                put(tx + Math.sin(d * 3) * 26, ty - Math.abs(Math.sin(d * 6)) * 18, 1.3 * (1 + Math.sin(d * 12) * 0.06), Math.sin(d * 6) * 12, 0);
            } else if (t < JUMP + DANCE + FLIP) {
                const k = (t - JUMP - DANCE) / FLIP;
                put(tx, ty - Math.sin(k * Math.PI) * (HOP * 0.95), 1.3, 0, 360 * k);
            } else {
                const k = (t - JUMP - DANCE - FLIP) / RET, e = 1 - Math.pow(1 - k, 3);
                put(tx + (sx - tx) * e, ty + (sy - ty) * e - Math.sin(k * Math.PI) * (HOP * 0.6), 1.3 + (1 - 1.3) * e, 0, 0);
            }
            return true;
        });
    }

    // Stand up out of the seat and applaud; the gloves are props3d's.
    function standAndClap(avatarEl, fromRect, table) {
        if (!avatarEl || !fromRect) return false;
        const h = fromRect.height || 40;
        const lift = Math.min(46, h * 0.55);
        if (window.GPE_PROPS) GPE_PROPS.toss("clap", fromRect, fromRect, table, { dropY: h * 0.41 });
        return avatarStunt(avatarEl, fromRect, table, (t, { put, sx, sy }) => {
            const APPLAUD = CLAP_COUNT * CLAP_PERIOD;
            if (t >= CLAP_LEAD + APPLAUD + CLAP_TAIL) return false;
            if (t < CLAP_LEAD) {
                const e = 1 - Math.pow(1 - t / CLAP_LEAD, 3);
                put(sx, sy - lift * e, 1 + 0.18 * e, 0, 0);
            } else if (t < CLAP_LEAD + APPLAUD) {
                const u = ((t - CLAP_LEAD) % CLAP_PERIOD) / CLAP_PERIOD;
                const beat = Math.sin(Math.PI * u);
                put(sx, sy - lift + beat * 5, 1.18, beat * 2.5, 0);
            } else {
                const e = 1 - Math.pow(1 - (t - CLAP_LEAD - APPLAUD) / CLAP_TAIL, 3);
                put(sx, sy - lift * (1 - e), 1.18 + (1 - 1.18) * e, 0, 0);
            }
            return true;
        }, { cls: "is-under-props" });
    }

    // The river pours to the last hand's main-pot winner, which every client
    // resolves the same way from the hand it watched; with nobody known (we
    // joined mid-hand, or they left) it pours over the celebrant instead.
    function riverToWinner(fromRect, table) {
        if (!window.GPE_PROPS) return false;
        const h = tracker.get() && tracker.get().ended ? tracker.get() : tracker.previous();
        const main = h && h.winners.find((w) => !w.side);
        const seat = main ? liveRect(avatarOf(main.seat)) : null;
        return !!GPE_PROPS.toss("river", fromRect, seat || fromRect, table);
    }

    // Hop onto the rail, grind a lap of the oval, spin back into the seat.
    function railSlideAvatar(avatarEl, fromRect, table) {
        return avatarStunt(avatarEl, fromRect, table, (t, { put, sx, sy, table: tb }) => {
            const JUMP = 520, SLIDE = 2900, RET = 560;
            if (t >= JUMP + SLIDE + RET) return false;
            const e = railEllipse(tb, 16);
            if (!e) return false;
            const ang0 = Math.atan2((sy - e.cy) / e.by, (sx - e.cx) / e.ax);
            const on = (a) => ({ x: e.cx + Math.cos(a) * e.ax, y: e.cy + Math.sin(a) * e.by });
            if (t < JUMP) {
                const k = t / JUMP, ee = 1 - Math.pow(1 - k, 3), p = on(ang0);
                put(sx + (p.x - sx) * ee, sy + (p.y - sy) * ee - Math.sin(k * Math.PI) * 90, 1 + 0.15 * ee, 0, 0);
            } else if (t < JUMP + SLIDE) {
                const k = (t - JUMP) / SLIDE, ang = ang0 + k * Math.PI * 2, p = on(ang);
                put(p.x, p.y - Math.sin(k * Math.PI * 10) * 3, 1.15, -Math.sin(ang) * 20, 0);
            } else {
                const k = (t - JUMP - SLIDE) / RET, ee = 1 - Math.pow(1 - k, 3), p = on(ang0);
                put(p.x + (sx - p.x) * ee, p.y + (sy - p.y) * ee - Math.sin(k * Math.PI) * 95, 1.15 + (1 - 1.15) * ee, 0, 0, 360 * k);
            }
            return true;
        });
    }

    /* ----- the interaction creator ----- */
    // A scripted sequence: what to throw, in order, with a pause after each,
    // sent as ONE interaction (one POST), so the server's per-user cooldown
    // does not swallow everything after the first object. The list is kept
    // in this browser between sessions.
    const PAUSES = [0, 150, 250, 400, 600, 800, 1000, 1500, 2000, 3000];
    const creator = () => ({ rows: [], pause: 400, ...(ctx.storage.local.get("creator") || {}) });
    const saveCreator = (c) => ctx.storage.local.set("creator", c);

    function openCreator() {
        let drag = null;
        return openPanel(ctx, {
            id: "creator", title: "interaction creator", width: 300,
            build(body) {
                const c = creator();
                const pauseSelect = (value, onChange) => {
                    const s = document.createElement("select");
                    s.className = "gpt-select";
                    for (const ms of PAUSES) s.append(new Option(ms ? `then ${ms / 1000}s` : "then go", ms, false, ms === value));
                    s.addEventListener("change", () => onChange(parseInt(s.value, 10)));
                    return s;
                };
                const itemSelect = (value, onChange) => {
                    const s = document.createElement("select");
                    s.className = "gpt-select";
                    for (const key of THROW_ORDER) {
                        const it = ITEMS[key];
                        s.append(new Option(it.glyph + " " + it.label, key, false, key === value));
                    }
                    s.addEventListener("change", () => onChange(s.value));
                    return s;
                };

                const targetRow = document.createElement("div");
                targetRow.className = "gpt-row";
                const target = document.createElement("select");
                target.className = "gpt-select";
                targetRow.append(Object.assign(document.createElement("span"), { className: "gpt-row-label", textContent: "target" }), target);
                const list = document.createElement("div");
                list.className = "gpt-steps";
                const addRow = document.createElement("div");
                addRow.className = "gpt-row";
                let nextItem = THROW_ORDER[0];
                const addItem = itemSelect(nextItem, (v) => { nextItem = v; });
                const addPause = pauseSelect(c.pause, (ms) => { c.pause = ms; saveCreator(c); });
                addPause.title = "pause after each new throw";
                const addBtn = button("+ add", () => {
                    if (c.rows.length >= Q_MAX_ITEMS) { status(`full: ${Q_MAX_ITEMS} throws max`); return; }
                    c.rows.push({ item: nextItem, pause: c.pause });
                    saveCreator(c); draw();
                });
                addRow.append(addItem, addPause, addBtn);
                const foot = document.createElement("div");
                foot.className = "gpt-row gpt-steps-foot";
                const msg = document.createElement("span");
                msg.className = "gpt-steps-status";
                const status = (t) => { msg.textContent = t; };
                foot.append(msg,
                    button("clear", () => { c.rows = []; saveCreator(c); draw(); }),
                    button("Send", () => {
                        if (!amSeated()) { status("take a seat first"); return; }
                        const seat = parseInt(target.value, 10);
                        const p = players()[seat];
                        if (!p || !p.user) { status("pick a target"); return; }
                        const left = Math.max(0, COOLDOWN_MS - (Date.now() - lastSendAt));
                        if (left) { status(`wait ${Math.ceil(left / 1000)}s`); return; }
                        const steps = [];
                        c.rows.forEach((r, i) => {
                            steps.push([r.item]);
                            if (i < c.rows.length - 1 && r.pause) steps.push(["wait", r.pause]);
                        });
                        const payload = buildPayload(steps);
                        if (!payload) { status("nothing to send"); return; }
                        lastSendAt = Date.now();
                        ctx.actions.interact(INTERACT_TYPE, payload, p.user.id);
                        status(`sent ${c.rows.length} to ${p.user.name}`);
                    }, "gpt-chip-btn is-on"));
                body.append(targetRow, list, addRow, foot);

                const fillTargets = () => {
                    const keep = target.value;
                    target.textContent = "";
                    players().forEach((p, seat) => {
                        if (p && p.user && seat !== state().mySeat) target.append(new Option(p.user.name, seat));
                    });
                    if ([...target.options].some((o) => o.value === keep)) target.value = keep;
                };
                fillTargets();
                const offState = ctx.state.subscribe(() => { if (document.activeElement !== target) fillTargets(); });
                body.closest(".gpt-panel")._onClose = offState;

                function draw() {
                    list.textContent = "";
                    if (!c.rows.length) {
                        list.append(Object.assign(document.createElement("div"), { className: "gpt-panel-hint", textContent: "no throws yet — add one below" }));
                    }
                    c.rows.forEach((r, i) => {
                        const row = document.createElement("div");
                        row.className = "gpt-erow";
                        const handle = Object.assign(document.createElement("span"), { className: "gpt-drag", textContent: "⠿", title: "drag to reorder" });
                        handle.addEventListener("mousedown", () => { row.draggable = true; });
                        row.addEventListener("dragstart", (e) => { drag = i; e.dataTransfer.effectAllowed = "move"; });
                        row.addEventListener("dragend", () => { row.draggable = false; drag = null; });
                        row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.toggle("is-dragover", drag !== null && drag !== i); });
                        row.addEventListener("dragleave", () => row.classList.remove("is-dragover"));
                        row.addEventListener("drop", (e) => {
                            e.preventDefault();
                            if (drag === null || drag === i) return;
                            c.rows.splice(i, 0, c.rows.splice(drag, 1)[0]);
                            drag = null; saveCreator(c); draw();
                        });
                        const n = Object.assign(document.createElement("span"), { className: "gpt-step-n", textContent: i + 1 + "." });
                        const item = itemSelect(r.item, (v) => { r.item = v; saveCreator(c); });
                        const pause = pauseSelect(r.pause, (ms) => { r.pause = ms; saveCreator(c); });
                        if (i === c.rows.length - 1) { pause.disabled = true; pause.title = "last throw: this pause isn't played"; }
                        const x = button("✕", () => { c.rows.splice(i, 1); saveCreator(c); draw(); }, "gpt-del");
                        row.append(handle, n, item, pause, x);
                        list.append(row);
                    });
                    status(c.rows.length ? `${c.rows.length}/${Q_MAX_ITEMS} throws` : "");
                }
                draw();
            },
        });
    }
    if (editors) offs.push(editors.set("interactions", [{ label: "creator", open: openCreator }]));

    return () => {
        offs.forEach((o) => o && o());
        cancelAnimationFrame(raf);
        clearInterval(coolTimer);
        document.removeEventListener("mousedown", onDown);
        for (const b of seatButtons.values()) b.remove();
        for (const m of menus) m.panel.remove();
        personalBtn.remove();
        for (const c of [...stunts]) c();
    };
}
