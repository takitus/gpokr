/* The Takitus Tools document: player stats, notes and nicknames, by user id.
 *
 * A port of the store in ui2's bundled Takitus Tools 3.0.0, kept to its exact
 * format and merge rules on purpose. This build replaces 3.0.0 on the web
 * under the same id, so it inherits the same account document, and the app
 * (which only ever runs the bundled 3.0.0) goes on writing it too. Both must
 * read and write one format, or each would wipe the other's work.
 *
 * The document (version 1):
 *   { stats: { userId: {name, hands, vpip, pfr, bets, raises, calls,
 *                       showdowns, sdWins, seen} },
 *     notes: { userId: text }, nicknames: { userId: text },
 *     v: 1, w: [write ids, newest last, at most 16] }
 * It lives in account storage when the host has it, and in local storage
 * ("doc") otherwise (signed out, or under the Chrome shim). Saves are batched
 * (10s; notes at once). A save that loses a race re-reads the account copy and
 * merges: stats by adding this session's deltas onto theirs, notes and
 * nicknames by taking what this session changed. A local copy left from a
 * signed-out session is merged in once, recognised by its last write id. At
 * most 500 players are kept, the least recently seen dropped first. */

const LOCAL_KEY = "doc";
const MAX_PLAYERS = 500;
const SAVE_MS = 10000;
const SAVE_TRIES = 3;
const COUNTS = ["hands", "vpip", "pfr", "bets", "raises", "calls", "showdowns", "sdWins"];

const empty = () => ({ stats: {}, notes: {}, nicknames: {}, v: 1 });
const isObj = (o) => typeof o === "object" && o !== null && !Array.isArray(o);

function readStat(o) {
    if (!isObj(o) || typeof o.name !== "string") return null;
    const n = (k) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] : 0);
    return {
        name: o.name, hands: n("hands"), vpip: n("vpip"), pfr: n("pfr"), bets: n("bets"),
        raises: n("raises"), calls: n("calls"), showdowns: n("showdowns"), sdWins: n("sdWins"), seen: n("seen"),
    };
}
function readTexts(o) {
    const out = {};
    if (!isObj(o)) return out;
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v) out[k] = v;
    return out;
}
/* A valid version 1 document, cleaned, or null. */
export function readDoc(o) {
    if (!isObj(o) || o.v !== 1) return null;
    const stats = {};
    if (isObj(o.stats)) for (const [id, s] of Object.entries(o.stats)) { const r = readStat(s); if (r) stats[id] = r; }
    const doc = { stats, notes: readTexts(o.notes), nicknames: readTexts(o.nicknames), v: 1 };
    if (Array.isArray(o.w)) doc.w = o.w.filter((x) => typeof x === "string").slice(-16);
    return doc;
}
function copy(d) {
    const stats = {};
    for (const [id, s] of Object.entries(d.stats)) stats[id] = { ...s };
    const out = { stats, notes: { ...d.notes }, nicknames: { ...d.nicknames }, v: 1 };
    if (d.w) out.w = [...d.w];
    return out;
}
const lastWrite = (d) => d.w && d.w[d.w.length - 1];
const writeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sameCounts = (a, b) => COUNTS.every((k) => a[k] === b[k]);
const blankStat = (name) => ({ name, hands: 0, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, showdowns: 0, sdWins: 0, seen: 0 });

/* What changed from `from` to `mine`, applied on top of `theirs`. */
function merge(from, mine, theirs) {
    const out = copy(theirs);
    for (const [id, s] of Object.entries(mine.stats)) {
        const was = from.stats[id];
        if (was && sameCounts(was, s)) continue;
        const t = out.stats[id];
        if (!t) { out.stats[id] = { ...s }; continue; }
        for (const k of COUNTS) t[k] += s[k] - (was ? was[k] : 0);
        if (s.seen >= t.seen) { t.seen = s.seen; t.name = s.name; }
    }
    for (const field of ["notes", "nicknames"]) {
        for (const id of new Set([...Object.keys(from[field]), ...Object.keys(mine[field])])) {
            const v = mine[field][id];
            if (v === from[field][id]) continue;
            if (v === undefined) delete out[field][id]; else out[field][id] = v;
        }
    }
    out.w = [...new Set([...(theirs.w || []), ...(mine.w || [])])].slice(-16);
    trim(out.stats);
    return out;
}
function trim(stats) {
    const ids = Object.keys(stats);
    if (ids.length <= MAX_PLAYERS) return;
    ids.sort((a, b) => stats[b].seen - stats[a].seen);
    for (const id of ids.slice(MAX_PLAYERS)) delete stats[id];
}
function setText(map, id, text) {
    const t = String(text || "").trim();
    if (t) map[id] = t; else delete map[id];
}

