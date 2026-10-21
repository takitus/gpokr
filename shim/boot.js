/* Starts GPokr Tools v3 under the Chrome shim. Loaded as a module into the
 * page's MAIN world by content-v3.js, or imported by hand from a local server
 * while developing. Settings come from the extension's storage through
 * window.postMessage({__gpt: "settings"}); without the extension (dev) every
 * switch sits at its manifest default.
 *
 * The real ui2 host takes over once the site lists the extension: if it has
 * already loaded a copy (window.__ui2 is set up by the host when it activates
 * any extension), the shim stands down instead of running a second one. */

import { findClient, createContext } from "./host.js";
import { startSettingsRail } from "./settingsRail.js";

const HERE = new URL(".", import.meta.url);
// The extension's root: assets resolve against it (v3/style.css, vendor/,
// 3d/, assets/), the same layout a release build publishes.
const ROOT = new URL("../", HERE);
const V3 = new URL("v3/", ROOT);
const LOG = (...a) => console.log("[gpokr-tools shim]", ...a);

function settingsStore(manifest) {
    let gotFirst;
    const first = new Promise((res) => { gotFirst = res; });
    const defaults = {};
    for (const s of manifest.settings || []) defaults[s.key] = s.default;
    const store = { values: { ...defaults }, subs: new Set() };
    store.subscribe = (fn) => { store.subs.add(fn); return () => store.subs.delete(fn); };
    store.apply = (incoming) => {
        const next = { ...defaults, ...(incoming || {}) };
        for (const k of Object.keys(next)) {
            if (next[k] === store.values[k]) continue;
            store.values[k] = next[k];
            for (const fn of store.subs) fn(k, next[k]);
        }
    };
    addEventListener("message", (e) => {
        if (e.source !== window || !e.data || e.data.__gpt !== "settings") return;
        adoptLegacy(manifest.id, e.data.legacy);
        store.apply(e.data.values);
        gotFirst();
    });
    // Without the extension (a dev import) nothing answers; go with defaults.
    store.ready = Promise.race([first, new Promise((res) => setTimeout(res, 800))]);
    return store;
}

/* The classic add-on's button lists, copied once into the storage v3 reads
 * (the host's own local-storage layout), never over anything v3 has saved. */
function adoptLegacy(id, legacy) {
    if (!legacy) return;
    for (const k of ["chatButtons", "betButtons"]) {
        const key = `ext.${id}.${k}`;
        try {
            if (Array.isArray(legacy[k]) && localStorage.getItem(key) === null) {
                localStorage.setItem(key, JSON.stringify(legacy[k]));
            }
        } catch (e) { /* storage blocked */ }
    }
}

async function main() {
    if (window.__gptShim) return;
    window.__gptShim = { version: 0 };

    const manifest = await (await fetch(new URL("manifest.json", V3))).json();
    const settings = settingsStore(manifest);
    window.postMessage({ __gpt: "hello" }, "*");
    await settings.ready;

    // The rail button and its panel are the shim's own, so its styles are too.
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("shim.css", HERE).href;
    document.head.appendChild(css);
    // A flip applies at once; the extension saves it and echoes it back.
    const stopRail = startSettingsRail(manifest, settings, (key, value) => {
        settings.apply({ ...settings.values, [key]: value });
        window.postMessage({ __gpt: "set", key, value }, "*");
    });

    let ext = null;
    let client = null;
    let ctx = null;
    let stop = null;

    const teardown = () => {
        try { if (typeof stop === "function") stop(); } catch (e) { LOG("deactivate threw", e); }
        try { if (ctx) ctx.__dispose(); } catch (e) { LOG(e); }
        stop = ctx = null;
    };

    const tick = async () => {
        if (window.__ui2 && !window.__gptShim.native) {
            // The site's own host is running extensions; don't double up.
            window.__gptShim.native = true;
            LOG("ui2's extension host is active; the shim stands down");
            teardown();
            return;
        }
        const c = findClient();
        if (c === client) return;
        teardown();
        client = c;
        if (!client) return;
        try {
            if (!ext) ext = (await import(new URL("src/index.js", V3).href)).default;
            ctx = createContext({ client, manifest, base: ROOT.href, settings });
            stop = await ext.activate(ctx);
            window.__gptShim.ctx = ctx;
            LOG("activated on", client.table && client.table.data && client.table.data.tableInfo && client.table.data.tableInfo.name);
        } catch (e) {
            LOG("did not start", e);
            teardown();
        }
    };

    window.__gptShim.teardown = () => { clearInterval(timer); teardown(); stopRail(); css.remove(); };
    const timer = setInterval(tick, 1000);
    tick();
}

main();
