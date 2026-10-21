/* A stand-in for ui2's extension host, for running GPokr Tools v3 from the
 * Chrome extension before the site's registry lists it.
 *
 * ui2 renders in the page itself (#GGame.ui2), so the game client is one React
 * fiber walk away from the table layout. Everything here builds the same ctx
 * the real host hands to activate(): state, events with before/after, actions,
 * settings, storage and slots. Features must not be able to tell which host
 * they run under, so anything the real host does not offer stays out of here.
 *
 * Runs in the page's MAIN world, loaded as a module by shim/boot.js. */

const API_VERSION = "1.0.0";
const LOG = (...a) => console.log("[gpokr-tools]", ...a);

/* ---------- finding the client ---------- */

function fiberOf(el) {
    if (!el) return null;
    const k = Object.keys(el).find((n) => n.startsWith("__reactFiber"));
    return k ? el[k] : null;
}

export function findClient() {
    let f = fiberOf(document.querySelector("#GGame .iogc-TableLayout"));
    for (let i = 0; f && i < 60; i++, f = f.return) {
        const c = f.memoizedProps && f.memoizedProps.client;
        if (c && typeof c.subscribe === "function" && typeof c.getGameEntries === "function") return c;
    }
    return null;
}

/* The seat index a PlayerPanel was rendered for, from its React props. */
function seatOf(panel) {
    let f = fiberOf(panel);
    for (let i = 0; f && i < 10; i++, f = f.return) {
        const p = f.memoizedProps;
        if (p && typeof p === "object" && typeof p.seat === "number") return p.seat;
    }
    return -1;
}

/* ---------- events ---------- */

/* ui2 dispatches each server event to a client method (StartHandEvent ->
 * onEventStartHand). Wrapping every on* method on the instance gives the same
 * before/after split the real host has: before runs ahead of the method that
 * applies the event, on runs after it. Nested calls with the same event object
 * (a handler calling another on* method) fire once, at the outermost call. */
function tapEvents(client, emit) {
    const names = new Set();
    for (let p = client; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const n of Object.getOwnPropertyNames(p)) {
            if (/^on[A-Z]/.test(n) && typeof client[n] === "function") names.add(n);
        }
    }
    // The dispatcher calls onEventInteraction?.() and the client has none, so
    // interactions vanish unless something answers to that name.
    names.add("onEventInteraction");

    const inFlight = new Set();
    const restore = [];
    for (const n of names) {
        const own = Object.prototype.hasOwnProperty.call(client, n);
        const orig = client[n];
        client[n] = function (e, ...rest) {
            const isEvent = e && typeof e === "object" && typeof e.typeName === "string";
            if (!isEvent || inFlight.has(e)) return orig ? orig.call(this, e, ...rest) : undefined;
            inFlight.add(e);
            const before = emit.snapshot();
            emit.fire("before", e, before);
            let out;
            try { out = orig ? orig.call(this, e, ...rest) : undefined; }
            finally { inFlight.delete(e); }
            // Handlers may be async (animations awaited by the pump); run "on"
            // after the state is really applied.
            Promise.resolve(out).then(() => emit.fire("on", e, before), () => {});
            return out;
        };
        restore.push(() => { if (own) client[n] = orig; else delete client[n]; });
    }
    return () => restore.forEach((f) => f());
}

/* ---------- slots ---------- */

/* Each slot outlet finds where ui2 would have rendered the slot, keeps one
 * container there per registration, and hands props to the feature's mount.
 * ui2 re-renders freely, so outlets re-check their containers on every client
 * notify and on a slow timer, and remount any that React dropped. */