export function createToolsDoc(ctx) {
    let doc = empty();
    let base = null;          // the account copy this session last agreed with
    let localMerge = null;    // a signed-out local copy merged in, until the account has it
    let loaded = false, disposed = false;
    let pending = [];         // changes made before the load finished
    let saveTimer = null, saving = false, saveAgain = false, unsaved = false;
    const session = [];       // user ids seen this session, most recent first
    const subs = new Set();
    const notify = () => { for (const fn of subs) { try { fn(); } catch (e) { ctx.log("tools doc listener", e); } } };

    const stamp = () => {
        doc.w = [...(doc.w || []), writeId()].slice(-16);
        unsaved = false;
        return copy(doc);
    };
    const keepLocal = () => ctx.storage.local.set(LOCAL_KEY, stamp());
    const landed = (d) => {
        base = d;
        if (localMerge && d.w && d.w.includes(localMerge.id)) { localMerge = null; ctx.storage.local.remove(LOCAL_KEY); }
    };
    const baseWithLocal = (theirs) => {
        const b = base || empty();
        if (!localMerge || !(theirs.w && theirs.w.includes(localMerge.id)) || (b.w && b.w.includes(localMerge.id))) return b;
        const m = localMerge;
        localMerge = null;
        ctx.storage.local.remove(LOCAL_KEY);
        return merge(empty(), m.doc, b);
    };

    async function read(local) {
        const acct = ctx.storage.account;
        if (!acct) return { next: local || empty(), base: null, addedLocal: null };
        try {
            const raw = await acct.get();
            const theirs = raw == null ? empty() : readDoc(raw);
            if (theirs) {
                if (!local) return { next: copy(theirs), base: theirs, addedLocal: null };
                const id = lastWrite(local);
                return id && theirs.w && theirs.w.includes(id)
                    ? { next: copy(theirs), base: theirs, addedLocal: "already" }
                    : { next: merge(empty(), local, theirs), base: theirs, addedLocal: "merged" };
            }
            ctx.log("the account copy is not a version 1 document; this session saves in the browser only");
        } catch (e) {
            ctx.log("could not read the account copy; this session saves in the browser only", e);
        }
        return { next: local || empty(), base: null, addedLocal: null };
    }

    async function saveToAccount(acct) {
        for (let i = 0; i < SAVE_TRIES; i++) {
            const out = stamp();
            const id = lastWrite(out);
            let ok = false;
            try { ok = await acct.set(out); } catch (e) { ctx.log("account save threw", e); }
            if (ok) { landed(out); return; }
            let theirs;
            try { const raw = await acct.get(); theirs = raw == null ? empty() : readDoc(raw); }
            catch (e) { ctx.log("account save failed", e); unsaved = true; return; }
            if (!theirs) {
                ctx.log("the account copy is no longer a version 1 document; this session saves in the browser only");
                base = null; unsaved = true; return;
            }
            if (base && id && theirs.w && theirs.w.includes(id)) landed(out);
            doc = merge(baseWithLocal(theirs), doc, theirs);
            base = theirs;
            unsaved = true;
            notify();
        }
        ctx.log("the account copy kept changing; the next change saves again");
    }
    async function save() {
        if (saving) { saveAgain = true; return; }
        saving = true;
        try {
            const acct = ctx.storage.account;
            if (acct && base) await saveToAccount(acct); else keepLocal();
        } finally {
            saving = false;
            if (saveAgain) { saveAgain = false; if (unsaved) schedule(true); }
        }
    }
    function schedule(now) {
        if (disposed) return;
        if (now) { if (saveTimer != null) clearTimeout(saveTimer); saveTimer = null; save(); return; }
        if (saveTimer == null) saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_MS);
    }
    function change(fn, now) {
        fn(doc);
        unsaved = true;
        if (loaded) schedule(now); else pending.push(fn);
        notify();
    }

    const api = {
        get: () => doc,
        isLoaded: () => loaded,
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        sessionPlayers: () => session,
        async load() {
            const local = readDoc(ctx.storage.local.get(LOCAL_KEY));
            const r = await read(local);
            if (disposed) return;
            for (const fn of pending) fn(r.next);
            const hadPending = pending.length > 0;
            pending = [];
            doc = r.next; base = r.base; loaded = true;
            notify();
            if (r.addedLocal === "merged") { const id = local && lastWrite(local); if (local && id) localMerge = { id, doc: local }; }
            else if (r.addedLocal === "already") ctx.storage.local.remove(LOCAL_KEY);
            if (hadPending || r.addedLocal === "merged") { unsaved = true; schedule(r.addedLocal === "merged"); }
        },
        /* One finished hand: { userId: {name, vpip, pfr, bets, raises, calls, showdown, sdWin} }. */
        recordHand(tallies) {
            const rows = [...tallies].map(([userId, t]) => ({ userId, ...t }));
            if (!rows.length) return;
            const now = Date.now();
            for (const r of rows) {
                const i = session.indexOf(r.userId);
                if (i >= 0) session.splice(i, 1);
                session.unshift(r.userId);
            }
            change((d) => {
                for (const r of rows) {
                    const s = d.stats[r.userId] || blankStat(r.name);
                    s.name = r.name; s.hands++;
                    s.vpip += r.vpip; s.pfr += r.pfr; s.bets += r.bets; s.raises += r.raises; s.calls += r.calls;
                    s.showdowns += r.showdown; s.sdWins += r.sdWin; s.seen = now;
                    d.stats[r.userId] = s;
                }
                trim(d.stats);
            }, false);
        },
        addShowdownWin(userId) { change((d) => { const s = d.stats[userId]; if (s) s.sdWins++; }, false); },
        saveNoteAndNickname(userId, note, nickname) {
            change((d) => { setText(d.notes, userId, note); setText(d.nicknames, userId, nickname); }, true);
        },
        dispose() {
            disposed = true;
            subs.clear();
            if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
            if (!loaded || !unsaved) return;
            const acct = ctx.storage.account;
            if (acct && base) acct.set(stamp()); else keepLocal();
        },
    };
    return api;
}
