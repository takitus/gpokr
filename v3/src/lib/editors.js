/* Which editors are available right now, by the switch they belong to: a
 * feature that is running lists its editors ({ label, open }) under its
 * manifest key, and takes them back when it stops.
 *
 * The list is handed to the host as a rail.panel registration's options. The
 * Chrome shim reads it and puts each feature's buttons on that feature's row
 * in its own settings panel, next to the switch, as the classic tools tab had
 * them. Under ui2's own host the same list is rendered as a "GPokr Tools"
 * side panel of buttons (see index.js). */

export function createEditors() {
    const byKey = new Map();
    const subs = new Set();
    const notify = () => subs.forEach((f) => { try { f(); } catch (e) { /* listener gone */ } });
    return {
        set(key, list) {
            byKey.set(key, list);
            notify();
            return () => { if (byKey.get(key) === list) { byKey.delete(key); notify(); } };
        },
        all: () => [...byKey.entries()],
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}
