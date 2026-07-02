/* Popup for GPokr Tools: settings toggles + learned-card-store progress and
 * export/import. All state lives in chrome.storage.local; the content script
 * picks changes up via chrome.storage.onChanged. */
(function () {
    "use strict";

    const SETTINGS_KEY = "gpe_settings";
    const CARD_STORE_KEY = "gpe_card_images_v2";
    const SESSION_KEY = "gpe_session";
    const TOGGLE_IDS = ["showOdds", "showStats", "darkMode", "shareHand", "localTest", "hotkeys", "showBetButtons"];
    // Toggles that default on when nothing was ever saved (opt-out, not opt-in).
    const TOGGLE_DEFAULTS = { showBetButtons: true };
    const toggleChecked = (id) =>
        settings[id] === undefined ? !!TOGGLE_DEFAULTS[id] : !!settings[id];

    function applyPopupTheme() {
        document.body.classList.toggle("dark", !!settings.darkMode);
    }

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
    // Kept as a whole object so saving one field never clobbers the others
    // (e.g. a toggle change must not wipe the bet-button config).
    let settings = {};
    function saveSettings() { chrome.storage.local.set({ [SETTINGS_KEY]: settings }); }

    chrome.storage.local.get([SETTINGS_KEY, CARD_STORE_KEY, SESSION_KEY], (res) => {
        settings = res[SETTINGS_KEY] || {};
        TOGGLE_IDS.forEach((id) => { $(id).checked = toggleChecked(id); });
        applyPopupTheme();
        renderBetRows();
        renderStore(res[CARD_STORE_KEY] || {});
        renderSession(res[SESSION_KEY]);
    });

    TOGGLE_IDS.forEach((id) => {
        $(id).addEventListener("change", () => {
            TOGGLE_IDS.forEach((t) => { settings[t] = $(t).checked; });
            applyPopupTheme();
            saveSettings();
        });
    });

    // ---------- bet-button config ----------
    // Mirrors DEFAULT_BET_BTNS in content.js: shown (and saved on first edit)
    // when nothing was ever configured. `pos` picks the column (above/below
    // the bet field); entries saved before it existed infer it from the base.
    const DEFAULT_BET_BTNS = [
        { mult: 1, base: "allin", pos: "top" },
        { mult: 3, base: "blind", pos: "top" },
        { mult: 2, base: "blind", pos: "top" },
        { mult: 0.5, base: "pot", pos: "bottom" },
        { mult: 0.67, base: "pot", pos: "bottom" },
        { mult: 1, base: "pot", pos: "bottom" },
    ];
    // `mult` is ignored for the "allin" base but always carried (default 1) so
    // switching a row's base back to blind/pot restores a usable value.
    function normEntry(c) {
        return {
            mult: (typeof c.mult === "number" && c.mult > 0) ? c.mult : 1,
            base: c.base,
            pos: c.pos === "top" || c.pos === "bottom" ? c.pos
                : (c.base === "pot" ? "bottom" : "top"),
        };
    }
    function betConfig() {
        const list = Array.isArray(settings.betButtons) ? settings.betButtons : DEFAULT_BET_BTNS;
        return list.map(normEntry);
    }
    function commitBetConfig(list) {
        settings.betButtons = list;
        saveSettings();
        renderBetRows();
    }

    // Update one field of row i, keeping the rest of the entry.
    function patchBetRow(i, patch) {
        const list = betConfig();
        list[i] = Object.assign({}, list[i], patch);
        commitBetConfig(list);
    }

    function makeSelect(options, value, onChange, labelOf) {
        const sel = document.createElement("select");
        options.forEach((v) => {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = labelOf ? labelOf(v) : v;
            sel.appendChild(o);
        });
        sel.value = value;
        sel.addEventListener("change", () => onChange(sel.value));
        return sel;
    }
    const baseLabel = (v) => (v === "allin" ? "all in" : v);

    let dragIndex = null; // index of the row being dragged

    function renderBetRows() {
        const wrap = $("betRows");
        wrap.textContent = "";
        betConfig().forEach((c, i) => {
            const row = document.createElement("div");
            row.className = "bet-row";

            // Drag to reorder: only the handle arms the drag, so the inputs
            // keep normal text selection / interaction.
            const handle = document.createElement("span");
            handle.className = "drag";
            handle.textContent = "⠿";
            handle.title = "drag to reorder";
            handle.addEventListener("mousedown", () => { row.draggable = true; });
            row.addEventListener("dragstart", (e) => {
                dragIndex = i;
                row.classList.add("dragging");
                e.dataTransfer.effectAllowed = "move";
            });
            row.addEventListener("dragend", () => {
                row.draggable = false;
                row.classList.remove("dragging");
                dragIndex = null;
            });
            row.addEventListener("dragover", (e) => {
                e.preventDefault(); // allow dropping here
                if (dragIndex !== null && dragIndex !== i) row.classList.add("dragover");
            });
            row.addEventListener("dragleave", () => row.classList.remove("dragover"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("dragover");
                if (dragIndex === null || dragIndex === i) return;
                const list = betConfig();
                const moved = list.splice(dragIndex, 1)[0];
                list.splice(i, 0, moved);
                dragIndex = null;
                commitBetConfig(list);
            });

            const num = document.createElement("input");
            num.type = "number";
            num.min = "0";
            num.step = "any";
            num.value = c.mult;
            num.addEventListener("change", () => {
                const v = parseFloat(num.value);
                if (!isFinite(v) || v <= 0) { num.value = c.mult; return; } // reject junk, keep old
                patchBetRow(i, { mult: v });
            });

            const x = document.createElement("span");
            x.textContent = "×";

            // "all in" ignores the multiplier, so hide it (value kept in state).
            if (c.base === "allin") { num.style.display = "none"; x.style.display = "none"; }

            const base = makeSelect(["blind", "pot", "allin"], c.base, (v) => patchBetRow(i, { base: v }), baseLabel);
            const pos = makeSelect(["top", "bottom"], c.pos, (v) => patchBetRow(i, { pos: v }));

            const del = document.createElement("button");
            del.className = "del";
            del.type = "button";
            del.textContent = "✕";
            del.title = "remove";
            del.addEventListener("click", () => {
                const list = betConfig();
                list.splice(i, 1);
                commitBetConfig(list);
            });

            row.append(handle, num, x, base, pos, del);
            wrap.appendChild(row);
        });
    }

    $("addBetBtn").addEventListener("click", () => {
        const list = betConfig();
        list.push({ mult: 1, base: "pot", pos: "bottom" });
        commitBetConfig(list);
    });

    // Live-update the count while the table keeps learning in the background,
    // and mirror settings changed from the in-page toggles.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[CARD_STORE_KEY]) {
            renderStore(changes[CARD_STORE_KEY].newValue || {});
        }
        if (changes[SETTINGS_KEY]) {
            settings = changes[SETTINGS_KEY].newValue || {};
            TOGGLE_IDS.forEach((id) => { $(id).checked = toggleChecked(id); });
            applyPopupTheme();
            renderBetRows();
        }
        if (changes[SESSION_KEY]) renderSession(changes[SESSION_KEY].newValue);
    });

    // ---------- session tracker ----------
    function renderSession(s) {
        const pts = (s && s.points) || [];
        const net = pts.length >= 2 ? pts[pts.length - 1] - pts[0] : 0;
        const el = $("sessionNet");
        el.textContent = pts.length
            ? (net >= 0 ? "+$" : "−$") + Math.abs(net).toLocaleString() +
              " over " + pts.length + " hand" + (pts.length === 1 ? "" : "s")
            : "no hands yet";
        el.className = net > 0 ? "pos" : net < 0 ? "neg" : "";

        const cv = $("sessionChart");
        const ctx = cv.getContext("2d");
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (pts.length < 2) return;
        const min = Math.min.apply(null, pts);
        const max = Math.max.apply(null, pts);
        const span = max - min || 1;
        ctx.strokeStyle = net >= 0 ? "#2a7a2a" : "#b33";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = 2 + (i / (pts.length - 1)) * (cv.width - 4);
            const y = cv.height - 3 - ((p - min) / span) * (cv.height - 6);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        });
        ctx.stroke();
    }

    $("sessionReset").addEventListener("click", () => {
        const fresh = { startedAt: Date.now(), points: [] };
        chrome.storage.local.set({ [SESSION_KEY]: fresh }, () => renderSession(fresh));
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
