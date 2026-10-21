/* Isolated-world half of the v3 shim: puts shim/boot.js into the page as a
 * module (it needs the page's React fibers, which this world cannot see) and
 * carries settings from chrome.storage to it. Only the ui2 page needs it; the
 * classic GWT client is served by the legacy-ui build. */
(function () {
    "use strict";

    const SETTINGS_KEY = "gpt_settings";

    // The classic add-on's chat and bet buttons ride along, so the shim can
    // carry them over the first time v3 runs.
    const LEGACY_KEY = "gpe_settings";
    const send = () => {
        chrome.storage.local.get([SETTINGS_KEY, LEGACY_KEY], (res) => {
            const old = res[LEGACY_KEY] || {};
            window.postMessage({
                __gpt: "settings",
                values: res[SETTINGS_KEY] || {},
                legacy: { chatButtons: old.chatButtons, betButtons: old.betButtons },
            }, "*");
        });
    };

    window.addEventListener("message", (e) => {
        if (e.source !== window || !e.data) return;
        if (e.data.__gpt === "hello") send();
        // A switch flipped in the page's own panel. Only known keys, only
        // booleans: the page is not trusted to write anything else here.
        if (e.data.__gpt === "set" && typeof e.data.key === "string" && /^[a-zA-Z0-9]{1,40}$/.test(e.data.key)
                && typeof e.data.value === "boolean") {
            chrome.storage.local.get([SETTINGS_KEY], (res) => {
                const values = res[SETTINGS_KEY] || {};
                values[e.data.key] = e.data.value;
                chrome.storage.local.set({ [SETTINGS_KEY]: values });
            });
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[SETTINGS_KEY]) send();
    });

    const s = document.createElement("script");
    s.type = "module";
    s.src = chrome.runtime.getURL("shim/boot.js");
    (document.head || document.documentElement).appendChild(s);
})();
