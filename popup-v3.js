/* Popup for GPokr Tools v3 under the Chrome shim. The switches come from
 * v3/manifest.json, the same schema ui2's Settings > Extensions renders, so a
 * new setting only has to be added in one place. Values live in
 * chrome.storage.local under gpt_settings; content-v3.js forwards changes. */
(function () {
    "use strict";

    const KEY = "gpt_settings";
    const root = document.getElementById("settings");

    Promise.all([
        fetch(chrome.runtime.getURL("v3/manifest.json")).then((r) => r.json()),
        new Promise((res) => chrome.storage.local.get([KEY], (v) => res(v[KEY] || {}))),
    ]).then(([manifest, saved]) => {
        document.getElementById("ver").textContent = `v${manifest.version} · for the new ui2 table`;
        const values = { ...saved };
        for (const s of manifest.settings) {
            if (s.type !== "switch") continue;
            const label = document.createElement("label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = values[s.key] === undefined ? !!s.default : !!values[s.key];
            box.addEventListener("change", () => {
                values[s.key] = box.checked;
                chrome.storage.local.set({ [KEY]: values });
            });
            const name = document.createElement("span");
            name.textContent = s.label;
            label.append(box, name);
            if (s.hint) {
                const hint = document.createElement("span");
                hint.className = "hint";
                hint.textContent = s.hint;
                label.append(hint);
            }
            root.append(label);
        }
    });
})();
