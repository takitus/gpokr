/* Popup for GPokr Tools: settings toggles + learned-card-store progress and
 * export/import. All state lives in chrome.storage.local; the content script
 * picks changes up via chrome.storage.onChanged. */
(function () {
    "use strict";

    const SETTINGS_KEY = "gpe_settings";
    const CARD_STORE_KEY = "gpe_card_images_v2";
    const TOGGLE_IDS = ["showOdds", "shareHand", "localTest"];

    const $ = (id) => document.getElementById(id);
    const statusEl = $("status");

    function setStatus(msg, isError) {
        statusEl.textContent = msg;
        statusEl.className = isError ? "err" : "";
    }

    // A learned entry is a card code ("As", "Td"...) mapping to a data: image.
    function validCard(key, val) {
        return /^[2-9TJQKA][cdhs]$/.test(key) && typeof val === "string" && val.startsWith("data:");
    }

    function renderStore(store) {
        const n = Object.keys(store).length;
        $("cardCount").textContent = n + " / 52 card images learned";
        $("barFill").style.width = Math.round((n / 52) * 100) + "%";
    }

    // ---------- settings ----------
    chrome.storage.local.get([SETTINGS_KEY, CARD_STORE_KEY], (res) => {
        const s = res[SETTINGS_KEY] || {};
        TOGGLE_IDS.forEach((id) => { $(id).checked = !!s[id]; });
        renderStore(res[CARD_STORE_KEY] || {});
    });

    TOGGLE_IDS.forEach((id) => {
        $(id).addEventListener("change", () => {
            const s = {};
            TOGGLE_IDS.forEach((t) => { s[t] = $(t).checked; });
            chrome.storage.local.set({ [SETTINGS_KEY]: s });
        });
    });

    // Live-update the count while the table keeps learning in the background.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[CARD_STORE_KEY]) {
            renderStore(changes[CARD_STORE_KEY].newValue || {});
        }
    });

    // ---------- card store export / import ----------
    $("exportBtn").addEventListener("click", () => {
        chrome.storage.local.get([CARD_STORE_KEY], (res) => {
            const store = res[CARD_STORE_KEY] || {};
            const n = Object.keys(store).length;
            if (!n) { setStatus("nothing learned yet", true); return; }
            navigator.clipboard.writeText(JSON.stringify(store))
                .then(() => setStatus("copied " + n + " cards to clipboard"))
                .catch((e) => setStatus("copy failed: " + e.message, true));
        });
    });

    $("importBtn").addEventListener("click", () => {
        const box = $("importBox");
        if (box.hidden) { box.hidden = false; box.focus(); return; }
        let incoming;
        try { incoming = JSON.parse(box.value); } catch (e) {
            setStatus("not valid JSON", true);
            return;
        }
        chrome.storage.local.get([CARD_STORE_KEY], (res) => {
            const store = res[CARD_STORE_KEY] || {};
            let added = 0, skipped = 0;
            for (const key of Object.keys(incoming || {})) {
                if (!validCard(key, incoming[key])) { skipped++; continue; }
                if (store[key]) continue; // first write wins, same as learning
                store[key] = incoming[key];
                added++;
            }
            chrome.storage.local.set({ [CARD_STORE_KEY]: store }, () => {
                renderStore(store);
                box.hidden = true;
                box.value = "";
                setStatus("imported " + added + " new card" + (added === 1 ? "" : "s") +
                    (skipped ? " (" + skipped + " invalid skipped)" : ""));
            });
        });
    });
})();