function makeOutlets(client, getCtx) {
    const regs = new Map(); // slot -> Set of {mount, opts, insts: Map(key -> {el, inst})}
    const ROOT = () => document.querySelector("#GGame");

    const mountInto = (reg, key, parent, props, cls, before) => {
        let rec = reg.insts.get(key);
        if (rec && (!rec.el.isConnected || rec.el.parentNode !== parent)) {
            try { rec.inst && rec.inst.destroy && rec.inst.destroy(); } catch (e) { LOG(e); }
            rec.el.remove();
            rec = null;
        }
        if (!rec) {
            const el = document.createElement("div");
            el.className = "gpt-slot " + cls;
            if (before) parent.insertBefore(el, before); else parent.appendChild(el);
            let inst = null;
            try { inst = reg.mount(el, props) || null; } catch (e) { LOG(cls, "mount failed", e); }
            rec = { el, inst };
            reg.insts.set(key, rec);
        } else if (rec.inst && rec.inst.update) {
            try { rec.inst.update(props); } catch (e) { LOG(cls, "update failed", e); }
        }
        return rec;
    };

    const prune = (reg, live) => {
        for (const [k, rec] of reg.insts) {
            if (live.has(k)) continue;
            try { rec.inst && rec.inst.destroy && rec.inst.destroy(); } catch (e) { LOG(e); }
            rec.el.remove();
            reg.insts.delete(k);
        }
    };

    const geometry = () => {
        const shape = document.querySelector("#GGame [data-table-shape]");
        if (!shape) return null;
        const sb = shape.getBoundingClientRect();
        const seatRects = {};
        const panels = {};
        for (const p of document.querySelectorAll("#GGame .iogc-PlayerPanel")) {
            const s = seatOf(p);
            if (s < 0) continue;
            // The whole seat, avatar and name box together.
            const seatEl = p.closest(".iogc-PlayerPanel-portrait-container") || p;
            const r = seatEl.getBoundingClientRect();
            seatRects[s] = { left: r.left - sb.left, top: r.top - sb.top, width: r.width, height: r.height };
            panels[s] = p;
        }
        return {
            shape,
            panels,
            tableRect: { left: sb.left + scrollX, top: sb.top + scrollY, width: sb.width, height: sb.height },
            seatRects,
            scale: shape.offsetWidth ? sb.width / shape.offsetWidth : 1,
        };
    };

    const renderers = {
        "table.overlay": (reg, g) => {
            if (!g) return prune(reg, new Set());
            const host = g.shape.parentElement;
            if (getComputedStyle(host).position === "static") host.style.position = "relative";
            const rec = mountInto(reg, "t", host, { tableRect: g.tableRect, seatRects: g.seatRects, scale: g.scale }, "gpt-overlay");
            Object.assign(rec.el.style, {
                position: "absolute", pointerEvents: "none", zIndex: 2,
                left: g.shape.offsetLeft + "px", top: g.shape.offsetTop + "px",
                width: g.shape.offsetWidth + "px", height: g.shape.offsetHeight + "px",
            });
            prune(reg, new Set(["t"]));
        },
        "seat.badge": (reg, g) => {
            const live = new Set();
            const info = client.table && client.table.data && client.table.data.gameInfo;
            if (g) for (const [s, panel] of Object.entries(g.panels)) {
                const player = info && info.playerInfo ? info.playerInfo[s] : null;
                const key = "s" + s;
                live.add(key);
                // The name/chips box clips; its column also holds the badges
                // row underneath, which has room, so anchor there.
                const col = panel.closest(".iogc-PlayerPanel-portraitCol") || panel;
                if (getComputedStyle(col).position === "static") col.style.position = "relative";
                mountInto(reg, key, col, {
                    seat: +s, player, user: player && player.user, isMe: +s === client.mySeat,
                }, "gpt-seat-badge");
            }
            prune(reg, live);
        },
        "chat.toolbar": (reg) => {
            const panel = document.querySelector("#GGame .iogc-ChatPanel-input");
            if (!panel) return prune(reg, new Set());
            const input = panel.querySelector("input, textarea");
            // Every registration shares one row under the input, in the order
            // they registered.
            let row = panel.parentElement.querySelector(":scope > .gpt-chat-toolbar");
            if (!row) {
                row = document.createElement("div");
                row.className = "gpt-chat-toolbar";
            }
            if (row.previousElementSibling !== panel) panel.after(row);
            mountInto(reg, "c", row, {
                send: (t) => getCtx().actions.chat(t),
                insert: (t) => {
                    if (!input) return;
                    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
                    set.call(input, (input.value ? input.value + " " : "") + t);
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.focus();
                },
            }, "gpt-chat-toolbar-item");
            const order = [...regs.get("chat.toolbar")];
            const mine = reg.insts.get("c").el;
            const next = order.slice(order.indexOf(reg) + 1).map((r) => r.insts.get("c") && r.insts.get("c").el).find((e) => e && e.parentNode === row);
            if (next && mine.nextSibling !== next) row.insertBefore(mine, next);
            prune(reg, new Set(["c"]));
            if (!row.children.length) row.remove();
        },
        "rail.panel": (reg) => {
            // An editors list (GPokr Tools' own) goes onto the shim's settings
            // panel, each feature's buttons on its switch's row, rather than into
            // a column of its own.
            if (reg.opts && reg.opts.editors) {
                const rail = window.__gptShim && window.__gptShim.rail;
                if (rail && rail.editors !== reg.opts.editors) rail.setEditors(reg.opts.editors);
                return;
            }
            // ui2 shows extension panels as a column in the table's side rail.
            // The column runs far below the fold; sit right under the Me panel.
            const col = document.querySelector("#iogc-PlayerPanel .iogc-RailColumn");
            if (!col) return prune(reg, new Set());
            const slots = [...col.children].filter((k) => !k.classList.contains("gpt-slot"));
            const rec = mountInto(reg, "r", col, {}, "gpt-rail-panel iogc-RailSlot", slots[1] || null);
            if (reg.opts && reg.opts.title && !rec.el.dataset.title) rec.el.dataset.title = reg.opts.title;
            prune(reg, new Set(["r"]));
        },
    };

    let raf = 0;
    const sync = () => {
        raf = 0;
        if (!ROOT()) return;
        const g = geometry();
        for (const [slot, set] of regs) {
            const r = renderers[slot];
            if (r) for (const reg of set) r(reg, g);
        }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };

    const unsub = client.subscribe(schedule);
    const timer = setInterval(schedule, 1000);
    const ro = new ResizeObserver(schedule);
    const root = ROOT();
    if (root) ro.observe(root);
    addEventListener("resize", schedule);

    return {
        register(slot, Component, opts) {
            if (!renderers[slot]) { LOG(`slot ${slot} is not rendered by this host`); return () => {}; }
            const mount = Component && Component.__mount;
            if (!mount) { LOG(`slot ${slot}: the shim needs a component from slot()`); return () => {}; }
            const reg = { mount, opts: opts || {}, insts: new Map() };
            if (!regs.has(slot)) regs.set(slot, new Set());
            regs.get(slot).add(reg);
            schedule();
            return () => {
                prune(reg, new Set());
                regs.get(slot).delete(reg);
                const rail = window.__gptShim && window.__gptShim.rail;
                if (reg.opts && reg.opts.editors && rail && rail.editors === reg.opts.editors) rail.setEditors(null);
                for (const row of document.querySelectorAll(".gpt-chat-toolbar")) if (!row.children.length) row.remove();
            };
        },
        dispose() {
            unsub(); clearInterval(timer); ro.disconnect();
            removeEventListener("resize", schedule);
            if (raf) cancelAnimationFrame(raf);
            for (const set of regs.values()) for (const reg of set) prune(reg, new Set());
            regs.clear();
        },
    };
}

