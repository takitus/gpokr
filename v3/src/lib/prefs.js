/* The player's own lists (chat buttons, bet buttons): things they edit rather
 * than switch, so they are not manifest settings (nicknames and notes too). They follow the account when
 * the host offers account storage, and live in this browser otherwise. Lists
 * saved by the classic add-on are copied in by the Chrome shim, as local
 * values, the first time v3 runs. */

export function createPrefs(ctx) {
    const local = ctx.storage.local;
    const account = ctx.storage.account;
    let doc = null;
    const subs = new Set();

    const ready = (async () => {
        let fromAccount = null;
        if (account) {
            try { fromAccount = await account.get(); } catch (e) { ctx.log("account storage", e); }
        }
        doc = fromAccount && typeof fromAccount === "object" ? { ...fromAccount } : {};
        // Seed from this browser for anything the account does not have yet.
        for (const k of ["chatButtons", "betButtons", "look", "betReadout", "playerNicks", "playerNotes"]) {
            if (doc[k] === undefined) {
                const v = local.get(k);
                if (v !== undefined) doc[k] = v;
            }
        }
        return doc;
    })();

    return {
        ready,
        get: (k) => (doc ? doc[k] : undefined),
        async set(k, v) {
            await ready;
            doc[k] = v;
            local.set(k, v);
            if (account) { try { await account.set(doc); } catch (e) { ctx.log("account storage", e); } }
            for (const fn of subs) { try { fn(k, v); } catch (e) { ctx.log(e); } }
        },
        onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}
