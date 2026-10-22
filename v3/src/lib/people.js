/* Nicknames and notes, per player name: { name: text } in the prefs
 * ("playerNicks", "playerNotes"), so they follow the account when the host
 * offers account storage. The classic add-on's are carried over by the
 * Chrome shim the first time v3 runs (same shape, same keys by name). */

const clean = (s, max) => String(s || "").trim().slice(0, max);

export function createPeople(prefs) {
    const map = (k) => prefs.get(k) || {};
    const put = (k, name, text) => {
        const next = { ...map(k) };
        if (text) next[name] = text; else delete next[name];
        return prefs.set(k, next);
    };
    return {
        nick: (name) => (name && map("playerNicks")[name]) || "",
        note: (name) => (name && map("playerNotes")[name]) || "",
        async save(name, nick, note) {
            if (!name) return;
            await put("playerNicks", name, clean(nick, 40));
            await put("playerNotes", name, clean(note, 2000));
        },
        onChange(fn) { return prefs.onChange((k) => { if (k === "playerNicks" || k === "playerNotes") fn(); }); },
    };
}
