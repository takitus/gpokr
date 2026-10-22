/* Nicknames and notes. They live in the Takitus Tools document by user id
 * (lib/toolsDoc.js), the record ui2's bundled 3.0.0 and the app share.
 *
 * The classic add-on kept them by name (gpe_player_nicknames, gpe_player_notes,
 * carried into the prefs as playerNicks / playerNotes by the Chrome shim).
 * Those are read as a fallback, and the first time the player is seen with an
 * id they move into the document (unless it already has one for them) and
 * leave the name-keyed list. */

const clean = (s, max) => String(s || "").trim().slice(0, max);

export function createPeople(ctx, store, prefs) {
    const byName = (k) => prefs.get(k) || {};
    const adopted = new Set();
    const dropName = (name) => {
        for (const k of ["playerNicks", "playerNotes"]) {
            const m = byName(k);
            if (name in m) { const next = { ...m }; delete next[name]; prefs.set(k, next); }
        }
    };

    // The user id for a name: someone seated now, else whoever by that name the
    // document saw most recently.
    function idOf(name) {
        if (!name) return null;
        const gi = ctx.state.get().gameInfo;
        for (const p of (gi && gi.playerInfo) || []) if (p && p.user && p.user.name === name) return p.user.id;
        let best = null, seen = -1;
        for (const [id, s] of Object.entries(store.get().stats)) if (s.name === name && s.seen > seen) { best = id; seen = s.seen; }
        return best;
    }

    const api = {
        idOf,
        nick(name, id = idOf(name)) {
            return (id != null && store.get().nicknames[id]) || (name && byName("playerNicks")[name]) || "";
        },
        note(name, id = idOf(name)) {
            return (id != null && store.get().notes[id]) || (name && byName("playerNotes")[name]) || "";
        },
        save(name, id, nick, note) {
            nick = clean(nick, 40);
            note = clean(note, 1000);
            if (id != null) {
                store.saveNoteAndNickname(id, note, nick);
                dropName(name);
            } else if (name) {
                for (const [k, v] of [["playerNicks", nick], ["playerNotes", note]]) {
                    const next = { ...byName(k) };
                    if (v) next[name] = v; else delete next[name];
                    prefs.set(k, next);
                }
            }
        },
        /* A classic name-keyed entry, moved to the player's id once. */
        adopt(name, id) {
            // Once per name a session: the write below repaints, which asks
            // again before the async prefs write has dropped the entry.
            if (!name || id == null || adopted.has(name) || !store.isLoaded()) return;
            adopted.add(name);
            const n = byName("playerNicks")[name], t = byName("playerNotes")[name];
            if (!n && !t) return;
            const d = store.get();
            store.saveNoteAndNickname(id, d.notes[id] || t || "", d.nicknames[id] || n || "");
            dropName(name);
        },
        onChange(fn) {
            const a = store.subscribe(fn);
            const b = prefs.onChange((k) => { if (k === "playerNicks" || k === "playerNotes") fn(); });
            return () => { a(); b(); };
        },
    };
    return api;
}