/* ---------- ctx ---------- */

export function createContext({ client, manifest, base, settings, onDispose }) {
    const disposers = [];
    const track = (off) => { disposers.push(off); return off; };
    const id = manifest.id;
    const perms = new Set(manifest.permissions || []);
    const need = (p, what) => {
        if (perms.has(p)) return true;
        LOG(`${what} needs the ${p} permission`);
        return false;
    };

    const state = {
        get() {
            const d = client.table && client.table.data;
            return { gameType: "gpokr", tableData: d || null, gameInfo: d ? d.gameInfo : null, mySeat: client.mySeat, user: client.userInfo };
        },
        subscribe(fn) { return track(client.subscribe(() => { try { fn(state.get()); } catch (e) { LOG(e); } })); },
        log() { return client.getGameEntries(); },
    };

    // Event listeners, by typeName or "*".
    const listeners = { before: new Map(), on: new Map() };
    const emit = {
        snapshot() {
            const s = state.get();
            // A plain copy: the client mutates gameInfo in place as it applies.
            try { return { ...s, gameInfo: s.gameInfo ? JSON.parse(JSON.stringify(s.gameInfo)) : null }; }
            catch (e) { return s; }
        },
        fire(phase, e, before) {
            const m = listeners[phase];
            const hs = [...(m.get(e.typeName) || []), ...(m.get("*") || [])];
            if (!hs.length) return;
            const arg = { event: Object.freeze({ ...e }), before };
            for (const h of hs) { try { h(arg); } catch (err) { LOG(e.typeName, "handler threw", err); } }
        },
    };
    track(tapEvents(client, emit));
    const addListener = (phase) => (name, h) => {
        const m = listeners[phase];
        if (!m.has(name)) m.set(name, new Set());
        m.get(name).add(h);
        return track(() => m.get(name).delete(h));
    };

    const outlets = makeOutlets(client, () => ctx);
    track(() => outlets.dispose());

    const settingListeners = new Map();
    const values = () => settings.values;
    track(settings.subscribe((key, v) => {
        for (const fn of settingListeners.get(key) || []) { try { fn(v); } catch (e) { LOG(e); } }
    }));

    const localKey = (k) => `ext.${id}.${k}`;

    const ctx = {
        api: { version: API_VERSION },
        manifest,
        game: "gpokr",
        platform: "web",
        surface: "table",
        state,
        events: { on: addListener("on"), before: addListener("before") },
        actions: {
            chat(text) { if (need("actions:chat", "chat()")) client.onChatSendMessage(String(text)); },
            react(messageId, emoji) { if (need("actions:chat", "react()")) client.toggleReaction(messageId, emoji); },
            interact(type, payload = "", toUserId = 0) { if (need("actions:interact", "interact()")) client.sendInteraction(type, payload, toUserId); },
            follow(name) { if (need("actions:follow", "follow()")) client.onFollowPlayer && client.onFollowPlayer(name); },
            unfollow(name) { if (need("actions:follow", "unfollow()")) client.onRemoveFollowing && client.onRemoveFollowing(name); },
            setBetAmount(n) { if (need("actions:bet-amount", "setBetAmount()")) setBetInput(n, client); },
        },
        ui: { register: (slotName, C, opts) => track(outlets.register(slotName, C, opts)) },
        settings: {
            get: (k) => values()[k],
            onChange(k, fn) {
                if (!settingListeners.has(k)) settingListeners.set(k, new Set());
                settingListeners.get(k).add(fn);
                return track(() => settingListeners.get(k).delete(fn));
            },
        },
        storage: {
            local: {
                get(k) { try { const v = localStorage.getItem(localKey(k)); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } },
                set(k, v) { try { localStorage.setItem(localKey(k), JSON.stringify(v)); } catch (e) { LOG(e); } },
                remove(k) { try { localStorage.removeItem(localKey(k)); } catch (e) { /* ignore */ } },
            },
            // The real host saves this to the account. The shim has no endpoint
            // of its own, so features fall back to local, as they would signed out.
            account: null,
        },
        keys: makeKeys(track),
        rest: {
            async get(path) {
                if (!need("rest:read", "rest.get()")) return null;
                const token = await client.getAccessToken();
                const r = await fetch(`/api/gpokr${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
                if (!r.ok) throw new Error(`${path}: ${r.status}`);
                return r.json();
            },
        },
        sound: {
            play(rel) {
                if (!client.isSound || !client.isSound()) return;
                try { const a = new Audio(new URL(rel, base).href); a.play().catch(() => {}); } catch (e) { /* ignore */ }
            },
        },
        theme: {
            mode: () => (document.body.classList.contains("dark-mode") ? "dark" : "light"),
            onChange(fn) {
                let last = ctx.theme.mode();
                const mo = new MutationObserver(() => { const m = ctx.theme.mode(); if (m !== last) { last = m; fn(m); } });
                mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
                return track(() => mo.disconnect());
            },
            table: () => null,
        },
        assets: { url: (rel) => new URL(rel, base).href },
        react: null,
        components: null,
        log: (...a) => LOG(`${id}:`, ...a),
    };

    ctx.__dispose = () => {
        for (let i = disposers.length - 1; i >= 0; i--) { try { disposers[i](); } catch (e) { LOG(e); } }
        disposers.length = 0;
        if (onDispose) onDispose();
    };
    return ctx;
}

/* ---------- helpers ---------- */

const RESERVED_KEYS = new Set(["1", "2", "3", "-", "_", "+", "=", ",", ".", "/"]);
function isTyping(t) {
    return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
}
function makeKeys(track) {
    return {
        bind(key, handler) {
            if (RESERVED_KEYS.has(key)) { LOG(`key ${key} belongs to the table`); return () => {}; }
            const fn = (e) => {
                if (e.key !== key || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
                handler(e);
            };
            addEventListener("keydown", fn);
            return track(() => removeEventListener("keydown", fn));
        },
    };
}

/* Sets ui2's bet amount without submitting, the way the real host's
 * setBetAmount does. ui2's desktop controls have no amount box: the number on
 * the Bet/Raise button is a useState on the betting-controls component (the
 * one with an inlineBet prop), moved by its −/+/pot helpers. That state is
 * found by matching the number the button shows, and set through React's own
 * dispatcher, clamped to what the helpers would allow: at least the minimum
 * raise, at most my stack. The amount is chips added now, as the label shows. */
let betHookIndex = -1;
function setBetInput(n, client) {
    const btn = document.querySelector("#GGame .gbetting-betraise");
    if (!btn) { LOG("no bet button on screen"); return; }
    const shown = parseInt(btn.textContent.replace(/[^\d]/g, ""), 10);
    let f = fiberOf(btn);
    for (let i = 0; f && i < 30 && !(f.memoizedProps && "inlineBet" in f.memoizedProps); i++) f = f.return;
    if (!f) { LOG("betting controls not found"); return; }
    // React keeps two copies of a component (current and alternate) and the
    // DOM node may point at either; after an update only one holds the value
    // on screen. Both share the hook's queue, so either can dispatch.
    // Other state on the component can hold the same number (the call price,
    // say), so a match only counts when it is the one hook with that value;
    // its position is then remembered, since hook order never changes.
    const hooks = (fiber) => {
        const out = [];
        for (let h = fiber && fiber.memoizedState, i = 0; h && typeof h === "object" && "next" in h && i < 80; h = h.next, i++) out.push(h);
        return out;
    };
    let setter = null;
    for (const fiber of [f, f.alternate]) {
        const hs = hooks(fiber);
        const known = hs[betHookIndex];
        if (known && known.queue && known.memoizedState === shown) { setter = known.queue.dispatch; break; }
        const hits = hs.map((h, i) => [h, i]).filter(([h]) => h.queue && typeof h.queue.dispatch === "function" && h.memoizedState === shown);
        if (hits.length === 1) { setter = hits[0][0].queue.dispatch; betHookIndex = hits[0][1]; break; }
    }
    if (!setter) { LOG("bet amount state not found"); return; }
    const gi = client.table && client.table.data && client.table.data.gameInfo;
    const me = gi && gi.playerInfo ? gi.playerInfo[client.mySeat] : null;
    let amount = Math.round(n);
    if (gi && me) {
        const toCall = Math.max(0, (gi.highBet || 0) - (me.callAmount || 0));
        const minRaise = toCall + Math.max(gi.topRaise || 0, gi.bigBlind || 0);
        amount = Math.min(Math.max(amount, minRaise), me.score);
    }
    setter(amount);
}
