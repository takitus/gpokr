(function () {
    "use strict";

    const EMOTES = [
        // general reactions
        "🙂","🙁","😀","😅","😂","🤣","😉","😡","😭","😎","😍","🤔","🫡","👋","👍","👎","🔥","💩","👏","🤞","🍻","💀","🤑","🤫","👀","🙄",
        // poker flavor: cards & suits, chips & money, luck, and table reactions
        "🃏","♠️","♥️","♦️","♣️","💰","💵","💸","🚽","🗑️","🎣","🚤","⌛️","🎰","🎲","🏆","👑","🎁","🍀","🥶","🤯","🤡",
    ];

    const DISPLAY_MS = 2500;
    const HAND_MS = 6000;

    // Settings (persisted in chrome.storage.local; live-updated from the popup)
    let LOCAL_TEST = false;
    let SHARE_HAND = false;
    let SHOW_ODDS = false;
    let SHOW_STATS = false;
    let HOTKEYS = false;
    let DARK_MODE = false;
    let SHOW_TESTER = false;      // interaction-tester panel: scripted-throw builder (opt-in dev tool)
    let CELEBRATIONS = true;      // celebrate/dance: opt-OUT, and it silences other players' too
    let MUTE_CHAT = true;         // whether the mute list is enforced (the list itself persists)
    let testerPos = null;         // dragged position of the tester panel (persisted as settings.testerPos)
    let testerHeight = 0;         // dragged height, 0 = size to content (settings.testerHeight)
    let testerPause = 100;        // default gap after each new throw (settings.testerPause)
    let testerDock = false;       // docked to the left of the table, mirroring the right rail (settings.testerDock)
    let SHOW_BET_BUTTONS = true; // bet-size columns default on (opt-out, unlike the rest)
    let HAND_SUMMARY = true;     // end-of-hand recap panel in the log (opt-out)
    let FOUR_COLOR = false;      // blue diamonds / green clubs, for color-blind players (opt-in)
    let CARD_BACK = "";          // which bundled card back to use; "" = the site's own
    let RIVER_LAB = false;       // hold the river on the felt and let it be dragged round (dev tool)
    // The inspector's button is off for release builds: it is authoring gear, not
    // a player feature, and it parks a river on the felt until you turn it off.
    // The tool itself still works — flip settings.riverLab in extension storage —
    // so flip this back to true when the river needs looking at again.
    const RIVER_LAB_BTN = false;
    let TABLE_3D = false;        // replace the flat felt with a live 3D render (opt-in)
    let TABLE3D_FELT_ZOOM = 0.5, TABLE3D_LEATHER_ZOOM = 10; // texture zoom (tools editor)
    let TABLE3D_FELT_DEPTH = 0, TABLE3D_LEATHER_DEPTH = 0.1; // relief depth (tools editor)
    let TABLE3D_FELT_COLOR = "#2f6360", TABLE3D_LEATHER_COLOR = "#1d1a16"; // tints (tools editor)
    let TABLE3D_LOGO_OPACITY = 0.2; // felt-center watermark opacity (tools editor)
    // Surround = what shows outside the rail. "" means "follow the page's own felt
    // art", which table3d samples — the right default in BOTH themes, since dark
    // mode swaps in our dark table.png and light mode keeps the site's pale jpg.
    // A picked color overrides it.
    let TABLE3D_BG_COLOR = "";
    let TABLE3D_BACKDROP = "";   // "" = no floor, just the flat surround color
    let TABLE3D_SEATS = "";      // "" = nothing around the table; "stool" or "chair"
    // Single source of truth for the 3D-table editor defaults (used by
    // applySettings' fallbacks and the "Reset to defaults" button).
    const TABLE3D_DEFAULTS = {
        table3dFeltColor: "#2f6360", table3dFeltZoom: 0.5, table3dFeltDepth: 0,
        table3dLeatherColor: "#1d1a16", table3dLeatherZoom: 10, table3dLeatherDepth: 0.1,
        table3dLogoOpacity: 0.2,
        table3dBgColor: "",   // "" = sampled from the page's art
        table3dBackdrop: "",  // "" = none; a floor style renders under the table
        table3dSeats: "",     // "" = none; a stool or a chair at every seat
    };
    // Floor styles table3d knows how to build. Kept here too so a value read
    // back from storage is checked against a list rather than trusted.
    const BACKDROP_STYLES = ["grain", "glow", "carpet", "clover", "deco", "wood"];
    const SEAT_STYLES = ["stool", "chair"];
    const clampZoom = (v, dflt) => { const n = parseFloat(v); return (isFinite(n) && n > 0) ? Math.min(10, Math.max(0.1, n)) : (dflt != null ? dflt : 1); };
    const clampDepth = (v, dflt) => { const n = parseFloat(v); return (isFinite(n) && n >= 0) ? Math.min(3, Math.max(0, n)) : dflt; };
    const clamp01 = (v, dflt) => { const n = parseFloat(v); return (isFinite(n) && n >= 0 && n <= 1) ? n : dflt; };
    const clampColor = (v, dflt) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : (dflt || "#2f6360");
    let COIN_TOSS = true;        // chip button in each seat's avatar corner (opt-out)
    // Per-player bet readout: swap each seat's "Level" stat for the total the
    // player has bet/raised (calls excluded) over their last BET_WINDOW hands.
    let BET_READOUT = true;      // opt-out, like the bet buttons
    let BET_WINDOW = 3;          // how many of the kept hands to SUM for display (1..BET_HISTORY_MAX)
    const BET_HISTORY_MAX = 20;  // per-player hands always kept in history (the display window can't exceed this)

    // User-defined bet-sizing buttons: multiplier × base ("blind"/"pot"), or
    // the "allin" base (full stack, multiplier ignored). Placed in the column
    // above or below the bet input per `pos`. List order = render order.
    const DEFAULT_BET_BTNS = [
        { mult: 1, base: "allin", pos: "top" },
        { mult: 3, base: "blind", pos: "top" },
        { mult: 2, base: "blind", pos: "top" },
        { mult: 0.5, base: "pot", pos: "bottom" },
        { mult: 0.67, base: "pot", pos: "bottom" },
        { mult: 1, base: "pot", pos: "bottom" },
    ];
    let BET_CONFIG = DEFAULT_BET_BTNS;

    // Quick-chat buttons under the chat input (right of "share hand"). The
    // defaults are built-in and can't be edited/removed; users add their own via
    // the editor modal (stored in settings.chatButtons). "[playername]" in a
    // template is replaced on click with the last player to leave/bust.
    // All buttons are seeded defaults the user can rename, reorder, or remove
    // entirely. Short `name`s keep long "[..]" templates from bloating the row.
    const DEFAULT_CHAT_BTNS = [
        { name: "gg*", text: "gg [playername]" },
        { name: "nh*", text: "nh [lastwinner]" },
        { name: "ty", text: "ty" },
        { name: "wp", text: "wp" },
    ];
    let CHAT_CONFIG = DEFAULT_CHAT_BTNS.map((b) => ({ ...b }));
    let lastDeparted = "";       // player who busted in the current/recent hand (for [playername])
    let departedAgeHands = 0;    // new hands elapsed since that bustout; expires it so gg never names a long-gone finisher
    let lastWinner = "";         // winner of the most recent hand (for [lastwinner])
    let lastWinnerLine = "";

    // Each button is { name, text }; the caption falls back to text when name is
    // blank. A non-array (never configured) seeds the removable defaults; an
    // explicit [] stays empty. Strings are tolerated (name defaults to the text).
    function sanitizeChatConfig(list) {
        if (!Array.isArray(list)) return DEFAULT_CHAT_BTNS.map((b) => ({ ...b }));
        return list
            .map((b) => (typeof b === "string" ? { name: "", text: b } : (b || {})))
            .map((b) => ({ name: (b.name || "").trim(), text: (b.text || "").trim() }))
            .filter((b) => b.text)
            .slice(0, 40);
    }

    // Defaults only when nothing was ever saved; an explicitly emptied list
    // stays empty. Bad entries are dropped. `mult` is ignored for the "allin"
    // base but always carried (default 1) so the editor can switch bases back.
    // Missing `pos` infers from base (pot->bottom, blind/allin->top).
    function sanitizeBetConfig(list) {
        if (!Array.isArray(list)) return DEFAULT_BET_BTNS;
        return list
            .filter((c) => c && (c.base === "allin" || c.base === "blind" || c.base === "pot"))
            .filter((c) => c.base === "allin" ||
                (typeof c.mult === "number" && isFinite(c.mult) && c.mult > 0))
            .map((c) => ({
                mult: (typeof c.mult === "number" && isFinite(c.mult) && c.mult > 0) ? c.mult : 1,
                base: c.base,
                pos: c.pos === "top" || c.pos === "bottom" ? c.pos
                    : (c.base === "pot" ? "bottom" : "top"),
            }));
    }

    const EXT_STORE = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
        ? chrome.storage.local : null;

    // Where this file was served from, captured while the script is still
    // executing (document.currentScript is only valid then). gpokr can host these
    // files itself and load them into the page — the "Takitus's gpokr tools"
    // checkbox in its Preferences dialog — in which case this is an absolute
    // https URL under tools.gpokr.com/<version>/ and we can resolve siblings
    // against it. Running as a content script there is no currentScript, so this
    // is "" and every use of it is skipped.
    const SELF_SRC = (document.currentScript && document.currentScript.src) || "";

    function applySettings(s) {
        LOCAL_TEST = !!(s && s.localTest);
        SHARE_HAND = !!(s && s.shareHand);
        SHOW_ODDS = !!(s && s.showOdds);
        const op = s && s.oddsPos;
        oddsPos = (op && typeof op.left === "number" && typeof op.top === "number")
            ? { left: op.left, top: op.top } : null;
        SHOW_STATS = !!(s && s.showStats);
        HOTKEYS = !!(s && s.hotkeys);
        DARK_MODE = !!(s && s.darkMode);
        document.documentElement.classList.toggle("gpe-dark", DARK_MODE);
        // Opt-out: only an explicit `false` turns the bet buttons off.
        const prevShowBet = SHOW_BET_BUTTONS;
        SHOW_BET_BUTTONS = !(s && s.showBetButtons === false);
        HAND_SUMMARY = !(s && s.handSummary === false); // opt-out
        FOUR_COLOR = !!(s && s.fourColor); // opt-in
        // Checked against the list rather than trusted: an unknown value would
        // point every back at a 404 and leave the seats blank.
        CARD_BACK = CARD_BACK_STYLES.indexOf(s && s.cardBack) >= 0 ? s.cardBack : "";
        RIVER_LAB = !!(s && s.riverLab); // opt-in dev tool
        syncRiverLab();
        updateRiverLabBtn();
        if (FOUR_COLOR) ensureSuitFilters(); // must exist before the class references it
        document.documentElement.classList.toggle("gpe-fourcolor", FOUR_COLOR);
        sweepCardImgs(); // apply to whatever is already on screen, not just the next change
        TABLE_3D = !!(s && s.table3d); // opt-in
        TABLE3D_FELT_ZOOM = clampZoom(s && s.table3dFeltZoom, TABLE3D_DEFAULTS.table3dFeltZoom);
        TABLE3D_LEATHER_ZOOM = clampZoom(s && s.table3dLeatherZoom, TABLE3D_DEFAULTS.table3dLeatherZoom);
        TABLE3D_FELT_DEPTH = clampDepth(s && s.table3dFeltDepth, TABLE3D_DEFAULTS.table3dFeltDepth);
        TABLE3D_LEATHER_DEPTH = clampDepth(s && s.table3dLeatherDepth, TABLE3D_DEFAULTS.table3dLeatherDepth);
        TABLE3D_FELT_COLOR = clampColor(s && s.table3dFeltColor, TABLE3D_DEFAULTS.table3dFeltColor);
        TABLE3D_LEATHER_COLOR = clampColor(s && s.table3dLeatherColor, TABLE3D_DEFAULTS.table3dLeatherColor);
        TABLE3D_LOGO_OPACITY = clamp01(s && s.table3dLogoOpacity, TABLE3D_DEFAULTS.table3dLogoOpacity);
        // Not clampColor: "" is meaningful here (follow the art), not a fallback.
        TABLE3D_BG_COLOR = (s && typeof s.table3dBgColor === "string" && /^(#[0-9a-fA-F]{6})?$/.test(s.table3dBgColor))
            ? s.table3dBgColor : TABLE3D_DEFAULTS.table3dBgColor;
        TABLE3D_BACKDROP = (s && BACKDROP_STYLES.indexOf(s.table3dBackdrop) >= 0)
            ? s.table3dBackdrop : TABLE3D_DEFAULTS.table3dBackdrop;
        // Seats started life as a stools-or-nothing checkbox; anyone who had it on
        // keeps their stools when the setting widens to a style.
        TABLE3D_SEATS = (s && SEAT_STYLES.indexOf(s.table3dSeats) >= 0) ? s.table3dSeats
            : ((s && s.table3dSeats == null && s.table3dStools) ? "stool" : TABLE3D_DEFAULTS.table3dSeats);
        applyTable3dSettings();
        syncTable3d(); // apply the 3D-table setting now (and the poll keeps it in sync)
        COIN_TOSS = !(s && s.coinToss === false); // opt-out
        updateInteractButtons(); // add/remove the per-seat buttons for the new value
        CELEBRATIONS = !(s && s.celebrations === false); // opt-out
        const wasMuting = MUTE_CHAT;
        MUTE_CHAT = !(s && s.muteChat === false);        // opt-out; the list survives either way
        if (MUTE_CHAT !== wasMuting) applyMuting();       // unmuting has to bring the lines back
        SHOW_TESTER = !!(s && s.showTester); // opt-in
        const th = parseInt(s && s.testerHeight, 10);
        testerHeight = (isFinite(th) && th >= 150) ? Math.min(th, 2000) : 0;
        applyTesterHeight(testerPanel, testerHeight);
        const tpos = s && s.testerPos;
        testerPos = (tpos && typeof tpos.left === "number" && typeof tpos.top === "number")
            ? { left: tpos.left, top: tpos.top } : null;
        const tp = parseInt(s && s.testerPause, 10);
        testerPause = PAUSE_CHOICES.indexOf(tp) >= 0 ? tp : 100;
        const wasDocked = testerDock;
        testerDock = !!(s && s.testerDock);
        if (testerDock !== wasDocked && testerPanel) placeTester(testerPanel); // docks or re-floats
        updateInteractTester(); // create/remove/reposition the tester panel for the new value
        const cfg = sanitizeBetConfig(s && s.betButtons);
        if (JSON.stringify(cfg) !== JSON.stringify(BET_CONFIG)) {
            BET_CONFIG = cfg;
            rebuildBetColumns();
        } else if (prevShowBet !== SHOW_BET_BUTTONS) {
            rebuildBetColumns(); // toggle flipped -> add or tear down the columns
        }
        // Opt-out: only an explicit `false` turns the bet readout off.
        BET_READOUT = !(s && s.betReadout === false);
        const bw = parseInt(s && s.betWindow, 10);
        BET_WINDOW = (isFinite(bw) && bw >= 1) ? Math.min(bw, BET_HISTORY_MAX) : 3;
        // If the editor is open, mirror external changes (e.g. from the popup);
        // the guard skips re-rendering for edits the modal itself just made.
        const editor = document.getElementById("gpe-bet-editor");
        if (editor && editor.style.display === "flex" &&
            JSON.stringify(cfg) !== JSON.stringify(betEditorList)) {
            betEditorList = cfg.map((c) => ({ mult: c.mult, base: c.base, pos: c.pos }));
            renderBetEditorRows();
        }
        // Rail panels: which are collapsed, and whether Teams is shown at all.
        SHOW_TEAMS = !(s && s.showTeams === false); // opt-out
        const collapsed = s && s.sideCollapsed;
        SIDE_COLLAPSED = (collapsed && typeof collapsed === "object") ? Object.assign({}, collapsed) : {};
        applySideSections();
        syncProfileMenu();
        // Lobby sort/filter. Unknown sort keys fall back to the site's own order.
        LOBBY_SORT = LOBBY_SORTS.some(([k]) => k === (s && s.lobbySort)) ? s.lobbySort : "site";
        LOBBY_TIERS = Array.isArray(s && s.lobbyTiers)
            ? s.lobbyTiers.filter((t) => typeof t === "string") : [];
        LOBBY_MINE_ONLY = !!(s && s.lobbyMineOnly);
        const lobbyPanel = document.getElementById("gpe-lobby-panel");
        if (lobbyPanel) lobbyPanel._gpeKey = "";
        renderLobbyFilters();
        applyLobbyView();
        const chatCfg = sanitizeChatConfig(s && s.chatButtons);
        if (JSON.stringify(chatCfg) !== JSON.stringify(CHAT_CONFIG)) {
            CHAT_CONFIG = chatCfg;
            renderChatButtons();
        }
        syncShareToggleUI();
        syncSideOptionsUI();
    }

    // False once the extension is updated/reloaded while this tab stayed open:
    // the injected script is orphaned and every chrome.* call throws. DOM still
    // works, so we can at least tell the user why nothing is saving.
    function extAlive() {
        try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
        catch (e) { return false; }
    }

    function showReloadBanner() {
        if (document.getElementById("gpe-reload-banner")) return;
        const bar = document.createElement("div");
        bar.id = "gpe-reload-banner";
        bar.textContent = "GPokr Tools was updated — reload this page to keep saving changes. ";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Reload";
        btn.addEventListener("click", () => location.reload());
        bar.appendChild(btn);
        document.body.appendChild(bar);
    }

    // Persist a single setting without clobbering the others; the popup picks
    // the change up via chrome.storage.onChanged (and vice versa).
    function saveSetting(key, value) {
        if (EXT_STORE) {
            if (!extAlive()) { showReloadBanner(); return; } // orphaned tab: can't save
            try {
                EXT_STORE.get(["gpe_settings"], (res) => {
                    if (chrome.runtime.lastError) { showReloadBanner(); return; }
                    const s = res.gpe_settings || {};
                    s[key] = value;
                    try { EXT_STORE.set({ gpe_settings: s }); } catch (e) { showReloadBanner(); }
                });
            } catch (e) { showReloadBanner(); }
        } else {
            const legacyKeys = { localTest: "gpe_local_test", shareHand: "gpe_share_hand", showOdds: "gpe_show_odds" };
            try { localStorage.setItem(legacyKeys[key], value ? "1" : "0"); } catch (e) {}
        }
    }

    function legacyLocalStorageSettings() {
        const s = { localTest: false, shareHand: false, showOdds: false };
        try {
            s.localTest = localStorage.getItem("gpe_local_test") === "1";
            s.shareHand = localStorage.getItem("gpe_share_hand") === "1";
            s.showOdds = localStorage.getItem("gpe_show_odds") === "1";
        } catch (e) {}
        return s;
    }

    // Remove artifacts orphaned by a previous extension context: after an extension
    // reload the old context's timers die, leaving overlays frozen on screen and
    // buttons with dead listeners. They are re-created by this context as needed.
    document.querySelectorAll(
        ".gpe-hand-wrap, .gpe-emote-overlay, #gpe-odds-hud, #gpe-local-hand, #gpe-picker-btn, #gpe-picker-panel, .gpe-toggle, #gpe-chat-tools, .gpe-bet-col, .gpe-stat-badge, #gpe-hover-topper, #gpe-note-editor, #gpe-stat-tip, .gpe-side-tabs, .gpe-side-options, .gpe-side-roster, .gpe-side-bets, #gpe-bet-editor, #gpe-table3d-editor, #gpe-chat-editor, #gpe-mute-editor, #gpe-chat-tools-row, .gpe-log-cards, #gpe-chips-layer, #gpe-splash-btn, #gpe-personal-btn, #gpe-personal-panel, .gpe-dance, #gpe-coin-layer, .gpe-coin-btn, .gpe-interact-btn, #gpe-interact-panel, #gpe-interact-tester, #gpe-react-panel, .gpe-react-add, .gpe-react-bar"
    ).forEach((el) => el.remove());
    // ...and un-hide the site's panel content if the old context left a
    // non-site tab active (the class survives but the tab bar above is gone).
    document.querySelectorAll(".gpe-tools-active, .gpe-tab-tools, .gpe-tab-roster, .gpe-tab-bets").forEach((el) =>
        el.classList.remove("gpe-tools-active", "gpe-tab-tools", "gpe-tab-roster", "gpe-tab-bets"));

    // ---------- helpers: name -> avatar ----------
    function getSeatName(panel) {
        const link = panel.querySelector('a[href*="/profile/"]');
        if (link && link.textContent.trim()) return link.textContent.trim();
        const bold = panel.querySelector("b, strong");
        if (bold && bold.textContent.trim()) return bold.textContent.trim();
        return null;
    }

    function findAvatarByName(name) {
        let hidden = null;
        const panels = document.querySelectorAll('table[class*="iogc-PlayerPanel"]');
        for (const p of panels) {
            if (getSeatName(p) !== name) continue;
            const av = p.querySelector("img.iogc-PlayerPanel-avatar");
            if (!av) continue;
            if (av.getBoundingClientRect().width > 0) return av; // prefer the visible duplicate
            hidden = hidden || av;
        }
        return hidden;
    }

    // Dim folded players' avatars to 50% during a hand; restore everyone when the
    // hand ends. Re-applied each fast poll so it survives GWT re-renders. Uses the
    // accumulated hand scope so a fold trimmed from the visible log still counts.
    function applyFoldDimming() {
        const panels = document.querySelectorAll('table[class*="iogc-PlayerPanel"]');
        const setOpacity = (p, v) =>
            p.querySelectorAll("img.iogc-PlayerPanel-avatar").forEach((av) => { av.style.opacity = v; });
        if (handHasEnded()) { panels.forEach((p) => setOpacity(p, "")); return; }
        const me = getMyName();
        const folded = new Set();
        for (const line of fullHandScope()) {
            const m = line.match(/^(.+?) folds$/i);
            if (m) folded.add(m[1].trim());
        }
        // Never dim my own seat — only other folded players.
        panels.forEach((p) => { const n = getSeatName(p); setOpacity(p, (n && n !== me && folded.has(n)) ? "0.5" : ""); });
    }

    // Position a fixed overlay over a player's avatar; never modifies the avatar's DOM.
    // Takes a resolver, not an element: GWT recycles seat panels between hands, so a
    // captured element can drift to another player. Re-resolve by name on every tick.
    function anchorToAvatar(overlay, resolveAvatar, lifetimeMs) {
        function place() {
            const avatar = resolveAvatar();
            const r = avatar ? avatar.getBoundingClientRect() : null;
            if (!r || (r.width === 0 && r.height === 0)) { overlay.style.display = "none"; return; }
            overlay.style.display = "";
            overlay.style.left = r.left + r.width / 2 + "px";
            overlay.style.top = r.top + r.height / 2 + "px";
        }
        place();
        clearInterval(overlay._gpeReposition);
        overlay._gpeReposition = setInterval(place, 200);
        clearTimeout(overlay._gpeLife);
        overlay._gpeLife = setTimeout(() => clearInterval(overlay._gpeReposition), lifetimeMs + 400);
    }

    // ---------- emotes ----------
    const emoteOverlays = new Map(); // player name -> overlay
    function showEmoteForName(name, glyph) {
        if (!name) return;
        let overlay = emoteOverlays.get(name);
        if (!overlay || !overlay.isConnected) {
            overlay = document.createElement("div");
            overlay.className = "gpe-emote-overlay";
            overlay.style.position = "fixed";
            overlay.style.transform = "translate(-50%, -50%) scale(0.3)";
            document.body.appendChild(overlay);
            emoteOverlays.set(name, overlay);
        }
        overlay.textContent = glyph;
        anchorToAvatar(overlay, () => findAvatarByName(name), DISPLAY_MS);
        void overlay.offsetWidth;
        overlay.classList.add("gpe-show");
        overlay.style.transform = "translate(-50%, -50%) scale(1)";
        clearTimeout(overlay._gpeTimer);
        overlay._gpeTimer = setTimeout(() => {
            overlay.classList.remove("gpe-show");
            overlay.style.transform = "translate(-50%, -50%) scale(0.3)";
        }, DISPLAY_MS);
    }

    // ---------- interactions (seat-to-seat throws) ----------
    // An interact button in the corner of every other player's avatar, opening a
    // small menu of things to throw. Picking one POSTs to /table/interact, which
    // the server broadcasts to everyone at the table; the animation then plays
    // from the event coming back, so all of us — thrower included — see the same
    // throw at the same time. Cosmetic only: the endpoint never touches game
    // state, and the server drops anything from a watcher or a muted user.
    const interactButtons = new Map(); // player name -> button
    let coinLoad = null;

    const INTERACT_TYPE = "gpe.throw";  // our namespace on a shared endpoint
    const INTERACT_V = 1;               // payload schema version
    const INTERACT_COOLDOWN_MS = 2000;  // mirrors the server's interactionCooldownMs

    // Interaction categories. Everything unmarked is a THROW — aimed at another
    // seat, picked from the per-seat menu. A PERSONAL interaction is aimed at
    // nobody: it's fired on yourself from the toolbar (a cheer, a celebration) and
    // rides the same wire addressed to your own seat, so the whole table sees it.
    // Category is only a marker on the item; personal items are deliberately kept
    // OUT of INTERACT_ORDER (below), which is what keeps them out of the throw menu
    // and the creator. renderThrow reads it to pick the personal render path.
    const CAT_PERSONAL = "personal";

    // Receiver limits. The payload is whatever someone chose to POST — anyone can
    // curl this endpoint — so nothing here is trusted: a sequence is clamped into
    // these bounds or dropped, never taken at face value.
    // Rows, not objects: every throw row carries its own pause, so a full sequence
    // is 15 objects plus the 14 gaps between them. The receiver counts objects
    // (Q_MAX_ITEMS) — this only has to be roomy enough not to truncate a legal one.
    const Q_MAX_STEPS = 30;
    // One object per row, so a step is just its name: no count to multiply, which
    // is what made a short sequence able to put hundreds of objects in the air.
    // A ceiling on the whole sequence, because the cost of animating them lands on
    // everyone at the table, not just the sender. Pauses don't count — not objects.
    const Q_MAX_ITEMS = 15;
    const Q_MAX_WAIT_MS = 3000;  // per pause
    const Q_MAX_TOTAL_MS = 15000;
    const Q_MAX_PAYLOAD = 1024;  // the server's own cap; a longer one is a lie
    const Q_MAX_RUNNING = 3;     // sequences in flight, all senders

    // What can be thrown. Each item renders through the same (from, to, table,
    // opts) shape so the sequencer doesn't care which is which. Unknown keys
    // arriving from a newer client are skipped, not fatal — that's what lets an
    // item be added without coordinating a release.
    // The chip is hand-written: its art is minted by chips3d, not loaded from a
    // model. Everything else is a row in 3d/props3d.js's catalog — motion, model,
    // size, sound, cooldown — so adding an object touches that catalog and nothing
    // here. Merged at boot rather than duplicated.
    // The clap celebration's choreography, in one place because three things move
    // together on it: MOTIONS.clap in 3d/props3d.js opens and closes the gloves on
    // these numbers, standAndClap() below rises and sits on them, and the fade
    // below stops the applause on them. Change one and the rest drift off the beat.
    //
    // Declared HERE, above INTERACT_ITEMS, rather than next to standAndClap where
    // they are otherwise used: the item literal reads them while this file is still
    // being evaluated, and a const declared further down would still be in its
    // temporal dead zone — a ReferenceError that kills the whole content script.
    const CLAP_LEAD = 420;      // the rise, before the first clap
    const CLAP_COUNT = 8;
    const CLAP_PERIOD = 330;    // one clap per 330ms — brisk applause, ~3/sec
    const CLAP_TAIL = 620;      // sit back down

    const INTERACT_ITEMS = {
        chip: {
            label: "chip",
            glyph: "🪙",
            cooldownMs: INTERACT_COOLDOWN_MS,   // just the server's own limit
            launchSound: "fold",                 // the whoosh as it leaves
            sound: "bet",                        // ...and the site's own chip clatter on impact
            ensure: ensureCoin3d,
            throw: (from, to, table, opts) => window.GPE_COIN && GPE_COIN.toss(from, to, table, opts),
        },
        // A personal interaction (see CAT_PERSONAL): not thrown at anyone. Fired
        // from the toolbar, it plays our own cheer (assets/audio/hooray.mp3) and
        // pops a 🎉 over your seat for everyone at the table. Audio + emote only,
        // so there's no 3D renderer to load. Absent from INTERACT_ORDER on purpose.
        celebrate: {
            label: "celebrate",
            glyph: "🎉",
            emote: "🎉",                         // a 🎉 pops over the seat as it fires
            category: CAT_PERSONAL,
            cooldownMs: 5000,                    // a cheer, not a chant
            assetSound: "hooray",                // -> assets/audio/hooray.mp3
            flinch: false,
            ensure: ensureCoin3d,                // needs the chip renderer for the confetti
            // A burst of chips out of the celebrant's own avatar, up into the air
            // and back down onto the felt. from = their avatar rect, table = the felt.
            effect: (from, table) => window.GPE_COIN && GPE_COIN.confetti(from, table),
        },
        // Another personal interaction: the celebrant's avatar leaps into the
        // middle of the table and dances for a few seconds, then hops back. Pure
        // DOM/CSS (a clone of the seat's avatar image), so there's no renderer to
        // load and no emote — the dancing avatar is the whole show.
        dance: {
            label: "dance",
            glyph: "🕺",
            category: CAT_PERSONAL,
            cooldownMs: 6000,
            assetSound: "celebrate",             // -> assets/audio/celebrate.mp3
            flinch: false,
            ensure: () => Promise.resolve(true),
            effect: (from, table, ctx) => danceAvatar(ctx.avatar, from, table),
        },
        // The celebrant stands up out of their seat and gives the table a round of
        // applause: a pair of 3D gloves claps in front of the risen avatar, eight
        // times, to a matching track. The only celebration that needs BOTH paths —
        // the DOM avatar stunt and a props3d actor — so unlike dance and rail its
        // ensure() has to wait for a model, exactly as a throw does. If the glove
        // never loads the whole thing is skipped rather than playing half of it.
        clap: {
            label: "clap",
            glyph: "👏",
            category: CAT_PERSONAL,
            cooldownMs: 8000,
            assetSound: "golfclap",              // -> assets/audio/golfclap.mp3
            // The track is 6.6s against a 3.7s celebration, so it is faded out
            // rather than left to run: it holds while the hands are clapping, then
            // rides down across the sit-back, going silent as the avatar lands.
            assetFade: { holdMs: CLAP_LEAD + CLAP_COUNT * CLAP_PERIOD, fadeMs: CLAP_TAIL },
            flinch: false,
            ensure: () => ensureProps3d().then((ok) =>
                (ok && window.GPE_PROPS ? GPE_PROPS.ready("clap") : false)),
            effect: (from, table, ctx) => standAndClap(ctx.avatar, from, table),
        },
        // The pot pours: a river of water opens in the middle of the felt and runs
        // to whoever won the last hand, carrying dollar bills and chips down it
        // into their seat.
        //
        // The one interaction that is not about the player who fired it. Nothing
        // extra rides the wire for that: every client reads the same game log, so
        // each resolves the same winner locally (see riverToWinner) — which also
        // means it keeps working for a spectator, and for anyone who fires it on
        // someone else's behalf.
        river: {
            label: "river",
            glyph: "🌊",
            category: CAT_PERSONAL,
            cooldownMs: 2000,                   // the longest of them: it is a big one
            // Silent, deliberately: the only celebration without a track.
            flinch: false,
            // The river needs its own model; the beer bobbing down it is a bonus,
            // so it is asked for but not waited on for permission to play — a
            // river with no bottles in it is still a river.
            ensure: () => ensureProps3d().then((ok) => {
                if (!ok || !window.GPE_PROPS) return false;
                return GPE_PROPS.ready("river").then((r) =>
                    (r ? GPE_PROPS.ready("beer").then(() => true) : false));
            }),
            effect: (from, table) => riverToWinner(from, table),
        },
        // The celebrant's avatar hops up onto the rail and grinds a lap around the
        // table's oval edge before dropping back into its seat. DOM/CSS only.
        rail: {
            label: "rail slide",
            glyph: "🛹",
            category: CAT_PERSONAL,
            cooldownMs: 6000,
            assetSound: "railslide",             // -> assets/audio/railslide.mp3
            flinch: false,
            ensure: () => Promise.resolve(true),
            effect: (from, table, ctx) => railSlideAvatar(ctx.avatar, from, table),
        },
    };
    let INTERACT_ORDER = ["chip"];   // THROW-menu order; personal items are excluded

    // Fold the props catalog in. Called on boot and again if props3d shows up late
    // (the site build fetches it), so the menu grows as soon as it can.
    function syncInteractCatalog() {
        const props = window.GPE_PROPS;
        if (!props || !props.catalog) return false;
        let added = false;
        for (const key of props.order) {
            if (INTERACT_ITEMS[key]) continue;
            const spec = props.catalog[key];
            if (!spec) continue;
            INTERACT_ITEMS[key] = {
                label: spec.label || key,
                glyph: spec.glyph || "•",
                cooldownMs: spec.cooldownMs || INTERACT_COOLDOWN_MS,
                sound: spec.sound || null,
                launchSound: spec.launchSound || null,
                // flinch defaults true, as it did before: a thrown thing shakes the
                // avatar unless the object says otherwise.
                flinch: spec.flinch !== false,
                ensure: () => ensureProps3d().then((ok) => (ok ? props.ready(key) : false)),
                throw: (from, to, table, opts) =>
                    window.GPE_PROPS && GPE_PROPS.toss(key, from, to, table, opts),
            };
            if (INTERACT_ORDER.indexOf(key) < 0) INTERACT_ORDER.push(key);
            added = true;
        }
        return added;
    }

    // The renderer lives in three extra files (vendor/three.iife.js, 3d/chips3d.js
    // for the chip artwork, and 3d/coin3d.js). As an extension all three are
    // declared as content scripts, so window.GPE_COIN already exists by the time
    // this runs; when gpokr hosts the tools itself its loader only fetches the
    // core files, so pull whichever are missing from wherever this file came
    // from (same trick as the chip portal).
    function ensureCoin3d() {
        if (window.GPE_COIN) return Promise.resolve(true);
        if (!SELF_SRC) return Promise.resolve(false);
        if (!coinLoad) {
            const base = SELF_SRC.replace(/[^/]*$/, "");
            const three = window.THREE ? Promise.resolve() : loadScript(base + "vendor/three.iife.js");
            coinLoad = three
                .then(() => (window.GPE_CHIPS ? null : loadScript(base + "3d/chips3d.js")))
                .then(() => loadScript(base + "3d/coin3d.js"))
                .then(() => !!window.GPE_COIN)
                .catch((err) => {
                    console.warn("[gpe] chip toss unavailable — could not load " + err.message);
                    coinLoad = null;
                    return false;
                });
        }
        return coinLoad;
    }

    // props3d.js is two things at once: a ~8KB catalog (names, glyphs, sounds,
    // cooldowns) and the renderer that draws from it. The catalog is needed long
    // before anything is drawn — the menu lists from it, and the RECEIVER checks
    // incoming item names against it, so a build without the catalog silently drops
    // every throw that isn't a chip. As an extension it's a content script and is
    // simply there; in the site build it has to be fetched, and nothing else would
    // ever fetch it: the only callers of ensureProps3d() are the catalog's own
    // entries, so an empty catalog stayed empty forever and the menu never grew
    // past "chip".
    //
    // Nothing in props3d.js touches THREE or coin3d at load time (both are read
    // inside its functions), so the catalog can be pulled on its own and the heavy
    // chain — vendor/three.iife.js and the renderers, ~800KB — stays deferred until
    // something is actually thrown.
    let catalogLoad = null;
    function ensurePropsCatalog() {
        if (window.GPE_PROPS) return Promise.resolve(true);
        if (!SELF_SRC) return Promise.resolve(false);   // extension: it is a content script
        if (!catalogLoad) {
            const base = SELF_SRC.replace(/[^/]*$/, "");
            catalogLoad = loadScript(base + "3d/props3d.js")
                .then(() => {
                    if (!window.GPE_PROPS) return false;
                    if (syncInteractCatalog()) updateInteractButtons();   // the menu just grew
                    return true;
                })
                .catch((err) => {
                    console.warn("[gpe] interaction catalog unavailable — could not load " + err.message);
                    catalogLoad = null;
                    return false;
                });
        }
        return catalogLoad;
    }

    // One loader for every model-based object: props3d owns the catalog, so this
    // no longer grows by a function per item. It rides on coin3d (registering
    // projectiles, borrowing the layer and clock), so that has to be up first.
    let propsLoad = null;
    function ensureProps3d() {
        // BOTH, not just the catalog: with only props3d loaded (the site build
        // fetches it at boot for the item list) an early return here would report
        // ready and then draw nothing, warning "THREE is not loaded" per throw.
        if (window.GPE_PROPS && window.GPE_COIN) return Promise.resolve(true);
        if (!propsLoad) {
            propsLoad = ensureCoin3d()
                .then((ok) => {
                    if (!ok) return false;
                    if (window.GPE_PROPS) return true;
                    // Through the same loader, so a throw during the boot fetch joins
                    // it rather than pulling props3d a second time (which would
                    // re-register every projectile with coin3d).
                    return ensurePropsCatalog();
                })
                .then((ok) => { if (ok) syncInteractCatalog(); return ok; })
                .catch(() => { propsLoad = null; return false; });
        }
        return propsLoad;
    }

    // An element's rect, or null when it isn't laid out (GWT keeps hidden
    // duplicates of the seat panels around).
    function liveRect(el) {
        const r = el && el.getBoundingClientRect();
        return r && r.width > 0 ? r : null;
    }

    // The site's own chip sound. Its GWT module loads sounds (gwt-voices) from
    // /<module>/sound/<name>.mp3 — the set is bet, slide_chips, shuffle_deck,
    // check and fold — and "bet" is the plain chip clatter it plays when chips
    // go in. Reusing it means the toss sounds like the rest of the table instead
    // of shipping a second, slightly-different chip noise. Same origin as the
    // page, so this is just a media element, nothing is fetched cross-site.
    // The site's own sound set, so an interaction sounds like the rest of the table
    // instead of shipping our own audio. Its GWT module loads these from
    // /<module>/sound/<name>.mp3 — bet, slide_chips, shuffle_deck, check, fold.
    // Which one an object uses is a property of the OBJECT, not of its animation: a
    // bone and a chip can share the throw and still land differently.
    const SOUND_BASE = "/gpokr2/sound/";
    const SOUND_VOICES = 4;      // overlapping plays before it starts reusing
    const SOUND_NAMES = ["bet", "check", "fold"];   // warmed at boot
    const soundPool = Object.create(null);          // name -> { els, next }

    // A POOL of preloaded elements per sound, rather than cloneNode() per play.
    // cloneNode copies the src but not the decoded audio, so every play used to
    // re-load and re-decode before making a sound — which is why a launch sound
    // fired at the same instant as the animation still arrived noticeably late.
    // These are loaded once and rewound on reuse, so play() starts immediately.
    // Several voices because two objects landing together must not cut each other
    // off: one element can only be at one position at a time.
    function soundVoices(name) {
        let pool = soundPool[name];
        if (!pool) {
            const els = [];
            for (let i = 0; i < SOUND_VOICES; i++) {
                const el = new Audio(SOUND_BASE + name + ".mp3");
                el.preload = "auto";
                el.volume = 0.55;
                try { el.load(); } catch (e) {}   // decode now, not at play time
                els.push(el);
            }
            pool = soundPool[name] = { els: els, next: 0 };
        }
        return pool;
    }

    function playSound(name) {
        if (!name) return;
        try {
            const pool = soundVoices(name);
            const el = pool.els[pool.next];
            pool.next = (pool.next + 1) % pool.els.length;
            el.currentTime = 0;                    // rewind rather than reload
            const p = el.play();
            if (p && p.catch) p.catch(() => {});   // autoplay policy / offline: stay quiet
        } catch (e) {}
    }

    // Our own bundled audio (assets/audio/<name>.mp3), for interactions the site's
    // sound set doesn't cover — a celebration cheer, say. Resolved the same two ways
    // as every other bundled file: relative to this script when gpokr hosts the
    // tools itself, and chrome.runtime.getURL as an extension (where content.js is a
    // content script with no currentScript, so SELF_SRC is empty). assets/* is
    // already web-accessible in the manifest, so no manifest change is needed.
    const ASSET_SOUND_NAMES = ["hooray", "celebrate", "railslide", "golfclap"];   // warmed at boot, like SOUND_NAMES
    const assetSoundPool = Object.create(null);
    function assetAudioUrl(name) {
        const path = "assets/audio/" + name + ".mp3";
        if (SELF_SRC) return SELF_SRC.replace(/[^/]*$/, "") + path;
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    // A hair louder than the table sounds — a cheer is meant to carry.
    const ASSET_VOLUME = 0.7;

    // A voice pool for our own audio, mirroring soundVoices (preload + rewind so a
    // cue fires on time; several voices so overlapping plays don't cut each other
    // off).
    function assetVoices(name) {
        let pool = assetSoundPool[name];
        if (!pool) {
            const url = assetAudioUrl(name);
            const els = [];
            for (let i = 0; i < SOUND_VOICES; i++) {
                const el = new Audio(url || "");
                el.preload = "auto";
                el.volume = ASSET_VOLUME;
                try { el.load(); } catch (e) {}
                els.push(el);
            }
            pool = assetSoundPool[name] = { els: els, next: 0 };
        }
        return pool;
    }

    // Ride one voice's volume down and stop it. For tracks that outlast the
    // animation they belong to: a found recording is whatever length it is, and
    // letting it run leaves the sound playing over a seat that has gone still.
    //
    // Each ramp stamps the element with a token. A replay on the same voice bumps
    // the token, which abandons any ramp still running on it — without that, the
    // old ramp would fade out the NEW play a moment after it started, and restore
    // the volume behind its back.
    const FADE_STEP_MS = 40;
    function fadeAssetVoice(el, holdMs, fadeMs) {
        const token = (el.gpeFadeToken || 0) + 1;
        el.gpeFadeToken = token;
        setTimeout(() => {
            if (el.gpeFadeToken !== token) return;
            let left = fadeMs;
            const tick = setInterval(() => {
                if (el.gpeFadeToken !== token) { clearInterval(tick); return; }
                left -= FADE_STEP_MS;
                if (left > 0) { el.volume = ASSET_VOLUME * (left / fadeMs); return; }
                clearInterval(tick);
                try { el.pause(); } catch (e) {}
                el.volume = ASSET_VOLUME;      // hand it back ready for the next play
            }, FADE_STEP_MS);
        }, holdMs);
    }

    // fade: { holdMs, fadeMs } to stop the track early, or omitted to let it run.
    function playAssetSound(name, fade) {
        if (!name) return;
        try {
            const pool = assetVoices(name);
            const el = pool.els[pool.next];
            pool.next = (pool.next + 1) % pool.els.length;
            el.gpeFadeToken = (el.gpeFadeToken || 0) + 1;   // drop any ramp mid-flight
            el.volume = ASSET_VOLUME;              // a cut-short play must not stay quiet
            el.currentTime = 0;                    // rewind rather than reload
            const p = el.play();
            if (p && p.catch) p.catch(() => {});   // autoplay policy / offline: stay quiet
            if (fade && fade.fadeMs > 0) fadeAssetVoice(el, fade.holdMs, fade.fadeMs);
        } catch (e) {}
    }

    // Decode them up front so the first throw of a session isn't the slow one.
    function warmSounds() {
        for (const n of SOUND_NAMES) { try { soundVoices(n); } catch (e) {} }
        for (const n of ASSET_SOUND_NAMES) { try { assetVoices(n); } catch (e) {} }
    }

    // Everything is re-resolved at throw time rather than captured earlier: seats
    // are recycled between hands, and a throw only needs to be right for the
    // second it's in the air.
    function renderThrow(itemKey, fromName, toName, denom) {
        // Nothing animates in a hidden tab, so nothing may START in one. The
        // renderers drive off requestAnimationFrame, which the browser PAUSES while
        // the tab is in the background: the loop stops stepping, but events keep
        // arriving, so objects pile into the scene motionless and then all play at
        // once the moment you switch back. Dropping is right rather than deferring —
        // an interaction is a live moment between two players, and replaying five
        // minutes of them on return is worse than having missed them.
        //
        // Every animated interaction funnels through here — inbound event, local
        // echo, and any future game-driven script — so this is the gate for all of
        // them, not just chips. It sits above playSound too: hearing throws you
        // can't see would be its own bug.
        if (document.hidden) return Promise.resolve(false);
        const item = INTERACT_ITEMS[itemKey];
        if (!item) return Promise.resolve(false); // newer client threw something we don't have
        // Personal interactions (celebrate, ...) aren't thrown at a seat — from and
        // to are the same player. They play a cheer and pop an emote over that
        // player's avatar, skipping the from/to/table flight path entirely. Still
        // funnelled through here, so they inherit the hidden-tab gate above.
        if (item.category === CAT_PERSONAL) {
            // Opting out is both halves: no buttons for you, and nobody else's
            // confetti or dancing avatar plays on your screen either. (Throws are a
            // separate opt-out — "interactions" — so turning celebrations off
            // doesn't cost you the chip a friend just threw.)
            if (!CELEBRATIONS) return Promise.resolve(false);
            // Same rule applied to what ARRIVES, not just what we send: an older
            // build (or a hand-rolled POST) mid-hand would otherwise put confetti
            // over the board of a table that's still playing.
            if (!celebrationsAllowed()) return Promise.resolve(false);
            return item.ensure().then((ok) => {
                if (!ok) return false;
                playAssetSound(item.assetSound, item.assetFade);
                if (item.emote) showEmoteForName(toName, item.emote);
                // The visual acts on the celebrant's OWN avatar (from === to): a
                // burst out of it, the avatar itself leaping up to dance, etc.
                if (item.effect) {
                    const avatar = findAvatarByName(toName);
                    const from = liveRect(avatar);
                    const table = liveRect(document.querySelector(".iogc-GameWindow-table"));
                    if (from) item.effect(from, table, { name: toName, avatar });
                }
                return true;
            });
        }
        return item.ensure().then((ok) => {
            if (!ok) return false;
            // First thing once the renderer is ready — ahead of the avatar/table
            // lookups below, so the whoosh leads the animation rather than trailing it.
            playSound(item.launchSound);
            const target = findAvatarByName(toName);
            const to = liveRect(target);
            if (!to) return false; // target left the table mid-sequence
            const from = fromName ? liveRect(findAvatarByName(fromName)) : null; // null -> from the near rail
            const table = liveRect(document.querySelector(".iogc-GameWindow-table"));
            // Two moments, two sounds, both per object: launchSound (played above, as
            // the step begins) and `sound` on impact. Either may be omitted.
            // onHit is the chip striking someone; onArrive is the beer reaching
            // the rail. Same callback either way, but an item can opt out of the
            // recoil and the clatter — a beer sliding over is a friendly gesture,
            // not a hit, so it lands quietly and just sits there.
            const landed = () => {
                if (item.flinch !== false) flinchAvatar(target);
                playSound(item.sound);   // per object: a bone should not clatter like a chip
            };
            return !!item.throw(from, to, table, {
                denom: denom,
                onHit: landed,
                onArrive: landed,
                // The avatar ELEMENT, not just its rect: the life ring passes
                // behind the player, which it does by copying their portrait over
                // the props canvas (props3d's avatarOccluder). A rect cannot
                // stand in for it — gpokr's portraits are letterboxed inside
                // boxes that differ seat to seat, so the visible edge is not the
                // element's edge. Every other item ignores it.
                avatar: target,
            });
        });
    }

    // ---------- interactions: the wire ----------
    // Small seeded PRNG (mulberry32). The seed travels in the payload so every
    // viewer picks the same chip colors for the same throw instead of each
    // rolling its own. In-flight jitter stays local on purpose — matching spin
    // and scatter frame-for-frame would mean threading this through the
    // renderer's animation loop, for a difference nobody can see.
    function seededRand(seed) {
        let a = (seed | 0) || 1;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Send an arbitrary sequence, not just one item: this is the seam the "game
    // events fire scripted interactions" idea plugs into later, and the menu is
    // simply its simplest caller. One POST per sequence, never one per item —
    // the server's 2s cooldown would silently swallow everything after the first.
    function sendInteraction(targetName, steps) {
        const toUserId = userIdForName(targetName);
        if (!toUserId) return Promise.resolve(false); // no profile link -> no id to aim at
        const q = [];
        let items = 0;
        for (const step of steps || []) {
            if (!Array.isArray(step) || !step.length) continue;
            const name = String(step[0]);
            if (name === "wait") {
                q.push([name, step[1] | 0]);
            } else {
                // Same ceiling the receiver enforces, so we never send objects that
                // would simply be discarded on arrival.
                if (items >= Q_MAX_ITEMS) break;
                items += 1;
                q.push([name]);   // no count: one row is one object
            }
            if (q.length >= Q_MAX_STEPS) break;
        }
        if (!q.length) return Promise.resolve(false);
        const payload = JSON.stringify({
            v: INTERACT_V,
            s: (Math.random() * 0x7FFFFFFF) | 0,
            q: q,
        });
        if (payload.length > Q_MAX_PAYLOAD) return Promise.resolve(false);
        return sendViaBridge(toUserId, payload);
    }

    // The POST has to carry the session's IOGC-Client-ID header or the server
    // accepts it and silently drops it — a 204 that does nothing, which is exactly
    // how this cost an afternoon. That id only exists on the table socket, i.e. in
    // the page's world, and bridge/ws-monitor.js deliberately keeps it there rather
    // than posting it over to us: it is the capability that lets a call act on this
    // seat, so leaking it into a page-readable channel would let any ad script on
    // gpokr.com fold the user's hand. So we don't ask for the credential, we ask the
    // bridge to make the one cosmetic call.
    // Same narrow channel as a throw, different command: the bridge owns the
    // IOGC-Client-ID header and we never see it.
    function sendReactionViaBridge(messageId, reaction) {
        return bridgeSend({ kind: "react", messageId: messageId, reaction: reaction });
    }

    // One request/reply exchange with the bridge, shared by every command it
    // accepts. Resolves false rather than hanging if no bridge answers — the site
    // build may have loaded too late to hook anything, and a caller waiting on a
    // promise that never settles is the failure mode that already cost us a
    // permanently muted player once.
    let sendSeq = 0;
    function bridgeSend(cmd) {
        return new Promise((resolve) => {
            const id = ++sendSeq;
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                window.removeEventListener("message", onReply);
                clearTimeout(timer);
                resolve(ok);
            };
            const onReply = (e) => {
                if (e.origin !== location.origin) return;
                const d = e.data;
                if (!d || d.__gpe !== "gpe-sent" || d.id !== id) return;
                if (!d.ok && d.why) console.warn("[gpe] " + cmd.kind + " not sent — " + d.why);
                finish(!!d.ok);
            };
            window.addEventListener("message", onReply);
            const timer = setTimeout(() => finish(false), 4000);
            window.postMessage(Object.assign({ __gpe: "gpe-send", id: id }, cmd), location.origin);
        });
    }

    function sendViaBridge(toUserId, payload) {
        return bridgeSend({ kind: "interact", type: INTERACT_TYPE, toUserId: toUserId, payload: payload });
    }

    // Name -> numeric user id, off the profile links the page already shows
    // (seat panels, leaderboard...). profileLinks() is the same harvest the
    // roster uses; only seated players can be targeted anyway, and every seat
    // panel carries a profile link.
    function userIdForName(name) {
        const href = name ? profileLinks()[name] : null;
        const m = href && href.match(/\/profile\/(\d+)/);
        return m ? Number(m[1]) : 0;
    }

    function nameForUserId(id) {
        if (!id) return null;
        const links = profileLinks();
        for (const name of Object.keys(links)) {
            const m = links[name].match(/\/profile\/(\d+)/);
            if (m && Number(m[1]) === Number(id)) return name;
        }
        return null;
    }

    // Validate a received payload into a sequence we're willing to play, or null.
    // Written as "prove it's acceptable" rather than "reject what looks bad", so
    // a shape nobody anticipated fails closed.
    function parseInteractionPayload(raw) {
        if (typeof raw !== "string" || !raw || raw.length > Q_MAX_PAYLOAD) return null;
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { return null; }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
        if ((obj.v | 0) !== INTERACT_V) return null; // unknown schema: leave it alone
        if (!Array.isArray(obj.q) || !obj.q.length) return null;
        const q = [];
        let total = 0;   // ms of pause
        let items = 0;   // objects thrown
        for (const step of obj.q.slice(0, Q_MAX_STEPS)) {
            if (!Array.isArray(step) || typeof step[0] !== "string") continue;
            const name = step[0];
            if (name === "wait") {
                const ms = Math.max(0, Math.min(Q_MAX_WAIT_MS, step[1] | 0));
                if (!ms) continue;
                if (total + ms > Q_MAX_TOTAL_MS) break;
                total += ms;
                q.push(["wait", ms]);
                continue;
            }
            if (!INTERACT_ITEMS[name]) continue; // item from a newer client: skip, keep the rest
            if (items >= Q_MAX_ITEMS) break;     // sequence is full: ignore the rest
            // Any count that arrives is deliberately ignored — one row, one object.
            // A client still sending [name, 5] gets one, not five.
            items += 1;
            q.push([name]);
        }
        return q.length ? { seed: obj.s | 0, q: q } : null;
    }

    // One sequence per sender at a time, and a hard ceiling overall: a spammer
    // (or a bug in another client) can't stack animations without bound.
    const runningInteractions = new Map(); // fromUserId -> true

    function playInteraction(ev) {
        if (!COIN_TOSS) return; // receiving is part of the same opt-out as sending
        if (!ev || ev.type !== INTERACT_TYPE) return;
        if (document.hidden) return;   // renderThrow would refuse anyway; skip the bookkeeping
        const fromId = Number(ev.fromUserId) || 0;
        if (!fromId) return;
        if (runningInteractions.has(fromId) || runningInteractions.size >= Q_MAX_RUNNING) return;
        const parsed = parseInteractionPayload(ev.payload);
        if (!parsed) return;
        const fromName = nameForUserId(fromId);
        const toName = nameForUserId(Number(ev.toUserId) || 0);
        if (!toName) return; // untargeted throws have nowhere to land yet
        const rand = seededRand(parsed.seed);
        const denoms = (window.GPE_CHIPS && GPE_CHIPS.art && GPE_CHIPS.art.types) || null;

        runningInteractions.set(fromId, true);
        let chain = Promise.resolve();
        // Re-checked per step, not just at the start: a 15 s sequence only has to be
        // a second in when you switch away. Once hidden, the rest is abandoned —
        // pauses included, so the sender's slot frees now instead of being held
        // while background-throttled timers (~1/s) walk out a timeline nobody sees.
        for (const [name, arg] of parsed.q) {
            if (name === "wait") {
                chain = chain.then(() => document.hidden
                    ? null
                    : new Promise((res) => setTimeout(res, arg)));
                continue;
            }
            chain = chain.then(() => {
                if (document.hidden) return false;
                const denom = denoms && denoms.length
                    ? denoms[Math.floor(rand() * denoms.length)].denom
                    : undefined;
                return renderThrow(name, fromName, toName, denom);
            });
        }
        // Release the sender's slot when the sequence finishes — but NEVER rely on
        // that alone. A renderer that hangs (a model load that neither resolves
        // nor rejects, say) would otherwise leave this entry set forever and
        // silently mute that player for the rest of the session, which is exactly
        // what happened the first time a beer went wrong: every later throw from
        // them, chips included, vanished with no error anywhere.
        // So a watchdog always clears it: the clamped duration plus enough margin
        // for the throws themselves.
        const release = () => runningInteractions.delete(fromId);
        let budget = 4000;
        for (const [name, arg] of parsed.q) budget += (name === "wait") ? arg : 900;
        const watchdog = setTimeout(release, Math.min(budget, Q_MAX_TOTAL_MS + 12000));
        chain.then(
            () => { clearTimeout(watchdog); release(); },
            () => { clearTimeout(watchdog); release(); }
        );
    }

    // Can we actually send? Only the bridge knows: the POST needs a header whose
    // value lives in the page's world (see sendViaBridge). Until it says yes, the
    // interact button stays hidden — offering a menu whose clicks silently do
    // nothing is the exact failure this feature kept tripping over while it was
    // being built. False in the site-hosted build, where we load too late to ever
    // see a session frame, and anywhere the page-world script didn't run.
    let canInteract = false;

    function probeBridge() {
        if (canInteract) return;
        try { window.postMessage({ __gpe: "gpe-probe" }, location.origin); } catch (e) {}
    }

    // The tap (bridge/ws-monitor.js) runs in the page's world and posts here.
    // Treat everything it sends as untrusted: same-origin page code — or an XSS
    // on the site — could forge these just as easily, so the origin and marker
    // checks only establish "this came from our own origin", and the payload
    // still goes through parseInteractionPayload's clamps.
    window.addEventListener("message", (e) => {
        if (e.origin !== location.origin) return;
        const d = e.data;
        if (!d) return;
        if (d.__gpe === "gpe-ready" && d.canSend) {
            if (!canInteract) {
                canInteract = true;
                updateInteractButtons();   // show them the moment sending is possible
            }
            return;
        }
        if (d.__gpe !== "gpe-ws" || !d.ev) return;
        if (d.ev.typeName === "InteractionEvent") playInteraction(d.ev);
        else if (d.ev.typeName === "ChatEvent") onChatEvent(d.ev);
    });

    // As an extension the tap is a document_start MAIN-world content script (it
    // has to beat the client's socket, measured opening ~55ms into page load). In
    // the site-hosted build there's no such hook, so pull it from alongside this
    // file and settle for whatever sockets open after it lands.
    let wsMonitorLoad = null;
    function ensureWsMonitor() {
        if (!SELF_SRC) return Promise.resolve(false); // extension: the manifest handled it
        if (!wsMonitorLoad) {
            const base = SELF_SRC.replace(/[^/]*$/, "");
            wsMonitorLoad = loadScript(base + "bridge/ws-monitor.js")
                .then(() => true)
                .catch(() => { wsMonitorLoad = null; return false; });
        }
        return wsMonitorLoad;
    }

    // A short recoil on the avatar the coin just hit. The class is removed
    // afterwards so a second hit replays the animation, and it's only ever a
    // class on the site's <img> — nothing in the panel is restructured.
    function flinchAvatar(av) {
        if (!av || !av.isConnected) return;
        av.classList.remove("gpe-coin-hit");
        void av.offsetWidth; // restart the animation
        av.classList.add("gpe-coin-hit");
        clearTimeout(av._gpeCoinHit);
        av._gpeCoinHit = setTimeout(() => av.classList.remove("gpe-coin-hit"), 460);
    }

    // The menu of things to throw: one shared panel, repositioned beside whichever
    // avatar you're pointing at. Opens on hover and STAYS open, so a handful of
    // chips is a handful of clicks rather than a hover-click-hover-click dance.
    // Built on the emote picker's shape (button + panel toggled with .gpe-open).
    let interactPanel = null;
    let closeTimer = 0;

    function interactMenu() {
        if (interactPanel && interactPanel.isConnected) return interactPanel;
        const panel = document.createElement("div");
        panel.id = "gpe-interact-panel";
        for (const key of INTERACT_ORDER) {
            const item = INTERACT_ITEMS[key];
            const b = document.createElement("button");
            b.type = "button";
            b.className = "gpe-interact-item";
            b.dataset.gpeItem = key;
            b.textContent = item.glyph + " " + item.label;
            // Deliberately does NOT close the panel: clicking five times sends five.
            b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (panel._gpeTarget) throwAt(panel._gpeTarget, key);
                syncMenuCooldowns();
            });
            panel.appendChild(b);
        }
        // Hovering the panel itself keeps it open — otherwise it would vanish the
        // moment the pointer left the avatar to reach it.
        panel.addEventListener("mouseenter", holdInteractMenu);
        panel.addEventListener("mouseleave", scheduleCloseInteractMenu);
        document.body.appendChild(panel);
        interactPanel = panel;
        return panel;
    }

    function openInteractMenu(name, btn) {
        const panel = interactMenu();
        holdInteractMenu();
        panel._gpeTarget = name;
        const br = btn.getBoundingClientRect();
        panel.style.left = br.left + "px";
        panel.style.top = (br.bottom + 4) + "px";
        panel.classList.add("gpe-open");
        // Keep it on screen when the seat is near an edge.
        const pr = panel.getBoundingClientRect();
        if (pr.right > window.innerWidth - 4) {
            panel.style.left = Math.max(4, window.innerWidth - pr.width - 4) + "px";
        }
        if (pr.bottom > window.innerHeight - 4) {
            panel.style.top = Math.max(4, br.top - pr.height - 4) + "px";
        }
        syncMenuCooldowns();
    }

    function holdInteractMenu() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
    }

    // A grace period, because the pointer has to cross a gap between the avatar
    // corner and the panel below it.
    function scheduleCloseInteractMenu() {
        holdInteractMenu();
        closeTimer = setTimeout(closeInteractMenu, 320);
    }

    function closeInteractMenu() {
        holdInteractMenu();
        if (interactPanel) interactPanel.classList.remove("gpe-open");
    }

    // Any click outside dismisses it, matching how the site's own popups behave.
    document.addEventListener("mousedown", (e) => {
        if (!interactPanel || !interactPanel.classList.contains("gpe-open")) return;
        if (interactPanel.contains(e.target) || (e.target.classList && e.target.classList.contains("gpe-interact-btn"))) return;
        closeInteractMenu();
    });

    // Same dismissal for the personal celebrations menu.
    document.addEventListener("mousedown", (e) => {
        if (!personalPanel || !personalPanel.classList.contains("gpe-open")) return;
        const trigger = document.getElementById("gpe-personal-btn");
        if (personalPanel.contains(e.target) || (trigger && trigger.contains(e.target))) return;
        closePersonalMenu();
    });

    // ---------- cooldowns ----------
    // Two rules, and both have to hold or the send is wasted:
    //   - the server's own per-user 2s window, which applies across items: a chip
    //     sent 1s after a beer is dropped on the floor, silently.
    //   - a per-item wait, so a beer isn't spammable the way a chip is.
    // Tracked per user rather than per target, because that's how the server
    // counts it — throwing at someone else doesn't reset anything.
    let lastSendAt = 0;
    const lastSendByItem = Object.create(null);

    function cooldownLeft(key) {
        const item = INTERACT_ITEMS[key];
        if (!item) return 0;
        const now = Date.now();
        const global = INTERACT_COOLDOWN_MS - (now - lastSendAt);
        const mine = (item.cooldownMs || 0) - (now - (lastSendByItem[key] || 0));
        return Math.max(0, global, mine);
    }

    // Repaint the open menu so a user can see what's still cooling rather than
    // clicking into a silent drop.
    function syncMenuCooldowns() {
        for (const panel of [interactPanel, personalPanel]) {
            if (!panel || !panel.classList.contains("gpe-open")) continue;
            for (const b of panel.querySelectorAll(".gpe-interact-item")) {
                const key = b.dataset.gpeItem;
                const item = INTERACT_ITEMS[key];
                if (!item) continue;
                const left = cooldownLeft(key);
                b.classList.toggle("gpe-interact-cool", left > 0);
                b.textContent = left > 0
                    ? item.glyph + " " + item.label + " " + Math.ceil(left / 1000) + "s"
                    : item.glyph + " " + item.label;
            }
        }
    }
    setInterval(syncMenuCooldowns, 250); // only touches the DOM while the panel is open

    // Nothing renders here: the throw appears when the event comes back, which is
    // also what makes a silently-dropped send (cooldown, muted, target stood up)
    // show honestly as nothing happening.
    function throwAt(name, key) {
        if (cooldownLeft(key) > 0) return;
        const now = Date.now();
        lastSendAt = now;
        lastSendByItem[key] = now;
        sendInteraction(name, [[key]]);
    }

    // Am I in a seat? The server refuses interactions from watchers, so a button
    // shown to one could only ever do nothing.
    function amSeated() {
        const me = getMyName();
        return !!me && seatedNames().has(me);
    }

    // Personal interactions ride the interaction wire, so they need the same things
    // a throw does: interactions not opted out, the bridge able to send, and a seat
    // (the server refuses interactions from watchers). Gates both the toolbar
    // button's visibility and the send itself.
    function canPersonal() { return COIN_TOSS && CELEBRATIONS && canInteract && amSeated(); }

    // Fire a personal interaction on MYSELF: same wire as throwAt, addressed to my
    // own seat, so the server broadcasts it and everyone — me included — sees it
    // play out over my avatar from the event coming back. A silent no-op while it's
    // cooling or when I can't send, exactly like a throw.
    function firePersonal(key) {
        if (!canPersonal() || cooldownLeft(key) > 0) return false;
        if (!celebrationsAllowed()) return false;   // the flop is out: not until this hand is done
        const me = getMyName();
        if (!me) return false;
        const now = Date.now();
        lastSendAt = now;
        lastSendByItem[key] = now;
        sendInteraction(me, [[key]]);
        return true;
    }

    // One pass: an interact button on the corner of each visible seat's avatar,
    // skipping my own. Same approach as the stats badges — fixed elements
    // positioned over the avatar rather than children of it, since GWT rebuilds
    // the seat panels whenever it likes.
    function updateInteractButtons() {
        const wanted = new Set();
        const me = getMyName();
        if (COIN_TOSS && canInteract && amSeated()) {
            for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
                const name = getSeatName(p);
                if (!name || name === me || wanted.has(name)) continue;
                const r = liveRect(p.querySelector("img.iogc-PlayerPanel-avatar"));
                if (!r) continue;
                wanted.add(name);
                let btn = interactButtons.get(name);
                if (!btn || !btn.isConnected) {
                    btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "gpe-interact-btn"; // no label: the chip IS the button
                    // Hover to open. Click also opens (touch, and anyone who
                    // clicks before the pointer settles) but never closes: the
                    // panel stays put so several throws are several clicks.
                    btn.addEventListener("mouseenter", () => openInteractMenu(name, btn));
                    btn.addEventListener("mouseleave", scheduleCloseInteractMenu);
                    btn.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation(); // don't trip the seat panel's own handlers
                        openInteractMenu(name, btn);
                    });
                    document.body.appendChild(btn);
                    interactButtons.set(name, btn);
                }
                btn.title = "throw something at " + displayName(name);
                // Top-right corner, half on and half off the avatar. Nudged just
                // inside the top edge so it clears the stats tab, which sits
                // flush above the avatar and spans its full width.
                btn.style.left = (r.right - 5) + "px";
                btn.style.top = (r.top + 7) + "px";
            }
        }
        for (const [name, el] of interactButtons) {
            if (!wanted.has(name)) {
                el.remove();
                interactButtons.delete(name);
                if (interactPanel && interactPanel._gpeTarget === name) closeInteractMenu();
            }
        }
    }

    // ---------- interaction tester (scripted-throw builder) ----------
    // A draggable panel for composing an arbitrary throw SEQUENCE and firing it at
    // a chosen seat — the manual counterpart to sendInteraction's "scripted
    // interactions" seam. Opt-in from the tools tab, because it's a dev/testing
    // aid rather than a table feature: it drives the exact same wire path a menu
    // click does, so whatever it builds is a real, everyone-sees-it throw.
    let testerPanel = null;
    let testerDrag = null;        // index being dragged while reordering steps
    let activeResize = null;      // in-progress vertical resize of a panel
    // The sequence being built, as ROWS: [ {item: "chip", pause: 500}, ... ]. A row
    // is one object plus the gap that follows it, which is how it reads on screen;
    // rowsToSteps() flattens it to the wire's [name] / ["wait", ms] pairs. Pauses
    // are no longer separate rows — they were always attached to a throw in
    // practice, and adding them by hand was two steps for one idea.
    let testerRows = [];
    // Offered pauses, shortest first — 100ms is the one that actually gets used, so
    // it's the default. Capped by the wire's own per-pause limit, so nothing here
    // can build a sequence the receiver would clamp.
    const PAUSE_CHOICES = [0, 100, 150, 250, 500, 750, 1000, 1500, 2000, 3000];
    // Compact on purpose: docked, the whole row lives in ~173px beside the object
    // name, and "500ms" was wide enough to truncate the thing being thrown.
    function pauseLabel(ms) { return !ms ? "—" : (ms < 1000 ? ms + "ms" : (ms / 1000) + "s"); }
    function buildPauseSelect(value, onChange) {
        const sel = document.createElement("select");
        sel.className = "gpe-tester-pause";
        sel.title = "pause after this throw";
        for (const ms of PAUSE_CHOICES) {
            const o = document.createElement("option");
            o.value = String(ms);
            o.textContent = pauseLabel(ms);
            if (ms === value) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener("change", () => onChange(clampInt(sel.value, 0, Q_MAX_WAIT_MS, 0)));
        return sel;
    }

    // Rows -> wire steps. The last row's pause is dropped: nothing follows it, and
    // a trailing wait would only hold the sender's slot after the last object lands.
    function rowsToSteps(rows) {
        const out = [];
        rows.forEach((r, i) => {
            out.push([r.item]);
            if (r.pause > 0 && i < rows.length - 1) out.push(["wait", r.pause]);
        });
        return out;
    }
    // What the receiver will actually wait through, for the status line and the cap.
    function rowsPauseTotal(rows) {
        let t = 0;
        rows.forEach((r, i) => { if (i < rows.length - 1) t += r.pause || 0; });
        return t;
    }

    // Clamp a form value to whole [lo, hi], falling back to dflt on garbage.
    function clampInt(v, lo, hi, dflt) {
        const n = parseInt(v, 10);
        if (!isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    // Generic drag: `handle` moves `el` (which must be position:fixed), persisting
    // the resting spot to settings[posKey]. The move/up listeners are global and
    // bound once (below), dispatching to whichever panel is mid-drag, so this
    // scales past one panel without stacking listeners — same lesson as the odds
    // HUD, generalised.
    let activeDrag = null; // { el, offX, offY, posKey, lastPos } while a drag is in progress
    // Vertical resize from a grabber along the panel's bottom edge. Same shape as
    // makeDraggable — arm on mousedown, track on the shared window listeners — so
    // there is one place where a pointer gesture on a panel is committed and saved.
    const TESTER_MIN_H = 150;

    // Height and the marker class travel together: the class is what lifts the step
    // list's content-sized max-height (see overlay.css), so setting one without the
    // other leaves the panel tall with the list still capped and dead space below.
    function applyTesterHeight(panel, h) {
        if (!panel) return;
        if (h) {
            panel.style.height = h + "px";
            panel.classList.add("gpe-tester-sized");
        } else {
            panel.style.height = "";
            panel.classList.remove("gpe-tester-sized");
        }
    }
    function makeVResizable(el, handle, sizeKey) {
        handle.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            const r = el.getBoundingClientRect();
            activeResize = { el, startY: e.clientY, startH: r.height, top: r.top, sizeKey, lastH: null };
            el.classList.add("gpe-resizing");
            e.preventDefault();
        });
    }

    function makeDraggable(el, handle, posKey) {
        handle.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            if (el.classList.contains("gpe-tester-docked")) return; // a rail doesn't move
            // A drag starts on the header's empty space, not on its buttons.
            if (e.target.closest("button, input, select, textarea")) return;
            const r = el.getBoundingClientRect();
            activeDrag = { el, offX: e.clientX - r.left, offY: e.clientY - r.top, posKey, lastPos: null };
            el.classList.add("gpe-dragging");
            e.preventDefault(); // no text selection while dragging
        });
    }
    window.addEventListener("mousemove", (e) => {
        if (activeResize) {
            const el = activeResize.el;
            // Bounded by the viewport below the panel's top, so it can never be
            // dragged taller than the screen it lives on.
            const max = Math.max(TESTER_MIN_H, window.innerHeight - activeResize.top - 8);
            const h = Math.min(max, Math.max(TESTER_MIN_H, activeResize.startH + (e.clientY - activeResize.startY)));
            applyTesterHeight(el, h);
            activeResize.lastH = h;
            return;
        }
        if (!activeDrag) return;
        const el = activeDrag.el;
        const p = clampToViewport(e.clientX - activeDrag.offX, e.clientY - activeDrag.offY,
            el.offsetWidth, el.offsetHeight);
        el.style.left = p.left + "px";
        el.style.top = p.top + "px";
        activeDrag.lastPos = p;
    });
    window.addEventListener("mouseup", () => {
        if (activeResize) {
            activeResize.el.classList.remove("gpe-resizing");
            if (activeResize.lastH && activeResize.sizeKey) saveSetting(activeResize.sizeKey, activeResize.lastH);
            activeResize = null;
            return;
        }
        if (!activeDrag) return;
        activeDrag.el.classList.remove("gpe-dragging");
        if (activeDrag.lastPos && activeDrag.posKey) saveSetting(activeDrag.posKey, activeDrag.lastPos);
        activeDrag = null;
    });

    // Idempotent: create/remove the panel to match the setting, then refresh the
    // parts that track the live table (target list, send-ability). Safe to call
    // from the 300ms poll.
    function updateInteractTester() {
        if (!SHOW_TESTER) {
            if (testerPanel) { testerPanel.remove(); testerPanel = null; }
            applyDockShift(0);   // closing the panel must give the page its centring back
            return;
        }
        if (!testerPanel || !testerPanel.isConnected) buildTester();
        // The table moves: window resize, the site's own panels growing, fullscreen.
        // Cheap enough to re-measure on the poll rather than guess at every cause.
        if (testerDock) applyTesterDock(testerPanel);
        syncTesterTargets();
        syncTesterStatus();
    }

    function buildTester() {
        const panel = document.createElement("div");
        panel.id = "gpe-interact-tester";
        testerPanel = panel;

        // Header doubles as the drag handle (cursor:move), with a close that just
        // flips the setting off — same as unticking the tools-tab option.
        const head = document.createElement("div");
        head.className = "gpe-tester-head";
        const title = document.createElement("span");
        title.className = "gpe-tester-title";
        title.textContent = "interaction creator";
        const dock = document.createElement("button");
        dock.type = "button";
        dock.className = "gpe-tester-dock";
        dock.textContent = "⇤";
        dock.title = "dock to the left of the table";
        dock.addEventListener("click", () => saveSetting("testerDock", !testerDock));
        const x = document.createElement("button");
        x.type = "button";
        x.className = "gpe-tester-x";
        x.textContent = "✕";
        x.title = "close (turns the option off)";
        x.addEventListener("click", () => saveSetting("showTester", false));
        head.appendChild(title);
        head.appendChild(dock);
        head.appendChild(x);
        panel.appendChild(head);

        // Who to throw at.
        const targetRow = document.createElement("div");
        targetRow.className = "gpe-tester-row";
        const tlabel = document.createElement("span");
        tlabel.className = "gpe-tester-label";
        tlabel.textContent = "Target";
        const target = document.createElement("select");
        target.className = "gpe-tester-target";
        target.addEventListener("change", syncTesterStatus);
        targetRow.appendChild(tlabel);
        targetRow.appendChild(target);
        panel.appendChild(targetRow);

        // The sequence being built.
        const list = document.createElement("div");
        list.className = "gpe-tester-steps";
        panel.appendChild(list);

        // Add-a-throw: the object, the pause that will follow it, and the button.
        // The pause here is the DEFAULT for new rows — set it once and every throw
        // added afterwards inherits it (each row can still be changed on its own).
        const throwRow = document.createElement("div");
        throwRow.className = "gpe-tester-row gpe-tester-addrow";
        const item = document.createElement("select");
        item.className = "gpe-tester-item";
        for (const key of INTERACT_ORDER) {
            const it = INTERACT_ITEMS[key];
            const o = document.createElement("option");
            o.value = key;
            o.textContent = it.glyph + " " + it.label;
            item.appendChild(o);
        }
        const defPause = buildPauseSelect(testerPause, (ms) => {
            testerPause = ms;
            saveSetting("testerPause", ms);   // the default persists, the rows keep their own
        });
        defPause.title = "default pause for each new throw";
        const addThrow = document.createElement("button");
        addThrow.type = "button";
        addThrow.className = "gpe-tester-add";
        addThrow.textContent = "+ add";
        addThrow.addEventListener("click", () => addTesterRow(item.value));
        // Object and the button on the top line, the default pause under them: the
        // pause is a setting for what comes next, not part of the click.
        throwRow.appendChild(item);
        throwRow.appendChild(addThrow);
        panel.appendChild(throwRow);
        const defRow = document.createElement("div");
        defRow.className = "gpe-tester-row gpe-tester-defrow";
        defRow.appendChild(defPause);
        panel.appendChild(defRow);

        // Status + clear + send.
        const foot = document.createElement("div");
        foot.className = "gpe-tester-foot";
        const status = document.createElement("span");
        status.className = "gpe-tester-status";
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "gpe-tester-clear";
        clear.textContent = "clear";
        clear.addEventListener("click", () => { testerRows = []; renderTesterSteps(); });
        const send = document.createElement("button");
        send.type = "button";
        send.className = "gpe-tester-send";
        send.textContent = "Send";
        send.addEventListener("click", sendTesterSequence);
        foot.appendChild(status);
        foot.appendChild(clear);
        foot.appendChild(send);
        panel.appendChild(foot);

        // Grabber along the bottom edge: vertical only, since the width is set by
        // the controls inside.
        const grip = document.createElement("div");
        grip.className = "gpe-tester-resize";
        grip.title = "drag to resize";
        panel.appendChild(grip);

        document.body.appendChild(panel);
        applyTesterHeight(panel, testerHeight);
        makeVResizable(panel, grip, "testerHeight");
        placeTester(panel);
        makeDraggable(panel, head, "testerPos");
        renderTesterSteps();
    }

    // Docked, the panel stops being a floating card and becomes a rail on the other
    // side of the table: same top and height as the game area, mirroring the site's
    // own right-hand panels. On a wide screen that puts the table between two
    // columns; on a narrow one there is nowhere to put it, so it stays floating
    // rather than covering the felt.
    const DOCK_MIN_W = 168;
    const DOCK_GAP = 10;
    function dockTarget() {
        const game = document.querySelector(".iogc-GameWindow-container")
            || document.querySelector(".iogc-GameWindow");
        const r = game && game.getBoundingClientRect();
        if (!r || r.width < 1) return null;
        // Mirror the right rail's width when there is one, so both flanks match.
        const rail = document.querySelector(".iogc-SidePanel-inner");
        const railW = rail ? Math.round(rail.getBoundingClientRect().width) : 0;
        const want = Math.max(DOCK_MIN_W, railW || 190);
        // The shift already in place is room we're using, not room we've lost — count
        // it back in, or docking would fight itself: shift right, measure less space,
        // undock, shift back, measure more, dock...
        const applied = document.documentElement.classList.contains("gpe-docked-shift")
            ? parseInt(getComputedStyle(document.documentElement).getPropertyValue("--gpe-dock-shift"), 10) || 0
            : 0;
        const room = r.left + Math.round(applied / 2) - DOCK_GAP * 2;
        if (room < DOCK_MIN_W) return null;                 // no space: stay floating
        const w = Math.min(want, room);
        return { left: Math.max(DOCK_GAP, r.left - DOCK_GAP - w), top: r.top, width: w, height: r.height };
    }

    // Docking puts a column to the left of a layout the site centres on its own, so
    // without this the table ends up right of centre with the new panel hanging off
    // the edge. Padding the body shifts the centred column by HALF the padding, which
    // is exactly what re-centres the assembly: the play area lands in the middle with
    // the two panels the same distance out from it.
    function applyDockShift(width) {
        const root = document.documentElement;
        if (width) root.style.setProperty("--gpe-dock-shift", (width + DOCK_GAP) + "px");
        else root.style.removeProperty("--gpe-dock-shift");
        root.classList.toggle("gpe-docked-shift", !!width);
    }

    // The class carries the look; the geometry is inline because it tracks a live
    // element. Kept together so the two can't disagree.
    function applyTesterDock(panel) {
        const d = testerDock ? dockTarget() : null;
        panel.classList.toggle("gpe-tester-docked", !!d);
        applyDockShift(d ? d.width : 0);
        if (d) {
            panel.style.left = d.left + "px";
            panel.style.top = d.top + "px";
            panel.style.width = d.width + "px";
            panel.style.height = d.height + "px";
        } else {
            panel.style.width = "";
            panel.style.height = "";
            applyTesterHeight(panel, testerHeight);   // back to the dragged height
            // Deliberately does NOT place the panel: placeTester() is what calls this,
            // and calling back into it here recursed forever whenever docking was on
            // but the screen was too narrow to honour it.
        }
        const btn = panel.querySelector(".gpe-tester-dock");
        if (btn) {
            btn.textContent = d ? "⇥" : "⇤";
            btn.title = d ? "undock (float the panel)" : "dock to the left of the table";
            btn.classList.toggle("gpe-active", !!d);
        }
        // Docked, it has no floating geometry to set: no drag, no height grabber.
        const grip = panel.querySelector(".gpe-tester-resize");
        if (grip) grip.style.display = d ? "none" : "";
        return !!d;
    }

    // Fixed position: the dragged spot if there is one (clamped on-screen), else a
    // sensible default down the left edge, clear of the odds HUD.
    function placeTester(panel) {
        if (activeDrag && activeDrag.el === panel) return; // don't fight an active drag
        if (activeResize && activeResize.el === panel) return; // ...or an active resize
        // Always consulted, not just when docking is on: it is what CLEARS the docked
        // class, the page shift and the fixed height when it's turned off. Gating the
        // call on testerDock left an undocked panel still wearing the rail's styling
        // with the page still pushed across.
        if (applyTesterDock(panel)) return;   // docked: geometry comes from the table
        if (testerPos) {
            const p = clampToViewport(testerPos.left, testerPos.top, panel.offsetWidth, panel.offsetHeight);
            panel.style.left = p.left + "px";
            panel.style.top = p.top + "px";
        } else {
            panel.style.left = "14px";
            panel.style.top = "130px";
        }
    }

    // One object per row, so the row count IS the object count.
    function addTesterRow(item) {
        if (testerRows.length >= Q_MAX_ITEMS) {
            flashTesterStatus("full — " + Q_MAX_ITEMS + " items max");
            return;
        }
        testerRows.push({ item: item, pause: testerPause });
        renderTesterSteps();
    }

    function renderTesterSteps() {
        if (!testerPanel) return;
        const list = testerPanel.querySelector(".gpe-tester-steps");
        list.textContent = "";
        if (!testerRows.length) {
            const empty = document.createElement("div");
            empty.className = "gpe-tester-empty";
            empty.textContent = "no throws yet — add one below";
            list.appendChild(empty);
        } else {
            testerRows.forEach((row, i) => {
                const chip = document.createElement("div");
                chip.className = "gpe-tester-step";

                // Reordering, the same way the bet and chat editors do it: a handle
                // arms draggable on mousedown so the row's own inputs stay
                // selectable, and the drop target draws an insertion line above.
                const handle = document.createElement("span");
                handle.className = "gpe-drag gpe-tester-drag";
                handle.textContent = "⠿";
                handle.title = "drag to reorder";
                handle.addEventListener("mousedown", () => { chip.draggable = true; });
                chip.addEventListener("dragstart", (e) => {
                    testerDrag = i;
                    chip.classList.add("gpe-dragging");
                    e.dataTransfer.effectAllowed = "move";
                });
                chip.addEventListener("dragend", () => {
                    chip.draggable = false;
                    chip.classList.remove("gpe-dragging");
                    testerDrag = null;
                });
                chip.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    if (testerDrag !== null && testerDrag !== i) chip.classList.add("gpe-dragover");
                });
                chip.addEventListener("dragleave", () => chip.classList.remove("gpe-dragover"));
                chip.addEventListener("drop", (e) => {
                    e.preventDefault();
                    chip.classList.remove("gpe-dragover");
                    if (testerDrag === null || testerDrag === i) return;
                    const moved = testerRows.splice(testerDrag, 1)[0];
                    testerRows.splice(i, 0, moved);
                    testerDrag = null;
                    renderTesterSteps();   // indices shifted: rebuild
                });
                chip.appendChild(handle);

                const n = document.createElement("span");
                n.className = "gpe-tester-step-n";
                n.textContent = (i + 1) + ".";
                chip.appendChild(n);

                // Two dropdowns: what to throw, and how long to wait after it. Edits
                // write straight back into the row on `change` and deliberately DON'T
                // re-render — rebuilding the list under an open dropdown would close
                // it. Only add/remove/reorder re-renders, since those shift the
                // indices these closures capture.
                const item = document.createElement("select");
                item.className = "gpe-tester-item";
                for (const key of INTERACT_ORDER) {
                    const it = INTERACT_ITEMS[key];
                    const o = document.createElement("option");
                    o.value = key;
                    o.textContent = it.glyph + " " + it.label;
                    if (key === row.item) o.selected = true;
                    item.appendChild(o);
                }
                // A row naming an object this build doesn't have (an older saved
                // sequence, say) keeps its value rather than silently becoming
                // whatever happens to be first in the list.
                if (!INTERACT_ITEMS[row.item]) {
                    const o = document.createElement("option");
                    o.value = row.item;
                    o.textContent = row.item + " (unknown)";
                    o.selected = true;
                    item.appendChild(o);
                }
                item.addEventListener("change", () => { row.item = item.value; syncTesterStatus(); });

                const pause = buildPauseSelect(row.pause, (ms) => { row.pause = ms; syncTesterStatus(); });
                // The last row's pause is never played, so say so rather than let it
                // look like a gap that will happen.
                if (i === testerRows.length - 1) {
                    pause.classList.add("gpe-tester-pause-moot");
                    pause.title = "last throw — this pause isn't played";
                }
                chip.append(item, pause);

                const rm = document.createElement("button");
                rm.type = "button";
                rm.className = "gpe-tester-step-x";
                rm.textContent = "✕";
                rm.title = "remove throw";
                rm.addEventListener("click", () => { testerRows.splice(i, 1); renderTesterSteps(); });
                chip.appendChild(rm);
                list.appendChild(chip);
            });
        }
        syncTesterStatus();
    }

    // Repopulate the target dropdown from the seated players (minus me), keeping
    // the current pick when it's still there. Rebuilds only when the set actually
    // changed, so an open dropdown / a stable selection isn't disturbed every poll.
    function syncTesterTargets() {
        if (!testerPanel) return;
        const sel = testerPanel.querySelector(".gpe-tester-target");
        if (!sel || document.activeElement === sel) return; // don't yank an open dropdown
        const me = getMyName();
        const names = [];
        for (const n of seatedNames()) if (n !== me) names.push(n);
        names.sort();
        const key = names.join("|");
        if (sel._gpeKey === key) return;
        const prev = sel.value;
        sel._gpeKey = key;
        sel.textContent = "";
        if (!names.length) {
            const o = document.createElement("option");
            o.value = ""; o.textContent = "(no other players)";
            sel.appendChild(o);
        }
        for (const n of names) {
            const o = document.createElement("option");
            o.value = n;
            o.textContent = displayName(n);
            sel.appendChild(o);
        }
        if (names.indexOf(prev) !== -1) sel.value = prev;
        syncTesterStatus();
    }

    // The one-line readout beside Send: why a send would fail, or how many steps
    // are queued. A recent send result (flashTesterStatus) holds the line briefly
    // so the poll doesn't wipe it before it's read.
    function syncTesterStatus() {
        if (!testerPanel) return;
        const status = testerPanel.querySelector(".gpe-tester-status");
        const send = testerPanel.querySelector(".gpe-tester-send");
        const sel = testerPanel.querySelector(".gpe-tester-target");
        let msg, ok = false;
        if (!COIN_TOSS) msg = "turn on \"interactions\"";
        else if (!canInteract) msg = "bridge not ready";
        else if (!amSeated()) msg = "take a seat to send";
        else if (!sel || !sel.value) msg = "no target";
        else if (!testerRows.length) msg = "add a throw";
        else {
            // The receiver stops replaying once the pauses pass Q_MAX_TOTAL_MS, so an
            // over-long sequence doesn't fail — it silently loses its tail. Better to
            // refuse to send it than to let that happen off-screen.
            const total = rowsPauseTotal(testerRows);
            if (total > Q_MAX_TOTAL_MS) {
                msg = "over " + (Q_MAX_TOTAL_MS / 1000) + "s — shorten a pause";
            } else {
                msg = testerRows.length + "/" + Q_MAX_ITEMS + " items"
                    + (total ? " · " + (total / 1000) + "s of pauses" : "");
                ok = true;
            }
        }
        if (send) send.disabled = !ok;
        if (status && !(status._gpeHoldUntil && Date.now() < status._gpeHoldUntil)) status.textContent = msg;
    }

    function flashTesterStatus(text) {
        if (!testerPanel) return;
        const status = testerPanel.querySelector(".gpe-tester-status");
        if (!status) return;
        status.textContent = text;
        status._gpeHoldUntil = Date.now() + 2000;
    }

    // Fire the built sequence: one POST for the whole thing (the wire coalesces it
    // — one throw per item, pauses between — and the server's 2s cooldown would
    // eat a per-item burst). Nothing renders here; it plays when the broadcast
    // comes back, exactly as a menu throw does.
    function sendTesterSequence() {
        if (!testerPanel) return;
        const sel = testerPanel.querySelector(".gpe-tester-target");
        const name = sel && sel.value;
        if (!name || !testerRows.length) return;
        if (rowsPauseTotal(testerRows) > Q_MAX_TOTAL_MS) return; // the status says why
        const steps = rowsToSteps(testerRows);
        flashTesterStatus("sending…");
        sendInteraction(name, steps).then((sent) => flashTesterStatus(sent ? "sent ✓" : "dropped ✗"));
    }

    // Match the first emoji in a message — ANY emoji, not just the picker set.
    // RGI_Emoji (v flag) captures whole sequences (ZWJ joins, flags, skin
    // tones); fall back to Extended_Pictographic + modifiers where v isn't
    // supported. Built with new RegExp so an unsupported flag throws a catchable
    // runtime error rather than a parse-time syntax error. (Share messages are
    // handled and returned before this runs, so their ♠♥♦♣ never reach here.)
    let EMOJI_RE = null;
    try { EMOJI_RE = new RegExp("\\p{RGI_Emoji}", "v"); }
    catch (e1) {
        try {
            EMOJI_RE = new RegExp(
                "\\p{Extended_Pictographic}(?:[\\u{1F3FB}-\\u{1F3FF}]|\\uFE0F|\\u200D\\p{Extended_Pictographic})*", "u");
        } catch (e2) { EMOJI_RE = null; }
    }

    function firstEmoteIn(text) {
        if (EMOJI_RE) { const m = text.match(EMOJI_RE); if (m) return m[0]; }
        for (const e of EMOTES) if (text.includes(e)) return e; // last-ditch: picker set
        return null;
    }

    const SUIT_GLYPH = { c: "♣", d: "♦", h: "♥", s: "♠" };
    const RANK_LABEL = { T: "10" };

    // Per-player stats learned from completed hands (VPIP/PFR/aggression/
    // showdowns), persisted so reads survive reloads. Keyed by player name.
    const PLAYER_STATS_KEY = "gpe_player_stats";
    let playerStats = {};
    function savePlayerStats() {
        if (EXT_STORE) { try { EXT_STORE.set({ [PLAYER_STATS_KEY]: playerStats }); } catch (e) {} }
    }

    // Free-text per-player notes (declared here: initStorage() runs at boot
    // and reads this key, so it must exist before that call).
    const NOTES_KEY = "gpe_player_notes";
    let playerNotes = {}; // name -> free text

    // Muted players: their chat never reaches the pane, the popout, or any of the
    // overlays chat drives. Names are stored as typed but matched case-insensitively,
    // since that's how people retype a name they're annoyed at.
    const MUTED_KEY = "gpe_muted";
    let mutedList = [];                  // display order, as entered
    let mutedKeys = new Set();           // lowercased, for matching
    function rebuildMutedKeys() {
        mutedKeys = new Set(mutedList.map((n) => n.trim().toLowerCase()));
    }
    function isMuted(name) {
        if (!MUTE_CHAT || !name) return false;
        return mutedKeys.has(String(name).trim().toLowerCase());
    }
    function saveMuted() {
        if (EXT_STORE) { try { EXT_STORE.set({ [MUTED_KEY]: mutedList }); } catch (e) {} }
    }
    // One place that re-applies muting everywhere it shows: the pane (lines already
    // on screen), the popout, and the roster's own buttons.
    function applyMuting() {
        applyMuteToChatPane();
        renderPopoutAll();
        renderMuteEditorRows();
    }
    function setMuted(name, on) {
        const n = String(name || "").trim();
        if (!n) return;
        const key = n.toLowerCase();
        if (on) { if (!mutedKeys.has(key)) mutedList.push(n); }
        else mutedList = mutedList.filter((x) => x.trim().toLowerCase() !== key);
        rebuildMutedKeys();
        saveMuted();
        applyMuting();
    }

    // Per-player nicknames. When a chat button token resolves to a player who
    // has one, the nickname is posted instead of their handle (so "gg" can
    // address them how you'd actually address them).
    const NICKS_KEY = "gpe_player_nicknames";
    let playerNicks = {}; // name -> nickname

    // "all in" used to be a hardcoded, always-on cap on the top column. Now
    // it's a real config entry. For anyone who had customized their buttons
    // (an explicit array), inject the entry once so it doesn't vanish; a flag
    // stops it re-appearing after they delete it. Mutates and returns `s`.
    function migrateAllIn(s) {
        if (s.betAllInMigrated) return s;
        if (Array.isArray(s.betButtons) && !s.betButtons.some((c) => c && c.base === "allin")) {
            s.betButtons = [{ mult: 1, base: "allin", pos: "top" }].concat(s.betButtons);
        }
        s.betAllInMigrated = true; // no array = defaults already include all-in
        return s;
    }

    function initStorage() {
        if (!EXT_STORE) { // no extension storage available: legacy fallback
            // Deferred by a tick on purpose. initStorage() is called partway down
            // this file, but applySettings() writes module state that is declared
            // further down still, next to the features that own it (oddsPos,
            // SIDE_COLLAPSED, SHOW_TEAMS, LOBBY_*). Calling it synchronously from
            // here therefore hit those `let`s in their temporal dead zone and threw
            // "Cannot access 'oddsPos' before initialization", taking the whole
            // content script down. The chrome.storage path below is async and so
            // was never affected — which is why only this fallback was broken.
            setTimeout(() => applySettings(legacyLocalStorageSettings()), 0);
            return;
        }
        EXT_STORE.get(["gpe_settings", PLAYER_STATS_KEY, NOTES_KEY, NICKS_KEY, MUTED_KEY], (res) => {
            if (Array.isArray(res[MUTED_KEY])) {
                mutedList = res[MUTED_KEY].filter((n) => typeof n === "string" && n.trim()).slice(0, 200);
                rebuildMutedKeys();
            }
            if (res.gpe_settings) {
                const s = res.gpe_settings;
                if (!s.betAllInMigrated) { migrateAllIn(s); EXT_STORE.set({ gpe_settings: s }); }
                applySettings(s);
            } else { // one-time migration from the old localStorage toggles
                const legacy = legacyLocalStorageSettings();
                legacy.betAllInMigrated = true; // fresh install: defaults have all-in
                applySettings(legacy);
                EXT_STORE.set({ gpe_settings: legacy });
            }
            playerStats = res[PLAYER_STATS_KEY] || {};
            playerNotes = res[NOTES_KEY] || {};
            playerNicks = res[NICKS_KEY] || {};
            updateOddsHud();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            if (changes.gpe_settings) { applySettings(changes.gpe_settings.newValue || {}); updateOddsHud(); }
            if (changes[PLAYER_STATS_KEY]) playerStats = changes[PLAYER_STATS_KEY].newValue || {};
            if (changes[NOTES_KEY]) playerNotes = changes[NOTES_KEY].newValue || {};
            if (changes[NICKS_KEY]) { playerNicks = changes[NICKS_KEY].newValue || {}; updateStatBadges(); }
            if (changes[MUTED_KEY]) {
                mutedList = Array.isArray(changes[MUTED_KEY].newValue) ? changes[MUTED_KEY].newValue : [];
                rebuildMutedKeys();
                applyMuting();
            }
        });
    }
    initStorage();

    // ---------- game log reading ----------
    function logLines() {
        return Array.from(document.querySelectorAll(
            ".iogc-MessagePanel-messages div, .iogc-MessagePanel-messages td, .iogc-MessagePanel-messages span"
        )).filter((e) => e.children.length === 0 && e.textContent.trim())
            .map((e) => e.textContent.trim());
    }

    // Lines belonging to the current/most-recent hand (after the last "Starting Hand").
    function currentHandScope() {
        const lines = logLines();
        let lastStart = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (/Starting Hand/i.test(lines[i])) { lastStart = i; break; }
        }
        return lastStart >= 0 ? lines.slice(lastStart) : lines;
    }

    // The visible log is a rolling ~100-line window, so on long/multi-way hands
    // early streets are trimmed before the hand ends. We accumulate the full
    // current hand across polls by OVERLAP-MERGING the DOM's current-hand slice
    // into handScopeBuf: only the genuinely-new tail is appended. This is immune
    // to the log re-rendering the same rows (which doubled an append-on-mutation
    // approach). Read via fullHandScope().
    let handScopeBuf = [];
    function domHandScope() {
        const rows = Array.from(document.querySelectorAll(".iogc-MessagePanel-messages div.gwt-HTML:not(.gpe-log-cards)"))
            .map((r) => r.textContent.trim()).filter(Boolean);
        let start = -1;
        for (let i = rows.length - 1; i >= 0; i--) if (/^Starting Hand/i.test(rows[i])) { start = i; break; }
        return start >= 0 ? rows.slice(start) : rows;
    }
    function updateHandScope() {
        const dom = domHandScope();
        if (!dom.length) return;
        const buf = handScopeBuf;
        if (!buf.length) { handScopeBuf = dom.slice(); return; }
        // Largest k where buf's last k lines equal dom's first k lines (the overlap
        // between what we've kept and the current window).
        const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        let k = Math.min(buf.length, dom.length);
        while (k > 0 && !eq(buf.slice(buf.length - k), dom.slice(0, k))) k--;
        if (k === 0) handScopeBuf = dom.slice();          // no overlap -> new hand: replace
        else handScopeBuf = buf.concat(dom.slice(k));     // append only the new tail
    }
    // Complete current-hand scope: the accumulated buffer when available, else
    // the (possibly trimmed) DOM slice.
    function fullHandScope() {
        return handScopeBuf.length ? handScopeBuf : domHandScope();
    }

    // Unique per-hand id, read from the end-of-hand log line
    // "Replay: <a href=.../games/<ID>>". Public and identical for every seat, so
    // sharer and receiver derive the same value. Returns null until the current
    // hand ends (the Replay link is inside an <a>, so it lives on a gwt-HTML row
    // that logLines() drops — we read these rows directly and scope to the
    // stretch after the last "Starting Hand").
    function currentGameId() {
        const rows = Array.from(document.querySelectorAll(".iogc-MessagePanel-messages div.gwt-HTML:not(.gpe-log-cards)"));
        let lastStart = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (/Starting Hand/i.test(rows[i].textContent)) { lastStart = i; break; }
        }
        for (let i = rows.length - 1; i > lastStart; i--) {
            const m = rows[i].textContent.match(/gpokr\.com\/games\/(\d+)/i);
            if (m) return m[1];
        }
        return null;
    }

    // My pocket cards, from a given scope. Taking the scope as an argument (rather
    // than reading the log) is what lets a finished hand be re-rendered later, once
    // the DOM has moved on to the next one.
    function myHandFromScope(scope) {
        const pocket = (scope || []).find((t) => /pocket cards/i.test(t));
        if (!pocket) return null;
        const m = pocket.match(/\[([^,]+),\s*([^\]]+)\]/);
        return m ? [m[1].trim(), m[2].trim()] : null;
    }
    // My pocket cards for the current/most-recent hand.
    function readMyHand() { return myHandFromScope(currentHandScope()); }

    // End-of-hand signal: prefer the showdown "shows [..]" line; fall back to "wins pot".
    // (Fold-only hands have no showdown, so they only produce a pot award.)
    function handHasEnded(scope) {
        scope = scope || currentHandScope();
        if (scope.some((t) => /\bshows \[/i.test(t))) return true;
        if (scope.some((t) => /wins main pot/i.test(t))) return true;
        return false;
    }

    // Celebrations are a between-hands thing. Once the flop is out the table is
    // playing, and a burst of confetti — or someone's avatar getting up to dance in
    // the middle of the felt — is in the way of people reading the board. So the
    // window is: from the moment a hand finishes, through the next deal, until its
    // flop lands. A hand that ends preflop simply never closes it.
    //
    // Cached briefly because the fast (300ms) poll asks on every tick to keep the
    // toolbar honest, and answering means walking the game log.
    let celebGate = { at: 0, ok: true };
    function celebrationsAllowed() {
        const now = Date.now();
        if (now - celebGate.at < 400) return celebGate.ok;
        const scope = currentHandScope();
        // Read once, use twice: hand over -> open again; otherwise open only until
        // the first community card of this hand.
        const ok = handHasEnded(scope) || boardFromScope(scope).length === 0;
        celebGate = { at: now, ok: ok };
        return ok;
    }

    // ---------- game-state parsing (odds feature) ----------
    function normCard(c) {
        c = c.trim();
        if (c.startsWith("10")) c = "T" + c.slice(2);
        return c[0].toUpperCase() + c[1].toLowerCase();
    }

    // Community cards for the latest hand in a scope: "Dealing flop: [Ts, 7c, 4d]"
    // / turn / river. A hand deals flop(3)->turn(1)->river(1) in that order; if a
    // "Dealing" line arrives out of sequence (a second turn/river, or a flop when
    // the board isn't empty) the scope has bled into another hand — which happens
    // transiently when a table switch briefly merges two tables' logs under one
    // "Starting Hand". We restart from that line so only the most recent hand's
    // board is kept, and it can never exceed 5 cards (the old bug: 7-card boards).
    function boardFromScope(scope) {
        let board = [], stage = 0; // stage: 0 none, 1 flop, 2 turn, 3 river
        for (const line of scope) {
            const m = line.match(/Dealing (flop|turn|river):\s*\[([^\]]+)\]/i);
            if (!m) continue;
            const want = m[1].toLowerCase() === "flop" ? 1 : m[1].toLowerCase() === "turn" ? 2 : 3;
            const cards = m[2].split(",").map(normCard);
            if (want === stage + 1) board = board.concat(cards); // in-order continuation
            else board = cards.slice();                          // out of order -> new hand: restart
            stage = want;
        }
        return board.slice(0, 5);
    }
    function parseBoard() {
        return boardFromScope(currentHandScope());
    }

    // Visible seated players minus those who folded this hand, minus me.
    function activeOpponents() {
        const names = new Set(
            Array.from(document.querySelectorAll(".iogc-PlayerPanel-name"))
                .filter((n) => n.textContent.trim() && n.getBoundingClientRect().width > 0)
                .map((n) => n.textContent.trim())
        );
        for (const line of currentHandScope()) {
            const m = line.match(/^(.+?) folds$/i);
            if (m) names.delete(m[1].trim());
        }
        const me = getMyName();
        if (me && names.has(me)) names.delete(me);
        else if (names.size) names.delete(names.values().next().value); // can't identify me: drop one
        return Array.from(names).slice(0, 8);
    }

    // Preflop range model from this hand's log. Static guesses (raisers ~top
    // 18%, callers ~top 35%) until a player has enough observed hands, then
    // their measured PFR/VPIP takes over. Blinds/unacted players are random
    // (1.0). A player's tightest preflop action wins.
    const RANGE_RAISE = 0.18, RANGE_CALL = 0.35;
    const MIN_STATS_HANDS = 20;
    function measuredRange(name, raised) {
        const t = playerStats[name];
        if (!t || t.hands < MIN_STATS_HANDS) return null;
        const f = (raised ? t.pfr : t.vpip) / t.hands;
        return Math.min(0.9, Math.max(0.05, f));
    }
    function parseOppRanges(names) {
        const acted = {};
        for (const line of currentHandScope()) {
            if (/^Dealing (?:flop|turn|river)/i.test(line)) break; // preflop actions only
            let m = line.match(/^(.+?) raises\b/i);
            if (m) {
                const n = m[1].trim();
                const r = measuredRange(n, true);
                acted[n] = Math.min(acted[n] || 1, r !== null ? r : RANGE_RAISE);
                continue;
            }
            m = line.match(/^(.+?) calls\b/i);
            if (m) {
                const n = m[1].trim();
                const r = measuredRange(n, false);
                acted[n] = Math.min(acted[n] || 1, r !== null ? r : RANGE_CALL);
            }
        }
        return names.map((n) => acted[n] || 1);
    }

    function parseMoney(text) {
        const m = text.match(/\$\s*([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
    }

    // Pot from the pot label; amount to call from the Check/Call button (0 unless facing a bet).
    function parsePotAndToCall() {
        const potEl = document.querySelector(".gpokr-GameWindow-potLabel");
        const pot = potEl ? parseMoney(potEl.textContent) : 0;
        const callBtn = document.querySelector(".gpokr-GameWindow-checkCallButton");
        let toCall = 0;
        if (callBtn && callBtn.getBoundingClientRect().width > 0 && /call/i.test(callBtn.textContent)) {
            toCall = parseMoney(callBtn.textContent);
        }
        return { pot, toCall };
    }

    // ---------- odds HUD ----------
    let oddsKey = "";
    let oddsResult = null;
    let oddsDraw = null;
    let oddsLabel = "";
    let boardDeltas = [];
    // Dragged position (viewport px). null = auto-place (centered on the header).
    // Persisted as settings.oddsPos so it survives across sessions.
    let oddsPos = null;
    let oddsDrag = null; // { hud, offX, offY } while a drag is in progress

    // Keep a position fully within the viewport (so a stale saved spot or a
    // window resize can't strand the HUD off-screen).
    function clampToViewport(left, top, w, h) {
        return {
            left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w)),
            top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h)),
        };
    }

    // Drag the HUD with the mouse. mousedown is bound per-HUD (see updateOddsHud);
    // the move/up listeners are global and bound once (below) so re-creating the
    // HUD never stacks duplicates.
    function beginOddsDrag(hud, e) {
        if (e.button !== 0) return;
        const r = hud.getBoundingClientRect();
        oddsDrag = { hud, offX: e.clientX - r.left, offY: e.clientY - r.top };
        hud.classList.add("gpe-dragging");
        e.preventDefault(); // no text selection while dragging
    }
    window.addEventListener("mousemove", (e) => {
        if (!oddsDrag) return;
        const hud = oddsDrag.hud;
        oddsPos = clampToViewport(e.clientX - oddsDrag.offX, e.clientY - oddsDrag.offY,
            hud.offsetWidth, hud.offsetHeight);
        hud.style.left = oddsPos.left + "px";
        hud.style.top = oddsPos.top + "px";
    });
    window.addEventListener("mouseup", () => {
        if (!oddsDrag) return;
        oddsDrag.hud.classList.remove("gpe-dragging");
        oddsDrag = null;
        saveSetting("oddsPos", oddsPos); // remember it for next session
    });

    // Color classes: green = good, yellow = neutral, red = bad.
    // Hole cards: equity vs the break-even share against this many opponents.
    function equityClass(eq, nOpp) {
        const fair = 1 / (nOpp + 1);
        if (eq >= fair * 1.25) return "gpe-odds-good";
        if (eq <= fair * 0.75) return "gpe-odds-bad";
        return "gpe-odds-neutral";
    }
    // Board cards: how much the card moved my equity when it arrived.
    function deltaClass(d) {
        if (d >= 0.03) return "gpe-odds-good";
        if (d <= -0.03) return "gpe-odds-bad";
        return "gpe-odds-neutral";
    }

    // Position the HUD (fixed, so it never expands any layout). If the user has
    // dragged it, honor that saved spot (clamped on-screen); otherwise float it
    // centered over the game window's header bar.
    function placeOddsHud(hud) {
        if (hud.style.display === "none" || oddsDrag) return; // don't fight an active drag
        if (oddsPos) {
            const p = clampToViewport(oddsPos.left, oddsPos.top, hud.offsetWidth, hud.offsetHeight);
            hud.style.left = p.left + "px";
            hud.style.top = p.top + "px";
            return;
        }
        const container = document.querySelector(".iogc-GameWindow-container");
        if (!container) { hud.style.left = "12px"; hud.style.top = "60px"; return; }
        const r = container.getBoundingClientRect();
        hud.style.left = Math.max(0, r.left + (r.width - hud.offsetWidth) / 2) + "px";
        hud.style.top = r.top + 2 + "px";
    }

    function updateOddsHud() {
        let hud = document.getElementById("gpe-odds-hud");
        if (!SHOW_ODDS) {
            if (hud) { clearInterval(hud._gpeReposition); hud.remove(); }
            oddsKey = "";
            return;
        }

        const hand = readMyHand();
        if (!hand || handHasEnded() || !window.GPE_ODDS) {
            if (hud) hud.style.display = "none";
            return;
        }

        const board = parseBoard();
        const opps = activeOpponents();
        const nOpp = Math.max(1, opps.length);
        const ranges = parseOppRanges(opps);
        while (ranges.length < nOpp) ranges.push(1);
        const { pot, toCall } = parsePotAndToCall();

        // Recompute equity only when hand/board/opponents/ranges change.
        const key = hand.join("") + "|" + board.join("") + "|" + nOpp + "|" + ranges.join(",");
        if (key !== oddsKey) {
            oddsResult = window.GPE_ODDS.monteCarloEquity(hand, board, nOpp, 5000, ranges);
            // Attribute each board card: equity with it vs without it (fewer iters — color only).
            boardDeltas = board.map((c, i) => {
                const without = board.slice(0, i).concat(board.slice(i + 1));
                return oddsResult.equity - window.GPE_ODDS.monteCarloEquity(hand, without, nOpp, 2000, ranges).equity;
            });
            oddsDraw = window.GPE_ODDS.drawInfo(hand, board);
            oddsLabel = window.GPE_ODDS.handLabel(hand, board);
            oddsKey = key;
        }

        if (!hud) {
            hud = document.createElement("div");
            hud.id = "gpe-odds-hud";
            hud.title = "drag to reposition";
            hud.addEventListener("mousedown", (e) => beginOddsDrag(hud, e));
            document.body.appendChild(hud);
            hud._gpeReposition = setInterval(() => placeOddsHud(hud), 200);
        }
        hud.style.display = "";

        const eq = oddsResult.equity;
        const odds = window.GPE_ODDS.potOdds(pot, toCall); // pot label already includes current bets
        const dec = window.GPE_ODDS.evDecision(eq, odds);
        const pct = (x) => (x * 100).toFixed(1) + "%";

        const streets = ["preflop", "flop", "flop", "flop", "turn", "river"];
        const row = (cls) => { const d = document.createElement("div"); d.className = cls; return d; };
        const span = (cls, text) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; return s; };

        // Built with DOM nodes (not innerHTML) so no dynamic markup is parsed.
        // (Equity is still computed: it colors the hole cards and drives the
        // CALL/FOLD verdict — just no longer shown as its own row.)
        hud.textContent = "";

        const title = row("gpe-odds-row gpe-odds-title");
        title.appendChild(span(equityClass(eq, nOpp), hand.join(" ")));
        if (board.length) {
            title.appendChild(document.createTextNode(" | "));
            board.forEach((c, i) => {
                if (i) title.appendChild(document.createTextNode(" "));
                title.appendChild(span(deltaClass(boardDeltas[i] || 0), c));
            });
        }
        title.appendChild(document.createTextNode(" "));
        title.appendChild(span("gpe-odds-street", "(" + streets[board.length] + ")"));
        hud.appendChild(title);

        const labelRow = row("gpe-odds-row");
        labelRow.textContent = oddsLabel;
        hud.appendChild(labelRow);

        if (oddsDraw) {
            const parts = [];
            if (oddsDraw.flushOuts) parts.push("flush " + oddsDraw.flushOuts);
            if (oddsDraw.straightOuts)
                parts.push((oddsDraw.straightRanks >= 2 ? "straight " : "gutshot ") + oddsDraw.straightOuts);
            if (oddsDraw.otherOuts) parts.push("boat " + oddsDraw.otherOuts);
            const drawRow = row("gpe-odds-row");
            drawRow.textContent = "draw: " + parts.join(" + ") + " = " + oddsDraw.outs +
                " outs (~" + pct(oddsDraw.hitProb) + ")";
            hud.appendChild(drawRow);
        }

        const potRow = row("gpe-odds-row");
        if (toCall > 0) {
            potRow.appendChild(document.createTextNode(
                "pot $" + pot.toLocaleString() + " | call $" + toCall.toLocaleString() +
                " | need " + pct(odds) + " "));
            const verdict = span("gpe-odds-" + dec.action, "");
            const b = document.createElement("b");
            b.textContent = dec.action.toUpperCase();
            verdict.appendChild(b);
            potRow.appendChild(verdict);
        } else {
            potRow.textContent = "pot $" + pot.toLocaleString() + " | nothing to call";
        }
        hud.appendChild(potRow);

        placeOddsHud(hud);
    }

    // ---------- hand token (checksum speed-bump) ----------
    // Rolling hash -> 3 base-36 chars. Kept intact so the legacy [gh:..] token
    // still verifies; the new format layers name + game id on top via handToken.
    function handChecksum(body) {
        let h = 7919;
        const salt = "gpHand!";
        const combined = salt + body + salt;
        for (let i = 0; i < combined.length; i++) h = ((h << 5) + h + combined.charCodeAt(i)) >>> 0;
        return (h % 46656).toString(36).padStart(3, "0");
    }

    // Bind the reveal to WHO shared it and WHICH hand, so a copy-pasted token
    // (different chat sender) or a stale/replayed one (different game id) fails
    // to verify. 4 base-36 chars: not cryptographic (the salt ships in the
    // code), just a speed-bump against casual copy-paste.
    function handToken(name, gameId, body) {
        const norm = (name || "").trim().toLowerCase();
        return handChecksum(norm + "|" + (gameId || "") + "|" + body) +
            handChecksum(body + "|" + (gameId || "") + "|" + norm).slice(0, 1);
    }

    // "As" -> "as" (rank+suit, both lower) for the checksum body.
    function cardBody(cards) {
        return cards.map((c) => c[0].toLowerCase() + c[1].toLowerCase()).join("");
    }

    // "As" -> "A♠" for the human-readable chat line (rank upper, suit symbol).
    function fmtCardPretty(c) {
        const suit = c[1].toLowerCase();
        return c[0].toUpperCase() + (SUIT_GLYPH[suit] || suit);
    }

    function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    // English name of the best 5-card hand from my hole cards plus whatever
    // board (flop/turn/river) was dealt this hand, e.g. "Two pair, aces and
    // sevens". Null if the odds module is missing. Read at end of hand, so
    // parseBoard() reflects the full board that was shown.
    function handLabelFor(cards) {
        if (!window.GPE_ODDS) return null;
        try {
            const label = window.GPE_ODDS.handLabel(cards, parseBoard());
            return label ? cap(label) : null;
        } catch (e) { return null; }
    }

    // e.g. "shows cards: A♠, 7♣ [k4a2] — Two pair, aces and sevens". The
    // player's name comes from GPokr's own bold prefix, so we don't repeat it
    // here. The made-hand name is appended after the token as human-readable
    // text (everyone reads it in chat); it's outside the verification token, so
    // receivers just parse it back off — see decodeHand. Note: this trailing
    // text means clients on the older build (whose decoder anchors the token at
    // end-of-line) won't render the shared cards — a deliberate trade-off.
    function encodeHand(cards, gameId, label) {
        const pretty = cards.map(fmtCardPretty).join(", ");
        let msg = "shows cards: " + pretty + " [" + handToken(getMyName(), gameId, cardBody(cards)) + "]";
        if (label) msg += " — " + label;
        return msg;
    }

    // Map a symbol back to its suit letter (reverse of SUIT_GLYPH).
    const SYM_SUIT = { "♣": "c", "♦": "d", "♥": "h", "♠": "s" };
    // Parse "A♠" or "As" -> "As" (rank upper, suit lower), or null if not a card.
    function parseCard(tok) {
        const m = tok.trim().match(/^([2-9tjqka])\s*([cdhs♣♦♥♠])$/i);
        if (!m) return null;
        const suit = (SYM_SUIT[m[2]] || m[2]).toLowerCase();
        return m[1].toUpperCase() + suit;
    }

    // Returns { cards, gameId|null, fmt } or null. `sender` is the chat <b> name
    // and `ids` are the receiver's [current, previous] game ids for verification.
    // Trim the human-readable hand name to plain text (defence-in-depth: the
    // overlay uses textContent, so this only caps length / strips stray brackets).
    function sanitizeLabel(s) {
        if (!s) return null;
        s = s.replace(/[\[\]\r\n]/g, "").trim();
        return s ? s.slice(0, 48) : null;
    }

    function decodeHand(text, sender, ids) {
        // New format: name + game-id bound token, with an optional trailing
        // "— <hand name>" (human-readable, outside the token).
        let m = text.match(/^shows cards:\s*(.+?)\s*\[([0-9a-z]+)\](?:\s*[—-]\s*(.+?))?\s*$/i);
        if (m) {
            const cards = m[1].split(",").map(parseCard);
            if (cards.length && cards.every(Boolean)) {
                const body = cardBody(cards);
                for (const id of (ids || [])) {
                    if (id != null && handToken(sender, id, body) === m[2].toLowerCase()) {
                        return { cards, gameId: id, fmt: "v2", label: sanitizeLabel(m[3]) };
                    }
                }
            }
            return null; // looked like a share but failed verification -> drop
        }
        // Legacy format: body-only checksum, no name/id binding.
        m = text.match(/\[gh:([2-9tjqka][cdhs](?:[2-9tjqka][cdhs])?)\.([0-9a-z]{3})\]/i);
        if (!m) return null;
        const body = m[1].toLowerCase();
        if (handChecksum(body) !== m[2].toLowerCase()) return null;
        const cards = [];
        for (let i = 0; i < body.length; i += 2) cards.push(body[i].toUpperCase() + body[i + 1].toLowerCase());
        return { cards, gameId: null, fmt: "v1" };
    }

    // ---------- four-color deck (accessibility) ----------
    // Blue diamonds and green clubs, for players who can't reliably tell the two
    // red suits apart from each other or the two black ones. Nothing is redrawn:
    // the site's own art is recolored in place by two SVG filters (defined
    // below, applied from overlay.css). That is exact rather than approximate
    // because the pips and the rank are a single pure ink — #ff0000 or #000000 —
    // sitting on neutral paper, so a filter can move the ink without touching the
    // card. Hearts and spades are left alone, so red and black still mean what
    // they always did.
    //
    // Aiming a filter is the hard part, not the recoloring. Hearts are exactly
    // as red as diamonds and spades exactly as black as clubs, so one blanket
    // rule would give blue hearts and green spades and help nobody: every card
    // has to be identified individually. The site offers nothing to identify it
    // with — GWT inlines the whole deck into its bundle, so each card is an <img>
    // whose src is a data: URI (no filename for a selector to match), the bundle
    // is obfuscated (no class names the suit survives), and the <img>s are
    // recycled between hands with their src swapped (so position is no anchor
    // either; see showHandLocal).
    //
    // What *is* stable is the artwork: 52 fixed data: URIs, one per card. So
    // identity is a hash lookup on the src — exact, with no heuristics that could
    // silently mislabel a suit. If gpokr ever reships its deck the hashes stop
    // matching, every card reads as unknown, and the feature turns itself off
    // rather than guessing.
    const DECK_RANKS = "23456789TJQKA";
    // FNV-1a/32 of the base64 payload of each card's data: URI, by suit, in
    // DECK_RANKS order. Collision-free across the 52, and identical in both of
    // the GWT permutations the site ships.
    const DECK_HASHES = {
        c: "4ac44c7c d599cf06 0fa9537a 44ef3388 eb369393 da03663a 77e2ec23 b1f2c64d a5853044 3428c57a d054af58 b55cb8b1 30448f62",
        d: "54d0d261 e22bdbe5 d1d0a35b 8b5d8c11 d0900dc7 ce561029 7f7e4617 84d310b8 0ffdafd7 6d038aae fb567275 1325ec21 2c343cba",
        h: "ad5be844 5ac9a050 787aa083 aebbca34 1a4a1467 df10b629 518fd554 af09ae6f c19df70d df3f023b 3d4e5c7a 32ea59f4 65f28d86",
        s: "c22aa8ee 2d988a6d 64a6e85c 33269658 e44e77f3 0fb34bd9 acc5e3e8 0165fe69 c16fd024 4248766a 039a8790 14206239 14d8de9c",
    };
    const DECK_BY_HASH = (() => {
        const m = new Map();
        for (const suit of Object.keys(DECK_HASHES)) {
            DECK_HASHES[suit].split(" ").forEach((h, i) => m.set(h, DECK_RANKS[i] + suit));
        }
        return m;
    })();

    function fnv1a32(s) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, "0");
    }

    // Matches both forms a data: URI can reach us in: an <img src> (bare) and a
    // background-image (wrapped in url("...")). Only the base64 body is hashed,
    // so the table survives a change in the mime prefix.
    const DATA_URI_B64 = /;base64,([A-Za-z0-9+/=]+)/;
    // Our own cards (shared hands, the hand-summary panel) are not data: URIs —
    // they come from the canonical CDN path, which spells the card out in the
    // filename. See cardImageUrl(). Reading it here rather than trusting the
    // data-gpe-card that makeCardEl sets keeps one function the authority on
    // what a card image is: otherwise this would run on our own <img>, find no
    // base64 to hash, and clear the stamp makeCardEl had just applied.
    const CARD_URL_NAME = /\/GPokr\/cards\/([2-9TJQKA][cdhs])\.png/;
    // Natural size of every card in the deck — used only to tell "this is a card
    // we can't name" from "this is some other image", for the warning below.
    const CARD_W = 53, CARD_H = 69;
    let deckWarned = false;

    // Name one image, if it is a card. Stamps data-gpe-card="Td"; overlay.css
    // does the rest. Runs for everyone, not just when the setting is on: it is a
    // string compare for anything that hasn't changed, and always-stamping means
    // enabling the option can't leave a stale suit on a card for a frame.
    function stampCardImg(img) {
        const src = img.currentSrc || img.getAttribute("src") || "";
        if (src === img._gpeCardSrc) return;
        img._gpeCardSrc = src;
        const m = DATA_URI_B64.exec(src);
        const named = CARD_URL_NAME.exec(src);
        const card = m ? DECK_BY_HASH.get(fnv1a32(m[1])) : (named ? named[1] : null);
        if (card) { img.dataset.gpeCard = card; return; }
        delete img.dataset.gpeCard;
        // A card-shaped image we can't name means the deck was reshipped and the
        // table above is stale. Say so once — the filters stay off either way.
        if (m && FOUR_COLOR && !deckWarned &&
            img.naturalWidth === CARD_W && img.naturalHeight === CARD_H) {
            deckWarned = true;
            console.warn("[GPokr Tools] card artwork not recognised — the four-color " +
                "deck is off for it. The site's deck images may have changed.");
        }
    }

    // Everything we do to a card image, in one place: name it for the four-color
    // deck, and swap it if it is the back. Both are no-ops for an image that has
    // not changed since we last looked at it.
    function processCardImg(img) {
        stampCardImg(img);
        styleCardBack(img);
    }

    function sweepCardImgs() {
        document.querySelectorAll("img").forEach(processCardImg);
    }

    // Driven by mutations, with the 300ms poll only as a backstop. Both features
    // need that: the poll alone would leave a swapped card wearing the previous
    // card's suit for up to a third of a second (long enough to watch a heart
    // flash blue), and would let GWT's own card back show between a re-render and
    // our replacing it. Observer callbacks run before paint, so neither is seen.
    function watchCardImages() {
        const obs = new MutationObserver((recs) => {
            for (const r of recs) {
                if (r.type === "attributes") { processCardImg(r.target); continue; }
                r.addedNodes.forEach((n) => {
                    if (n.nodeType !== 1) return;
                    if (n.tagName === "IMG") processCardImg(n);
                    else if (n.querySelectorAll) n.querySelectorAll("img").forEach(processCardImg);
                });
            }
        });
        obs.observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, attributeFilter: ["src"],
        });
    }

    // A CSS filter can only reference an SVG filter that is in the same document,
    // so the definitions have to be injected rather than living in overlay.css.
    // Added before the root class goes on: filter: url() pointing at nothing
    // renders the card unfiltered, which would look like the feature failing.
    const SUIT_FILTER_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false">' +
        // Diamonds. R'=G and B'=R-G+B, i.e. the red ink is moved into the blue
        // channel: #ff0000 lands exactly on #0000ff, while every neutral pixel
        // (R==G — the paper, the grey frame, the black rank on a black card)
        // comes back bit-identical. No hue-rotate, which only approximates this.
        '<filter id="gpe-suit-diamond" color-interpolation-filters="sRGB">' +
        '<feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  1 -1 1 0 0  0 0 0 1 0"/>' +
        '</filter>' +
        // Clubs. hue-rotate cannot touch these at all: black has zero saturation,
        // so there is no hue to rotate. The green has to be painted on through a
        // mask instead.
        '<filter id="gpe-suit-club" color-interpolation-filters="sRGB">' +
        // alpha = 1 - luma, i.e. "how dark is this pixel".
        '<feColorMatrix result="dark" type="matrix" ' +
        'values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.2126 -0.7152 -0.0722 0 1"/>' +
        // Clipped to the card's own alpha, or the transparent rounded corners —
        // whose RGB is arbitrary, and read as dark — would come back solid green.
        '<feComposite in="dark" in2="SourceGraphic" operator="in" result="inside"/>' +
        // Threshold, so full green lands on the ink and nothing lands on the pale
        // grey card frame (which is dark enough to tint without it).
        '<feComponentTransfer in="inside" result="mask">' +
        '<feFuncA type="table" tableValues="0 0 0 0.4 1 1"/>' +
        '</feComponentTransfer>' +
        '<feFlood flood-color="#008000" result="ink"/>' +
        '<feComposite in="ink" in2="mask" operator="in" result="green"/>' +
        '<feComposite in="green" in2="SourceGraphic" operator="over"/>' +
        '</filter></svg>';

    function ensureSuitFilters() {
        // Idempotent by id, which also means a holder left behind by a previous
        // extension context is reused rather than duplicated. Safe: it is inert
        // markup with no timers or listeners to have gone stale.
        if (document.getElementById("gpe-suit-filters") || !document.body) return;
        const holder = document.createElement("div");
        holder.id = "gpe-suit-filters";
        holder.innerHTML = SUIT_FILTER_SVG;
        document.body.appendChild(holder);
    }

    // ---------- card backs ----------
    // A player's two face-down cards are ONE 23x26 image on gpokr, not two: the
    // pair, the rear card peeking out up-and-left, and the soft grey halo they
    // sit on, all in a single asset drawn once per seat. So swapping the back
    // means swapping that whole little still life, and a replacement has to keep
    // the same footprint or it reads as misaligned rather than as a new deck.
    // tools/make_cardbacks.py draws ours on that geometry, at 4x and from vectors
    // so they stay sharp where there are device pixels to spare. They are original
    // drawings in the idiom of classic casino backs — bordered, an all-over
    // ornamental ground, a center medallion holding a G — rather than any house's
    // artwork, which is trademarked and could not ship here.
    //
    // Unlike the four-color deck this cannot be done with a filter — there is no
    // recoloring of the site's back that yields a *different design* — so it is
    // the one place we do change the site's DOM, by pointing the <img> at a
    // bundled PNG. GWT owns that element and re-sets its src whenever it
    // re-renders a seat, so the swap is re-applied on mutation rather than once.
    // That settles rather than oscillating: our own write fires the observer
    // again, sees the src already correct, and stops.
    const CARD_BACK_STYLES = ["rosette", "lattice", "fan", "deco"];
    // "" is a real choice, not a fallback: it means gpokr's own back.
    const CARD_BACK_LABELS = { "": "classic (site)", rosette: "rosette (red)", lattice: "lattice (blue)", fan: "fan (green)", deco: "deco (gold)" };
    // FNV-1a/32 of the base64 payload of gpokr's own back, the same way the deck
    // faces are keyed (see DECK_HASHES). Recognizing it exactly is what keeps us
    // from swapping some other 23x26 image that happens to be on the page.
    const SITE_BACK_HASH = "adf3d312";
    // The site's own back measures this. Ours are drawn at 4x (see
    // tools/make_cardbacks.py) so they stay sharp on HiDPI, which only works
    // because the <img> display size is pinned: GWT does set width/height
    // attributes, but a 4x image on an unpinned <img> would render four times
    // too big, so the swap pins them itself rather than trusting that.
    const SITE_BACK_W = 23, SITE_BACK_H = 26;
    // Matches a src we put there ourselves, so re-entry is cheap to detect.
    const OUR_BACK_RE = /\/assets\/backs\/([a-z]+)\.png(?:[?#].*)?$/;

    // Bundled-file URL, resolved the same two ways as assetAudioUrl(): relative
    // to this script where gpokr hosts the tools itself, and via the extension
    // otherwise. assets/* is already web-accessible, so no manifest change.
    function cardBackUrl(style) {
        const path = "assets/backs/" + style + ".png";
        if (SELF_SRC) return SELF_SRC.replace(/[^/]*$/, "") + path;
        try { return chrome.runtime.getURL(path); } catch (e) { return null; }
    }

    // Point one back <img> at whichever back is currently chosen, or put the
    // site's own back on it again. Cheap to call repeatedly: the memo below
    // folds in CARD_BACK, so a settings change re-examines every image while an
    // unchanged one costs a string compare.
    function styleCardBack(img) {
        const src = img.getAttribute("src") || "";
        const memo = src + "|" + CARD_BACK;
        if (memo === img._gpeBackMemo) return;

        if (OUR_BACK_RE.test(src)) {
            // Already swapped. Follow a changed choice, and restore the site's
            // own back when the choice is cleared — which is only possible
            // because we stashed it before overwriting it.
            const want = CARD_BACK ? cardBackUrl(CARD_BACK) : img._gpeSiteBack;
            if (want && want !== src) { img.setAttribute("src", want); return; }
            img._gpeBackMemo = memo;
            return;
        }
        // Not ours. Only gpokr's own back is a candidate, identified by hash so
        // no other image can be caught by mistake.
        const m = DATA_URI_B64.exec(src);
        if (!m || fnv1a32(m[1]) !== SITE_BACK_HASH) { img._gpeBackMemo = memo; return; }
        img._gpeSiteBack = src;   // the only copy we keep, for putting it back
        // Measured while the site's own back is still in place; falls back to the
        // known asset size when the image hasn't decoded yet.
        img._gpeBackW = img.naturalWidth || SITE_BACK_W;
        img._gpeBackH = img.naturalHeight || SITE_BACK_H;
        img._gpeBackMemo = memo;
        if (!CARD_BACK) return;
        const url = cardBackUrl(CARD_BACK);
        if (!url) return;
        // Pin first, then swap, so the oversized image is never laid out raw.
        img.setAttribute("width", String(img._gpeBackW));
        img.setAttribute("height", String(img._gpeBackH));
        img.setAttribute("src", url);
    }

    // ---------- rendering shared hands ----------
    // The site publishes every card as a plain image, keyed exactly the way
    // parseCard already spells them: rank uppercase, suit lowercase ("Ah", "Th",
    // "5h"). Verified all 52 resolve, image/png, cached a year.
    //
    // This replaced a learned store. The site draws its own cards as data: URIs,
    // so there was no URL to read and the extension used to correlate the game log
    // with the images in your seat to bank the base64 — which meant a card you had
    // never personally been dealt could not be drawn at all (shared hands fell back
    // to text), and v1 of that store was poisoned by learning from other players'
    // showdowns. A canonical URL makes both failure modes impossible.
    const CARD_IMG_BASE = "https://img.iogc.org/GPokr/cards/";
    function cardImageUrl(card) { return CARD_IMG_BASE + card + ".png"; }

    // Text card, styled with the suit glyph. No longer the common case — it is the
    // fallback for an image that will not load (offline, 404, blocked).
    function makeTextCardEl(card) {
        const rank = card[0], suit = card[1];
        const div = document.createElement("div");
        div.className = "gpe-shared-card gpe-text-card gpe-suit-" + suit;
        div.textContent = (RANK_LABEL[rank] || rank) + (SUIT_GLYPH[suit] || "");
        return div;
    }

    function makeCardEl(card) {
        if (!/^[2-9TJQKA][cdhs]$/.test(card)) return makeTextCardEl(card);
        const img = document.createElement("img");
        img.className = "gpe-shared-card";
        img.alt = card;
        // What the four-color deck selects on. stampCardImg would derive the same
        // value from the URL, but setting it here means it is right on the first
        // frame rather than on the first mutation.
        img.dataset.gpeCard = card;
        // Swap in the text card if the image never arrives, so a blocked or offline
        // fetch degrades to what this used to draw rather than to a gap.
        img.addEventListener("error", () => {
            if (img.parentNode) img.parentNode.replaceChild(makeTextCardEl(card), img);
        }, { once: true });
        img.src = cardImageUrl(card);
        return img;
    }

    // A small caption pinned under the shared cards, naming the made hand.
    function appendHandLabel(wrap, label) {
        if (!label) return;
        const capEl = document.createElement("div");
        capEl.className = "gpe-hand-label";
        capEl.textContent = label;
        wrap.appendChild(capEl);
    }

    // Winner of the just-ended hand and, if they showed, their cards — both from
    // the current hand's log ("NAME wins main|side pot $N", "NAME shows [..]").

    // name -> seat index (from iogc-PlayerPanelN); button seat from gpokr-Dealer-N.
    function seatNameMap() {
        const map = {};
        document.querySelectorAll('table[class*="iogc-PlayerPanel"]').forEach((p) => {
            if (p.getBoundingClientRect().width === 0) return;
            const m = (typeof p.className === "string" ? p.className : "").match(/iogc-PlayerPanel(\d+)/);
            const nm = p.querySelector(".iogc-PlayerPanel-name");
            const name = nm && nm.textContent.trim();
            if (m && name) map[name] = parseInt(m[1], 10);
        });
        return map;
    }
    function buttonSeatIndex() {
        const d = document.querySelector('[class*="gpokr-Dealer-"]');
        const m = d && (typeof d.className === "string" ? d.className : "").match(/gpokr-Dealer-(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    // {sb, bb} from the status label "$25 / $50" (first is small, second big).
    function parseBlinds() {
        const el = document.querySelector(".iogc-GameWindow-status");
        const m = el && el.textContent.match(/\$\s*([\d,]+)\s*\/\s*\$\s*([\d,]+)/);
        const n = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;
        return m ? { sb: n(m[1]), bb: n(m[2]) } : { sb: 0, bb: 0 };
    }

    // Full breakdown of the just-ended hand for the expandable detail table.
    // Bet amounts are reconstructed: bets/raises carry amounts in the log, calls
    // don't (inferred as the current amount-to-match), and blinds aren't logged
    // (seeded to SB/BB = the occupied seats clockwise after the button). Assumes
    // "raises $N" is the raise-TO total. -> approximate, but sums to the pot.
    // `snap` is a hand snapshot (see handSnapshot); omitted, everything is read
    // live for the hand in progress.
    function parseHandDetail(snap) {
        const scope = (snap && snap.scope) || fullHandScope(); // complete hand, even if the DOM log trimmed early lines
        const num = (s) => parseInt(String(s).replace(/,/g, ""), 10) || 0;
        const seatOf = (snap && snap.seatOf) || seatNameMap();
        const P = {}, order = [];
        const rec = (n) => {
            if (!P[n]) { P[n] = { name: n, streets: [0, 0, 0, 0], foldStreet: null, cards: null }; order.push(n); }
            return P[n];
        };

        // Pass 1: who was dealt in (anyone who acted).
        const actionRe = /^(.+?) (?:folds|checks|calls|bets \$[\d,]+|raises \$[\d,]+|shows \[)/i;
        for (const line of scope) { const m = line.match(actionRe); if (m) rec(m[1].trim()); }
        if (!order.length) return null;

        // Blinds: SB = first occupied seat clockwise after the button, BB = next.
        const { sb, bb } = (snap && snap.blinds) || parseBlinds();
        const btnSeat = snap ? snap.btnSeat : buttonSeatIndex();
        let sbName = null, bbName = null, btnName = null;
        const seated = order.filter((n) => seatOf[n] != null).sort((a, b) => seatOf[a] - seatOf[b]);
        if (btnSeat != null && seated.length) {
            btnName = seated.find((n) => seatOf[n] === btnSeat) || null;
            let fa = seated.findIndex((n) => seatOf[n] > btnSeat);
            if (fa < 0) fa = 0; // wrap past the highest seat
            const rot = seated.slice(fa).concat(seated.slice(0, fa)); // clockwise after the button
            if (seated.length === 2 && btnName) { sbName = btnName; bbName = rot.find((n) => n !== btnName) || null; }
            else { sbName = rot[0] || null; bbName = rot[1] || null; }
        }

        // Pass 2: reconstruct per-street contributions.
        let street = 0, toMatch = 0;
        const streetIn = {};
        const lastAgg = [null, null, null, null]; // last bettor/raiser per street (uncalled bets return to them)
        if (bb) {
            toMatch = bb;
            if (sbName) { rec(sbName).streets[0] += sb; streetIn[sbName] = sb; }
            if (bbName) { rec(bbName).streets[0] += bb; streetIn[bbName] = bb; }
        }
        let winner = "", winAmt = 0, winHand = "";
        for (const line of scope) {
            let m;
            if ((m = line.match(/^Dealing (flop|turn|river)/i))) {
                street = ["flop", "turn", "river"].indexOf(m[1].toLowerCase()) + 1;
                toMatch = 0; for (const k in streetIn) delete streetIn[k];
                continue;
            }
            if ((m = line.match(/^(.+?) folds$/i))) { const r = rec(m[1].trim()); if (r.foldStreet == null) r.foldStreet = street; continue; }
            if (/ checks$/i.test(line)) continue;
            if ((m = line.match(/^(.+?) calls$/i))) {
                const n = m[1].trim(), add = Math.max(0, toMatch - (streetIn[n] || 0));
                streetIn[n] = (streetIn[n] || 0) + add; rec(n).streets[street] += add; continue;
            }
            if ((m = line.match(/^(.+?) (?:bets|raises) \$([\d,]+)$/i))) {
                const n = m[1].trim(), to = num(m[2]), add = Math.max(0, to - (streetIn[n] || 0));
                streetIn[n] = to; toMatch = Math.max(toMatch, to); rec(n).streets[street] += add;
                lastAgg[street] = n; continue;
            }
            if ((m = line.match(/^(.+?) shows \[([^,\]]+),\s*([^\]]+)\]/i))) { rec(m[1].trim()).cards = [normCard(m[2]), normCard(m[3])]; continue; }
            if ((m = line.match(/^(.+?) wins (?:main|side) pot \$([\d,]+)/i))) { const n = m[1].trim(); if (!winner) winner = n; winAmt += num(m[2]); }
        }
        // Winner's made-hand name from their "shows [..] for <hand>" line.
        if (winner) {
            for (const line of scope) {
                const m = line.match(/^(.+?) shows \[[^\]]*\] for (.+)$/i);
                if (m && m[1].trim() === winner) { winHand = m[2].trim(); break; }
            }
        }

        // Return uncalled bets: the last aggressor on a street only contributes up
        // to the most any other player put in that street; the excess is returned
        // (not in the pot). Blinds/limps never trigger this (no aggressor).
        for (let s = 0; s < 4; s++) {
            const agg = lastAgg[s];
            if (!agg) continue;
            let otherMax = 0;
            for (const n of order) if (n !== agg && P[n].streets[s] > otherMax) otherMax = P[n].streets[s];
            if (P[agg].streets[s] > otherMax) P[agg].streets[s] = otherMax;
        }

        // Board + my hole cards, from the same complete scope. boardFromScope
        // keeps only the latest hand's streets (and caps at 5) so a table-switch
        // log merge can't render a 6- or 7-card board.
        const board = boardFromScope(scope);
        const mine = myHandFromScope(scope);
        const myCards = mine ? [normCard(mine[0]), normCard(mine[1])] : null;

        // Cards a peer revealed with our own share feature, for players the log
        // never showed. Only id-bound reveals are eligible (decodeHand has checked
        // the sender and the hand id), so a pasted or replayed hand can't write
        // cards into someone else's row.
        const peers = peerRevealsFor(snap && snap.gameId);
        if (peers) for (const n of order) if (!P[n].cards && peers.has(n)) P[n].cards = peers.get(n);

        const players = order.map((n) => ({
            name: n, cards: P[n].cards, foldStreet: P[n].foldStreet, streets: P[n].streets,
            total: P[n].streets.reduce((a, b) => a + b, 0), isButton: n === btnName,
        })).sort((a, b) => (seatOf[a.name] != null ? seatOf[a.name] : 99) - (seatOf[b.name] != null ? seatOf[b.name] : 99));

        return { winner, winAmt, winHand, players, board, myCards: myCards ? myCards.slice(0, 2) : null };
    }

    const STREET_LABELS = ["Pre", "Flop", "Turn", "River"];

    // The collapsible per-player betting table (hidden until the arrow is clicked).
    function buildHandDetailTable(detail) {
        const wrap = document.createElement("div");
        wrap.className = "gpe-log-detail";
        wrap.hidden = true;
        const cell = (txt, cls) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = txt; return s; };

        const head = document.createElement("div");
        head.className = "gpe-log-drow gpe-log-dhead";
        head.appendChild(cell(""));       // name column
        head.appendChild(cell("Cards"));
        STREET_LABELS.concat(["Total"]).forEach((t) => head.appendChild(cell(t, "gpe-log-dnum"))); // money cols right-aligned
        wrap.appendChild(head);

        detail.players.forEach((p) => {
            const row = document.createElement("div");
            row.className = "gpe-log-drow";
            const nameCell = document.createElement("span");
            nameCell.className = "gpe-log-dname";
            const nameText = document.createElement("span");
            nameText.className = "gpe-log-dname-text";
            nameText.textContent = p.name;
            nameText.title = p.name; // full name on hover when truncated
            nameCell.appendChild(nameText);
            if (p.isButton) {
                const b = document.createElement("span");
                b.className = "gpe-log-btn"; b.textContent = "D"; b.title = "dealer button";
                nameCell.appendChild(b);
            }
            row.appendChild(nameCell);

            // Always two card positions; empty placeholders when not shown.
            const cards = document.createElement("span");
            cards.className = "gpe-log-dcards";
            for (let i = 0; i < 2; i++) {
                if (p.cards && p.cards[i]) cards.appendChild(makeCardEl(p.cards[i]));
                else { const slot = document.createElement("span"); slot.className = "gpe-shared-card gpe-log-slot"; cards.appendChild(slot); }
            }
            row.appendChild(cards);

            for (let s = 0; s < 4; s++) {
                const parts = [];
                if (p.streets[s] > 0) parts.push("$" + p.streets[s].toLocaleString());
                if (p.foldStreet === s) parts.push("🏳️");
                row.appendChild(cell(parts.join(" ") || "·", "gpe-log-dnum"));
            }
            row.appendChild(cell("$" + p.total.toLocaleString(), "gpe-log-dnum gpe-log-dtot"));
            wrap.appendChild(row);
        });
        return wrap;
    }

    // Runner-up of a hand I won, so the third column shows someone else's cards
    // instead of repeating mine. Best shown hand among the other players (by the
    // evaluator); if nobody showed, whoever stayed in longest. Returns a player
    // from detail.players, or null.
    function findRunnerUp(detail, board) {
        const others = detail.players.filter((p) => p.name !== detail.winner);
        if (!others.length) return null;
        const shown = others.filter((p) => p.cards && p.cards.length === 2);
        const O = window.GPE_ODDS;
        if (shown.length > 1 && O && board.length >= 3) {
            let best = null, bestScore = -1;
            for (const p of shown) {
                let score;
                try { score = O.evaluateBest(p.cards.concat(board).map(O.cardToInt)); } catch (e) { continue; }
                if (score > bestScore) { bestScore = score; best = p; }
            }
            if (best) return best;
        }
        if (shown.length) return shown[0];
        // Nobody else showed: whoever folded latest (never folded outranks any fold).
        const depth = (p) => (p.foldStreet == null ? 9 : p.foldStreet);
        return others.slice().sort((a, b) => depth(b) - depth(a))[0];
    }

    // Build the just-ended hand's summary: a "winner wins $x with <hand>" header,
    // the You / Board / 🏆 winner card columns, an arrow that expands a per-player
    // betting breakdown. When I'm the winner the trophy moves onto my own column
    // and the third column becomes the runner-up. Returns the element (or null).
    // Local view only.
    function buildHandSummaryRow(snap) {
        const detail = parseHandDetail(snap);
        // Prefer the detail's complete-scope reads (survive log trimming); fall back
        // to the snapshot, and only then to the live log.
        const scope = snap ? snap.scope : null;
        const fallbackMine = scope ? myHandFromScope(scope) : readMyHand();
        const mine = (detail && detail.myCards) ? detail.myCards : (fallbackMine || []).map(normCard);
        const board = detail ? detail.board : (scope ? boardFromScope(scope) : parseBoard());
        const win = detail && detail.winner ? detail : null;
        if (!mine.length && !board.length && !win) return null; // nothing to show
        const me = getMyName();
        const iWon = !!(win && me && win.winner === me);
        const runnerUp = iWon ? findRunnerUp(win, board) : null;
        const winnerCards = win ? ((win.players.find((p) => p.name === win.winner) || {}).cards) : null;

        const panel = document.createElement("div");
        panel.className = "gpe-log-cards gwt-HTML";

        if (win) {
            const h = document.createElement("div");
            h.className = "gpe-log-win";
            h.textContent = win.winner + " wins $" + win.winAmt.toLocaleString() + (win.winHand ? " with " + win.winHand : "");
            panel.appendChild(h);
        }

        const cardRow = document.createElement("div");
        cardRow.className = "gpe-log-cardrow";
        const emptySlot = () => { const s = document.createElement("span"); s.className = "gpe-shared-card gpe-log-slot"; return s; };
        const col = (label, cards, slots) => {
            const c = document.createElement("div"); c.className = "gpe-log-col";
            const head = document.createElement("div"); head.className = "gpe-log-colhead"; head.textContent = label; head.title = label; c.appendChild(head);
            const g = document.createElement("div"); g.className = "gpe-log-cards-group";
            const n = Math.max(slots, (cards || []).length);
            for (let i = 0; i < n; i++) g.appendChild(cards && cards[i] ? makeCardEl(cards[i]) : emptySlot());
            c.appendChild(g); cardRow.appendChild(c);
        };
        col(iWon ? "🏆 You" : "You", mine, 2);
        col("Board", board, 5);
        if (iWon) col(runnerUp ? "🥈 " + runnerUp.name : "🥈", runnerUp ? runnerUp.cards : null, 2);
        else col(win ? "🏆 " + win.winner : "🏆", winnerCards, 2);

        // A "more" column after the winner, matching the other headers, whose
        // button expands the per-player detail. Collapsed by default.
        let detailEl = null;
        if (detail && detail.players.length) {
            detailEl = buildHandDetailTable(detail); // hidden initially (see CSS [hidden])
            const moreCol = document.createElement("div");
            moreCol.className = "gpe-log-col gpe-log-morecol";
            const moreHead = document.createElement("div");
            moreHead.className = "gpe-log-colhead";
            moreHead.textContent = "more";
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "gpe-log-toggle";
            toggle.textContent = "▸";
            toggle.title = "show per-player betting";
            toggle.addEventListener("click", (e) => {
                e.preventDefault();
                const open = detailEl.hasAttribute("hidden");
                if (open) detailEl.removeAttribute("hidden"); else detailEl.setAttribute("hidden", "");
                toggle.textContent = open ? "▾" : "▸";
            });
            moreCol.appendChild(moreHead);
            moreCol.appendChild(toggle);
            cardRow.appendChild(moreCol);
        }
        panel.appendChild(cardRow);
        if (detailEl) panel.appendChild(detailEl);
        return panel;
    }

    // The finished-hand summary, captured at hand end and dropped into the log
    // when the next hand starts. The log draws a ".seperator" line between hands;
    // we replace the most recent one with the summary panel so it sits exactly at
    // the hand boundary (and doubles as the divider). Older summaries stay put, so
    // you can scroll back. Falls back to inserting before the new "Starting Hand".
    let pendingLogSummary = null;

    // Everything the summary is built from, frozen at the end of the hand. Held so
    // the panel can be rebuilt later, when the log has moved on to the next hand
    // and none of this could be read again.
    function handSnapshot() {
        return {
            epoch: handEpoch,
            scope: fullHandScope().slice(),
            seatOf: seatNameMap(),
            btnSeat: buttonSeatIndex(),
            blinds: parseBlinds(),
            gameId: currentGameId(),
        };
    }

    // Cards peers revealed through our share feature, keyed by hand id. Separate
    // from the log's own "shows [..]" lines and only ever written by a reveal that
    // passed decodeHand's sender+hand-id checks.
    const peerReveals = new Map();     // gameId -> Map(name -> [c1, c2])
    function peerRevealsFor(gameId) {
        return gameId == null ? null : peerReveals.get(String(gameId)) || null;
    }
    function notePeerReveal(gameId, name, cards) {
        if (gameId == null || !name || !cards || cards.length !== 2) return false;
        const key = String(gameId);
        let m = peerReveals.get(key);
        if (!m) { m = new Map(); peerReveals.set(key, m); }
        if (m.has(name)) return false;
        m.set(name, cards);
        if (peerReveals.size > 8) peerReveals.delete(peerReveals.keys().next().value); // keep a few hands
        return true;
    }

    // A hand is "over" well before everything about it is known: gpokr reveals
    // showdown hands a beat apart, a hand won without a showdown can be shown
    // voluntarily afterwards, and a peer's "share last hand" arrives whenever they
    // click it — sometimes after the next hand has started. So the summary is not a
    // one-shot capture: while any of that is still landing it gets rebuilt, in place
    // if it has already been dropped into the log.
    let summarySnap = null;
    let summaryEl = null;      // the live panel: pending, or already in the log
    let summarySig = "";       // what it currently reflects
    let summaryEpoch = -1;     // which hand it belongs to
    let handEpoch = 0;         // bumped at every new-hand edge

    // The parts of a hand the panel actually draws. Cheap to compare, and changes
    // exactly when a rebuild would look different — including the pot line, which
    // can arrive after the first reveal.
    function summarySignature(snap) {
        const parts = [];
        for (const line of snap.scope) {
            if (/ shows \[|wins (?:main|side) pot|^Dealing (?:flop|turn|river)/i.test(line)) parts.push(line);
        }
        const peers = peerRevealsFor(snap.gameId);
        if (peers) for (const [n, c] of peers) parts.push("peer:" + n + ":" + c.join(""));
        return parts.join("|");
    }

    // fromLive: re-read the hand from the log (only valid while it's still the most
    // recent one). Otherwise the stored snapshot is reused, which is what a late
    // peer reveal needs.
    function refreshHandSummary(fromLive) {
        if (!HAND_SUMMARY) return;
        if (fromLive) summarySnap = handSnapshot();
        const snap = summarySnap;
        if (!snap) return;
        const sig = summarySignature(snap);
        // Whether the panel we're holding is this snapshot's, NOT whether a new hand
        // has begun: a reveal that lands during the next hand still belongs to the
        // old panel and has to patch it where it sits.
        const newHand = summaryEpoch !== snap.epoch;
        if (!newHand && summaryEl && sig === summarySig) return; // nothing new to draw
        const el = buildHandSummaryRow(snap);
        if (!el) return;
        if (!newHand && summaryEl && summaryEl.isConnected) {
            // Already in the log: swap it in place, carrying over whether the
            // per-player breakdown was expanded so a rebuild doesn't shut it.
            if (summaryEl.querySelector(".gpe-log-detail:not([hidden])")) {
                const d = el.querySelector(".gpe-log-detail");
                const t = el.querySelector(".gpe-log-toggle");
                if (d) d.removeAttribute("hidden");
                if (t) t.textContent = "▾";
            }
            summaryEl.replaceWith(el);
        } else {
            pendingLogSummary = el;   // goes in when the next hand starts
        }
        summaryEl = el;
        summarySig = sig;
        summaryEpoch = snap.epoch;
    }

    function flushPendingLogSummary() {
        if (!pendingLogSummary) return;
        const container = document.querySelector(".iogc-MessagePanel-messages");
        if (!container) { pendingLogSummary = null; return; }
        const seps = container.querySelectorAll(".seperator");
        const lastSep = seps.length ? seps[seps.length - 1] : null;
        if (lastSep && lastSep.parentNode) {
            lastSep.parentNode.replaceChild(pendingLogSummary, lastSep);
        } else {
            const rows = Array.from(container.querySelectorAll("div.gwt-HTML"));
            let anchor = null;
            for (let i = rows.length - 1; i >= 0; i--) {
                if (/Starting Hand/i.test(rows[i].textContent)) { anchor = rows[i]; break; }
            }
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(pendingLogSummary, anchor);
            else container.appendChild(pendingLogSummary);
        }
        // The panel is taller than the separator it replaced, so re-scroll to the
        // bottom (the log's scroller may be the container or an ancestor).
        let sc = container;
        for (let i = 0; sc && sc !== document.body && i < 6; i++, sc = sc.parentElement) {
            if (sc.scrollHeight - sc.clientHeight > 1) { sc.scrollTop = sc.scrollHeight; break; }
        }
        pendingLogSummary = null;
    }

    const handOverlays = new Map(); // player name -> overlay
    function showHandForName(name, cards, label) {
        if (!name || !cards || !cards.length) return;
        const prev = handOverlays.get(name);
        if (prev && prev.isConnected) prev.remove();
        const wrap = document.createElement("div");
        wrap.className = "gpe-hand-wrap";
        wrap.style.position = "fixed";
        wrap.style.transform = "translate(-50%, -50%)";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
        appendHandLabel(wrap, label);
        document.body.appendChild(wrap);
        handOverlays.set(name, wrap);

        anchorToAvatar(wrap, () => findAvatarByName(name), HAND_MS);
        void wrap.offsetWidth;
        wrap.classList.add("gpe-show");
        clearTimeout(wrap._gpeTimer);
        wrap._gpeTimer = setTimeout(() => {
            wrap.classList.remove("gpe-show");
            setTimeout(() => wrap.remove(), 250);
        }, HAND_MS);
    }

    // My own username, from the sidebar login panel.
    function getMyName() {
        const el = document.querySelector(".iogc-LoginPanel-nameHeading");
        return el && el.textContent.trim() ? el.textContent.trim() : null;
    }

    // Render my hand locally only (no chat) — anchored to my own avatar by name,
    // exactly like a received share. (Anchoring to the hole-card <img>s broke at
    // hand end, when GWT hides/recycles them for the next hand.)
    function showHandLocal(cards, label) {
        if (!cards || !cards.length) return;
        let wrap = document.getElementById("gpe-local-hand");
        if (wrap) wrap.remove();
        wrap = document.createElement("div");
        wrap.id = "gpe-local-hand";
        wrap.className = "gpe-hand-wrap";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
        appendHandLabel(wrap, label);
        document.body.appendChild(wrap);

        anchorToAvatar(wrap, () => findAvatarByName(getMyName()), HAND_MS);
        void wrap.offsetWidth;
        wrap.classList.add("gpe-show");
        clearTimeout(wrap._gpeTimer);
        wrap._gpeTimer = setTimeout(() => {
            wrap.classList.remove("gpe-show");
            setTimeout(() => wrap.remove(), 250);
        }, HAND_MS);
    }

    // ---------- chat link detection ----------
    // GWT renders chat as plain text; turn any http(s):// or www. URL into a
    // real link. Replaces only matched substrings in text nodes (sender <b> and
    // existing anchors are skipped), so message text and downstream parsing are
    // unchanged (textContent still reads the same).
    const CHAT_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;

    function linkifyTextNode(t) {
        const text = t.nodeValue;
        let m, last = 0, frag = null;
        CHAT_URL_RE.lastIndex = 0;
        while ((m = CHAT_URL_RE.exec(text))) {
            let raw = m[0];
            const trail = raw.match(/[.,!?;:'")\]}>]+$/); // don't swallow trailing punctuation
            const trailing = trail ? trail[0] : "";
            if (trailing) raw = raw.slice(0, -trailing.length);
            const href = /^www\./i.test(raw) ? "https://" + raw : raw;
            let ok = false;
            try { const u = new URL(href); ok = (u.protocol === "http:" || u.protocol === "https:"); } catch (e) {}
            if (!ok) continue; // leave junk as plain text
            if (!frag) frag = document.createDocumentFragment();
            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const a = document.createElement("a");
            a.href = href;
            a.textContent = raw;
            a.target = "_blank";
            a.rel = "noopener noreferrer nofollow";
            a.className = "gpe-chat-link";
            frag.appendChild(a);
            if (trailing) frag.appendChild(document.createTextNode(trailing));
            last = m.index + m[0].length;
        }
        if (frag) {
            frag.appendChild(document.createTextNode(text.slice(last)));
            t.parentNode.replaceChild(frag, t);
        }
    }

    function linkifyChat(node, skipEl) {
        if (node._gpeLinked) return;
        node._gpeLinked = true;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
            acceptNode(t) {
                if (skipEl && skipEl.contains(t)) return NodeFilter.FILTER_REJECT;   // sender name
                if (t.parentNode && t.parentNode.nodeName === "A") return NodeFilter.FILTER_REJECT;
                return /\b(?:https?:\/\/|www\.)/i.test(t.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            },
        });
        const targets = [];
        let n;
        while ((n = walker.nextNode())) targets.push(n);
        targets.forEach(linkifyTextNode);
    }

    // ---------- incoming chat handling ----------
    function handleChatMessage(node) {
        const nameEl = node.querySelector("b");
        if (!nameEl) {
            // Plain (no-sender) lines carry presence: "NAME is here" / "NAME has left".
            const m = node.textContent.trim().match(/^(.+?) (is here|has left)$/);
            if (m) notePresence(m[1].trim(), m[2] === "is here");
            return;
        }
        const name = nameEl.textContent.trim();
        notePresence(name, true); // chatting proves presence — muted or not, they're here
        // Muted: hide the line and stop. Everything below this is something chat
        // DRIVES — emote overlays, shared-hand reveals, reaction controls — and a
        // muted player shouldn't be able to put any of it on screen.
        if (isMuted(name)) { node.classList.add("gpe-muted-line"); return; }
        linkifyChat(node, nameEl); // make URLs clickable (leaves textContent intact)
        const text = node.textContent.slice(nameEl.textContent.length).replace(/^\s*:\s*/, "");

        // Pair this line with the tapped event that explains it, so it can be
        // reacted to and so incoming reactions know where to land. Only possible
        // when the tap is running; without it the line is simply not reactable.
        if (canInteract) {
            const msgId = claimMessageId(node, name, text);
            if (msgId) {
                node._gpeMsgId = msgId;
                node.classList.add("gpe-react-host");
                nodeByMsgId.set(msgId, node);
                addReactionControls(node, msgId);
                renderReactions(msgId);   // reactions can beat the line itself
            }
        }

        // Verify against the sender's name (blocks copy-paste onto another
        // player) and this table's live hand ids (blocks stale/replayed shares).
        const ids = [currentGameId(), curGameId, prevGameId];
        const dec = decodeHand(text, name, ids);
        if (dec) { renderDecoded(name, dec); return; }
        // Looks like a new-format share but didn't verify yet — usually because
        // our hand-id knowledge lags the sender. Retry as the id catches up.
        if (name !== getMyName() && /^shows cards:\s*.+\[[0-9a-z]+\](?:\s*[—-]\s*.+)?\s*$/i.test(text)) {
            stashPendingShare(name, text);
            return;
        }

        const glyph = firstEmoteIn(text);
        if (glyph) showEmoteForName(name, glyph);
    }

    // ---------- chat reactions ----------
    // Reactions are keyed by the server's messageId. The DOM has no such thing —
    // the client renders lines, and its registry drops type-5 events entirely, so
    // an incoming reaction never reaches the pane at all. Both halves therefore
    // depend on pairing each tapped ChatEvent with the line the client renders for
    // it.
    //
    // Pairing is by CONTENT, not arrival order: the pane also carries lines with no
    // event behind them ("NAME is here", our own rendered shares), and matching
    // positionally would silently drift by one and attach every reaction to the
    // wrong message. Unmatched events simply expire.
    const QUICK_REACTIONS = ["👍", "😂", "🔥"];
    // ChatType, read off the client's own dispatch rather than guessed. It renders
    // 1/2/4 itself from the NAME and ignores `message` entirely, which is exactly why
    // an arrive/leave event has a sender and no text:
    //   0 chat   1 arrive ("is here")   2 leave ("has left")
    //   3 system (name may be null)     4 new signup      5 reaction
    // (Confirms the API note for ui2: SYSTEM really is 3 and NEW really is 4.)
    const CHAT_TYPE = { CHAT: 0, ARRIVE: 1, LEAVE: 2, SYSTEM: 3, NEW: 4, REACTION: 5 };
    const REACTION_CHAT_TYPE = CHAT_TYPE.REACTION;
    const PENDING_CHAT_MAX = 40;
    const PENDING_CHAT_MS = 15000;     // an event whose line never arrived

    let pendingChat = [];              // tapped events awaiting their DOM line
    const nodeByMsgId = new Map();     // messageId -> the line's element
    const reactionsByMsgId = new Map();// messageId -> Map(emoji -> Set(name))

    // What to show for an event. Presence and system events carry no message text —
    // the client composes their wording from the name alone — so rendering them as
    // "NAME:" with an empty body (which is what the popout did) is simply wrong.
    function chatLineFor(ev) {
        const name = String(ev.name || "");
        const text = String(ev.message || "");
        switch (Number(ev.type)) {
            case CHAT_TYPE.CHAT:   return { name: name, text: text, msgId: Number(ev.messageId) || 0 };
            case CHAT_TYPE.ARRIVE: return { name: "", text: name + " is here" };
            case CHAT_TYPE.LEAVE:  return { name: "", text: name + " has left" };
            case CHAT_TYPE.NEW:    return { name: "", text: name + " has signed up. Welcome " + name + "!" };
            case CHAT_TYPE.SYSTEM: return { name: "", text: name ? name + ": " + text : text };
            default:               return text ? { name: name, text: text } : null;  // unknown + empty: skip
        }
    }

    function onChatEvent(ev) {
        const msgId = Number(ev.messageId) || 0;
        if (Number(ev.type) === REACTION_CHAT_TYPE) {
            noteReaction(Number(ev.targetMessageId) || 0, ev.message, ev.name);
            return;
        }
        // The popout renders from here, not from the DOM, so it gets every message
        // the server sent us — including ones the pane may have scrolled away.
        const line = chatLineFor(ev);
        if (line) noteChatLine(line);
        if (!msgId) return;   // pre-upgrade server: nothing to react to
        // Only real chat is reactable: the point of pairing a line to a messageId is
        // reacting to what someone SAID, not to them walking in or out.
        if (Number(ev.type) !== CHAT_TYPE.CHAT) return;
        pendingChat.push({ msgId, name: String(ev.name || ""), text: String(ev.message || ""), at: Date.now() });
        const cutoff = Date.now() - PENDING_CHAT_MS;
        pendingChat = pendingChat.filter((p) => p.at >= cutoff).slice(-PENDING_CHAT_MAX);
    }

    // Claim the tapped event that best explains this line. Same sender AND the
    // line contains the event's text, newest first — repeated identical messages
    // ("ok", "gg") are common, so the newest unclaimed one is the right guess.
    function claimMessageId(node, name, text) {
        for (let i = pendingChat.length - 1; i >= 0; i--) {
            const p = pendingChat[i];
            if (p.name !== name) continue;
            if (p.text && text.indexOf(p.text) < 0) continue;
            pendingChat.splice(i, 1);
            return p.msgId;
        }
        return 0;
    }

    function noteReaction(msgId, emoji, who) {
        if (!msgId || typeof emoji !== "string" || !emoji) return;
        let byEmoji = reactionsByMsgId.get(msgId);
        if (!byEmoji) { byEmoji = new Map(); reactionsByMsgId.set(msgId, byEmoji); }
        let names = byEmoji.get(emoji);
        if (!names) { names = new Set(); byEmoji.set(emoji, names); }
        names.add(String(who || "?"));
        renderReactions(msgId);
        updatePopoutReactions(msgId);
    }

    // Badges live in one trailing span, rebuilt wholesale — simpler than diffing,
    // and the counts are tiny. Inline, so a reacted line stays one line.
    function renderReactions(msgId) {
        const node = nodeByMsgId.get(msgId);
        if (!node || !node.isConnected) return;
        const byEmoji = reactionsByMsgId.get(msgId);
        let bar = node.querySelector(":scope > .gpe-react-bar");
        if (!byEmoji || !byEmoji.size) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = document.createElement("span");
            bar.className = "gpe-react-bar";
            node.appendChild(bar);
        }
        bar.textContent = "";
        const me = getMyName();
        for (const [emoji, names] of byEmoji) {
            const b = document.createElement("span");
            b.className = "gpe-react-badge";
            if (me && names.has(me)) b.classList.add("gpe-react-mine");
            b.textContent = names.size > 1 ? emoji + " " + names.size : emoji;
            b.title = Array.from(names).join(", ");
            bar.appendChild(b);
        }
    }

    // The hover strip: quick picks plus the full emote picker for everything else.
    function addReactionControls(node, msgId) {
        if (node.querySelector(":scope > .gpe-react-add")) return;
        const add = document.createElement("span");
        add.className = "gpe-react-add";
        for (const emoji of QUICK_REACTIONS) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "gpe-react-quick";
            b.textContent = emoji;
            b.title = "react with " + emoji;
            b.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                sendReaction(msgId, emoji);
            });
            add.appendChild(b);
        }
        const more = document.createElement("button");
        more.type = "button";
        more.className = "gpe-react-quick gpe-react-more";
        more.textContent = "➕";
        more.title = "react with any emoji";
        more.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            openReactionPicker(more, msgId);
        });
        add.appendChild(more);
        node.appendChild(add);
    }

    // Reuses the emote picker's panel shape rather than inventing a second one.
    let reactionPicker = null;
    function openReactionPicker(anchorEl, msgId) {
        if (!reactionPicker || !reactionPicker.isConnected) {
            const panel = document.createElement("div");
            panel.id = "gpe-react-panel";
            EMOTES.forEach((glyph) => {
                const b = document.createElement("button");
                b.type = "button";
                b.textContent = glyph;
                b.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    sendReaction(panel._gpeMsgId, glyph);
                    panel.classList.remove("gpe-open");
                });
                panel.appendChild(b);
            });
            document.body.appendChild(panel);
            reactionPicker = panel;
        }
        const panel = reactionPicker;
        panel._gpeMsgId = msgId;
        panel.classList.add("gpe-open");
        const r = anchorEl.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        // Prefer above the line: the chat pane sits at the bottom of the window.
        panel.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pr.width - 4)) + "px";
        panel.style.top = (r.top - pr.height - 6 > 4 ? r.top - pr.height - 6 : r.bottom + 6) + "px";
    }

    document.addEventListener("mousedown", (e) => {
        if (!reactionPicker || !reactionPicker.classList.contains("gpe-open")) return;
        if (reactionPicker.contains(e.target) || (e.target.classList && e.target.classList.contains("gpe-react-more"))) return;
        reactionPicker.classList.remove("gpe-open");
    });

    // Optimistic, unlike a throw: a reaction has no animation to be honest about,
    // the badge IS the feedback, and the echo simply confirms what we drew. The
    // server has no rate limit here (parity with chat), so a failed send just
    // leaves the optimistic badge to be corrected by reality on the next event.
    function sendReaction(msgId, emoji) {
        if (!msgId || !emoji) return;
        const me = getMyName();
        if (me) noteReaction(msgId, emoji, me);
        sendReactionViaBridge(msgId, emoji);
    }

    // Lines already in the pane when we start. The tap runs from document_start but
    // content.js only at document_idle, so the events for the first second or two of
    // chat are sitting in pendingChat while their lines are already on screen — the
    // MutationObserver will never see those. Stamp them here.
    //
    // Stamping ONLY: handleChatMessage also fires emote overlays and renders shares,
    // and replaying that over existing lines would pop overlays for messages the
    // user already watched arrive.
    // Hide (or bring back) every line already in the pane. Class-based rather than
    // removing the node: the site owns those elements, and unmuting has to be able
    // to put the conversation back exactly as it was.
    function applyMuteToChatPane() {
        for (const node of document.querySelectorAll(".iogc-ChatPanel-messages div.gwt-HTML")) {
            const nameEl = node.querySelector("b");
            const name = nameEl ? nameEl.textContent.trim() : "";
            node.classList.toggle("gpe-muted-line", !!name && isMuted(name));
        }
    }

    function stampExistingChatLines() {
        if (!canInteract) return;
        for (const node of document.querySelectorAll(".iogc-ChatPanel-messages div.gwt-HTML")) {
            if (node._gpeMsgId) continue;
            const nameEl = node.querySelector("b");
            if (!nameEl) continue;   // presence lines have no sender and no event
            const name = nameEl.textContent.trim();
            if (isMuted(name)) { node.classList.add("gpe-muted-line"); continue; }
            const text = node.textContent.slice(nameEl.textContent.length).replace(/^\s*:\s*/, "");
            const msgId = claimMessageId(node, name, text);
            if (!msgId) continue;
            node._gpeMsgId = msgId;
            node.classList.add("gpe-react-host");
            nodeByMsgId.set(msgId, node);
            addReactionControls(node, msgId);
            renderReactions(msgId);
        }
    }

    function watchChat() {
        const chat = document.querySelector(".iogc-ChatPanel-messages");
        if (!chat) return false;
        if (chat._gpeWatched) {
            stampExistingChatLines();   // canInteract may only have arrived just now
            return true;
        }
        chat._gpeWatched = true;
        stampExistingChatLines();
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const added of m.addedNodes) {
                    if (added.nodeType !== 1) continue;
                    const htmls = added.matches && added.matches("div.gwt-HTML")
                        ? [added]
                        : added.querySelectorAll ? added.querySelectorAll("div.gwt-HTML") : [];
                    htmls.forEach(handleChatMessage);
                }
            }
        });
        observer.observe(chat, { childList: true, subtree: true });
        return true;
    }

    // ---------- per-hand harvest (player stats; one-shot per hand) ----------
    // Observed log line shapes (live-sampled): "NAME folds", "NAME checks",
    // "NAME calls" (no amount), "NAME bets $N", "NAME raises $N",
    // "NAME wins main|side pot $N", "NAME shows [..] for <hand>".
    // Names may contain spaces. Blinds are never logged.
    function harvestHand(lines) {
        updatePlayerStats(lines);
        recordSessionPoint();
    }

    // ---------- session tracker (my stack after each hand) ----------
    // Read-modify-write so a "reset" from the popup never gets clobbered.
    const SESSION_KEY = "gpe_session";
    const SESSION_MAX_POINTS = 500;
    function recordSessionPoint() {
        const stack = myStack();
        if (!stack || !EXT_STORE) return; // not seated / no extension storage
        // try/catch: orphaned contexts (extension updated under an open tab)
        // throw "context invalidated" here on their next poll.
        try {
            EXT_STORE.get([SESSION_KEY], (res) => {
                const s = res[SESSION_KEY] || { startedAt: Date.now(), points: [] };
                s.points.push(stack);
                if (s.points.length > SESSION_MAX_POINTS) s.points = s.points.slice(-SESSION_MAX_POINTS);
                try { EXT_STORE.set({ [SESSION_KEY]: s }); } catch (e) {}
            });
        } catch (e) {}
    }

    // Betting streets stored as integers: index into STREETS. `street` on an
    // action is 0=preflop, 1=flop, 2=turn, 3=river (null if unknown/legacy).
    const STREETS = ["preflop", "flop", "turn", "river"];
    function streetToInt(v) {
        if (typeof v === "number") return v;
        const i = STREETS.indexOf(v);
        return i >= 0 ? i : null;
    }
    const STAT_VERSION = 3;

    // A fresh per-player stats record. `betHands` is a rolling window of the
    // last BET_HISTORY_MAX hands; each entry is { table:<name>, actions:[...] },
    // where an action is { amount:Number, type:"bet"|"raise", street:0..3 }
    // (see STREETS). Calls/checks/folds/blinds are not recorded. The table name
    // keeps the readout scoped to the current table so moving tables (or a
    // tournament re-seat) resets the count.
    function freshStat() {
        return { hands: 0, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0,
            showdowns: 0, sdWins: 0, betHands: [], _v: STAT_VERSION };
    }

    // Bring an older saved record up to the current shape (idempotent; `_v`
    // marks the version already applied). Handles every past shape: the earliest
    // `betAmts` (flat per-hand totals), the interim `betHands` of bare action-
    // arrays, and the previous {table, actions} with string streets. Legacy
    // hands that never knew their table get table:null (they won't match any
    // current table, so they don't count — the right behaviour, since we can't
    // attribute them after the fact); string streets are normalised to ints.
    function normActions(arr) {
        return (Array.isArray(arr) ? arr : []).map((a) => ({
            amount: (a && a.amount) || 0,
            type: (a && a.type) || "unknown",
            street: streetToInt(a && a.street),
        }));
    }
    function migrateStat(t) {
        if (t._v === STAT_VERSION) return t;
        if (Array.isArray(t.betHands)) {
            t.betHands = t.betHands.map((e) =>
                (e && !Array.isArray(e) && Array.isArray(e.actions))
                    ? { table: e.table != null ? e.table : null, actions: normActions(e.actions) }
                    : { table: null, actions: normActions(e) });
        } else {
            t.betHands = Array.isArray(t.betAmts)
                ? t.betAmts.map((n) => ({ table: null,
                    actions: n > 0 ? [{ amount: n, type: "unknown", street: null }] : [] }))
                : [];
        }
        if (t.betHands.length > BET_HISTORY_MAX) t.betHands = t.betHands.slice(-BET_HISTORY_MAX);
        delete t.betAmts;
        t._v = STAT_VERSION;
        return t;
    }

    function updatePlayerStats(lines) {
        // Per-hand tallies: vpip/pfr/showdown/sdWin are 0/1 flags,
        // bets/raises/calls are postflop counts (for aggression factor),
        // actions is the ordered list of this hand's bets/raises.
        const per = {};
        const get = (n) => (per[n] = per[n] ||
            { vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, showdown: 0, sdWin: 0, actions: [] });
        let street = 0; // 0=preflop, 1=flop, 2=turn, 3=river (index into STREETS)
        for (const line of lines) {
            let dm = line.match(/^Dealing (flop|turn|river)/i);
            if (dm) { street = STREETS.indexOf(dm[1].toLowerCase()); continue; }
            let m;
            if ((m = line.match(/^(.+?) (?:folds|checks)$/i))) { get(m[1].trim()); continue; }
            if ((m = line.match(/^(.+?) calls$/i))) {
                const s = get(m[1].trim());
                if (street === 0) s.vpip = 1; else s.calls++;
                continue;
            }
            if ((m = line.match(/^(.+?) (bets|raises) \$([\d,]+)$/i))) {
                const s = get(m[1].trim());
                const type = /raises/i.test(m[2]) ? "raise" : "bet";
                const amount = parseInt(m[3].replace(/,/g, ""), 10) || 0;
                s.actions.push({ amount, type, street });
                if (street === 0) { s.vpip = 1; if (type === "raise") s.pfr = 1; }
                else if (type === "raise") s.raises++;
                else s.bets++;
                continue;
            }
            if ((m = line.match(/^(.+?) shows \[/i))) { get(m[1].trim()).showdown = 1; continue; }
            if ((m = line.match(/^(.+?) wins (?:main|side) pot/i))) {
                const s = get(m[1].trim());
                if (s.showdown) s.sdWin = 1;
            }
        }
        const names = Object.keys(per);
        if (!names.length) return;
        for (const n of names) {
            const h = per[n];
            const t = migrateStat(playerStats[n] || freshStat());
            t.hands++;
            t.vpip += h.vpip;
            t.pfr += h.pfr;
            t.bets += h.bets;
            t.raises += h.raises;
            t.calls += h.calls;
            t.showdowns += h.showdown;
            t.sdWins += h.sdWin;
            // Append this hand's bets/raises tagged with the table it was played
            // at, then keep only the last N hands.
            t.betHands.push({ table: currentTableName(), actions: h.actions });
            if (t.betHands.length > BET_HISTORY_MAX) t.betHands = t.betHands.slice(-BET_HISTORY_MAX);
            playerStats[n] = t;
        }
        savePlayerStats();
    }

    // ---------- player notes ----------
    function saveNote(name, text) {
        text = (text || "").trim();
        if (text) playerNotes[name] = text;
        else delete playerNotes[name];
        if (EXT_STORE) { try { EXT_STORE.set({ [NOTES_KEY]: playerNotes }); } catch (e) {} }
        updateStatBadges();
    }

    function saveNick(name, nick) {
        nick = (nick || "").trim();
        if (nick) playerNicks[name] = nick;
        else delete playerNicks[name];
        if (EXT_STORE) { try { EXT_STORE.set({ [NICKS_KEY]: playerNicks }); } catch (e) {} }
        updateStatBadges();
    }

    // How to address a player in auto-chat: their nickname if we have one,
    // otherwise their handle. Blank in -> blank out (unknown token).
    function displayName(name) {
        return (name && playerNicks[name]) || name || "";
    }

    // One editor at a time, anchored under the clicked badge.
    function openNoteEditor(name, anchorRect) {
        const existing = document.getElementById("gpe-note-editor");
        if (existing) {
            const was = existing._gpeName;
            existing.remove();
            if (was === name) return; // clicking the same badge toggles it closed
        }
        const ed = document.createElement("div");
        ed.id = "gpe-note-editor";
        ed._gpeName = name;

        const head = document.createElement("div");
        head.className = "gpe-note-head";
        head.textContent = name;

        const nick = document.createElement("input");
        nick.type = "text";
        nick.className = "gpe-note-nick";
        nick.value = playerNicks[name] || "";
        nick.placeholder = "nickname (used in chat)";
        nick.title = "how chat buttons like gg/nh address this player";

        const box = document.createElement("textarea");
        box.value = playerNotes[name] || "";
        box.placeholder = "notes on " + name + "…";

        const row = document.createElement("div");
        row.className = "gpe-note-row";
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = "Save";
        save.addEventListener("click", () => { saveNick(name, nick.value); saveNote(name, box.value); ed.remove(); });
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Delete";
        del.addEventListener("click", () => { saveNick(name, ""); saveNote(name, ""); ed.remove(); });
        row.appendChild(save);
        row.appendChild(del);

        ed.appendChild(head);
        ed.appendChild(nick);
        ed.appendChild(box);
        ed.appendChild(row);
        document.body.appendChild(ed);
        ed.style.left = Math.min(anchorRect.left, window.innerWidth - ed.offsetWidth - 8) + "px";
        ed.style.top = anchorRect.bottom + 4 + "px";
        box.focus();
    }

    // ---------- stats badges on avatars ----------
    const statBadges = new Map(); // player name -> badge el

    function badgeTextFor(name) {
        const t = playerStats[name];
        if (!t || !t.hands) return null;
        const pct = (x) => Math.round((x / t.hands) * 100);
        // Third stat is showdown win rate (won / went to showdown); "–" until
        // we've seen one, so it never reads as a real 0%.
        const sd = t.showdowns ? Math.round((t.sdWins / t.showdowns) * 100) + "%" : "–";
        return pct(t.vpip) + "/" + pct(t.pfr) + "/" + sd;
    }

    // Hover tooltip: spell the numbers out in plain English. `skipName` drops the
    // leading "NAME —" when the site-profile card above the text already names them.
    function badgeTitleFor(name, skipName) {
        const t = playerStats[name];
        const lines = [];
        const who = skipName ? "" : name + " — ";
        if (t && t.hands) {
            const pct = (x) => Math.round((x / t.hands) * 100) + "%";
            lines.push(who + t.hands + " hand" + (t.hands === 1 ? "" : "s") + " observed");
            lines.push("plays " + pct(t.vpip) + " of hands (VPIP)");
            lines.push("raises " + pct(t.pfr) + " preflop (PFR)");
            const aggr = (t.bets || 0) + (t.raises || 0);
            if (aggr || t.calls) lines.push("postflop: " + aggr + " bets/raises vs " + (t.calls || 0) + " calls");
            if (t.showdowns) lines.push("won " + t.sdWins + " of " + t.showdowns + " showdowns");
        } else {
            lines.push(who + "no hands observed yet");
        }
        if (playerNicks[name]) lines.push("🏷 " + playerNicks[name]);
        if (playerNotes[name]) lines.push("📝 " + playerNotes[name]);
        lines.push("(click to edit)");
        return lines.join("\n");
    }

    // ---------- site-profile stats (the numbers gpokr itself keeps) ----------
    // Our own stats are only what this tab has watched. `/profile/{id}.json` is
    // the site's own record — today's chips/hands/busts, the monthly standing,
    // and the trophy artwork — and it answers unauthenticated for any user id.
    // Fetched lazily on first hover of a badge, cached, and re-rendered into the
    // open tooltip when it lands. Everything here degrades to nothing: no id, a
    // failed fetch, or a null block just leaves the observed-stats text alone.
    const PROFILE_TTL_MS = 5 * 60 * 1000;
    const profileCache = new Map();   // userId -> { data, fetchedAt, loading }
    const userIdByName = new Map();   // player name -> userId (stable; cached for the session)
    const PROFILE_TROPHY_MAX = 6;     // artwork is 512px/50KB+ per file — show a handful

    // Three independent places the numeric id shows up, tried in order of how
    // tightly each is bound to the player: their seat's profile link, their
    // avatar's photoId (which ends "-<userId>"), then any profile link elsewhere
    // on the page whose text is exactly their name (the game log links names).
    // A miss is cached-free and simply means no card.
    const PROFILE_HREF_ID = /\/profile\/(\d{4,})/;
    // Avatar URLs end with the photoId, which is "<hash>-<userId>.<ext>". Anchored
    // on the hyphen so a default avatar ("usr64/100000.jpg") can't be mistaken for
    // a user id.
    const PHOTO_ID = /-(\d{4,})\.[a-z]{3,4}(?:[?#]|$)/i;
    function seatUserId(name) {
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            if (getSeatName(p) !== name) continue;
            const link = p.querySelector('a[href*="/profile/"]');
            const byHref = link && (link.getAttribute("href") || "").match(PROFILE_HREF_ID);
            if (byHref) return byHref[1];
            const av = p.querySelector("img.iogc-PlayerPanel-avatar");
            const byPhoto = av && (av.getAttribute("src") || "").match(PHOTO_ID);
            if (byPhoto) return byPhoto[1];
        }
        return null;
    }
    function linkedUserId(name) {
        for (const a of document.querySelectorAll('a[href*="/profile/"]')) {
            if (a.textContent.trim() !== name) continue;
            const m = (a.getAttribute("href") || "").match(PROFILE_HREF_ID);
            if (m) return m[1];
        }
        return null;
    }
    function userIdFor(name) {
        const known = userIdByName.get(name);
        if (known) return known;
        const id = seatUserId(name) || linkedUserId(name);
        if (id) userIdByName.set(name, id); // ids never change; keep it for the session
        return id;
    }

    // Cached profile for `name`, kicking off a fetch when missing or stale.
    // Returns null until data is in hand (the tooltip re-renders on arrival).
    function profileStats(name) {
        const id = userIdFor(name);
        if (!id) return null;
        const hit = profileCache.get(id);
        const fresh = hit && Date.now() - hit.fetchedAt < PROFILE_TTL_MS;
        if (!fresh && !(hit && hit.loading)) fetchProfile(id, name);
        return (hit && hit.data) || null;
    }
    // My own id comes from the sidebar avatar rather than a seat — it's there
    // whether I'm seated, standing, or only watching.
    function myUserId() {
        const av = document.querySelector(".iogc-LoginPanel-avatar");
        const m = av && (av.getAttribute("src") || "").match(PHOTO_ID);
        return m ? m[1] : null;
    }
    // My monthly score — the number the lobby's tier "min entry" is compared
    // against. Null until the profile lands (or if the id can't be read).
    function myMonthlyScore() {
        const id = myUserId();
        if (!id) return null;
        const hit = profileCache.get(id);
        if (!hit || Date.now() - hit.fetchedAt >= PROFILE_TTL_MS) {
            if (!(hit && hit.loading)) fetchProfile(id, null);
        }
        const s = hit && hit.data && hit.data.monthStat && hit.data.monthStat.score;
        return typeof s === "number" ? s : null;
    }
    function fetchProfile(id, name) {
        const prev = profileCache.get(id);
        const keep = prev && prev.data;
        profileCache.set(id, { data: keep, fetchedAt: Date.now(), loading: true });
        // fetchedAt is stamped on failure too, so a dead id is retried at most
        // once per TTL instead of on every hover.
        const done = (data) => {
            profileCache.set(id, { data: data || keep || null, fetchedAt: Date.now(), loading: false });
            if (badgeTip && badgeTip.name === name) renderBadgeTip();
        };
        fetch("/profile/" + encodeURIComponent(id) + ".json", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then(done, () => done(null));
    }

    // 1,284 / 12.9K / 1.4M — compact only once the digits get long.
    function compactNum(n) {
        if (typeof n !== "number" || !isFinite(n)) return "–";
        const a = Math.abs(n);
        const trim = (s) => s.replace(/\.0$/, "");
        if (a >= 1e6) return trim((n / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + "M";
        if (a >= 1e4) return trim((n / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + "K";
        return n.toLocaleString();
    }
    // Signed for the win/loss numbers: the sign carries direction, so color is
    // never the only cue. Real minus sign (U+2212), not a hyphen.
    function signedNum(n) {
        if (typeof n !== "number" || !isFinite(n)) return "–";
        return (n > 0 ? "+" : n < 0 ? "−" : "") + compactNum(Math.abs(n));
    }

    // The card that sits above the observed-stats text: monthly standing chip,
    // a row of today's tiles, and the trophy artwork. Null when there's nothing
    // to show, so the tooltip stays exactly as it was before this existed.
    function buildProfileCard(name) {
        const prof = profileStats(name);
        if (!prof) return null;
        const today = prof.today || null;
        const month = prof.monthStat || null;
        // `today` is null for anyone who hasn't played yet today; fall back to the
        // month-to-date block rather than showing a row of dashes. Same fields
        // either way, except the running total is `scoreChange` vs `score`.
        const period = today || month;
        if (!period) return null;
        const total = today ? today.scoreChange : month.score;

        const card = document.createElement("div");
        card.className = "gpe-pf";

        const top = document.createElement("div");
        top.className = "gpe-pf-top";
        const who = document.createElement("span");
        who.className = "gpe-pf-name";
        who.textContent = displayName(name);
        top.appendChild(who);
        if (month && month.rank) {
            const chip = document.createElement("span");
            chip.className = "gpe-pf-rank" + (month.rank <= 3 ? " gpe-pf-elite" : "");
            // ★ + the word "rank" keep the top-3 gold from being color-alone.
            chip.textContent = (month.rank <= 3 ? "★ " : "") + "#" + month.rank.toLocaleString() +
                " " + String(prof.monthName || "").slice(0, 3);
            top.appendChild(chip);
        }
        card.appendChild(top);

        const tiles = document.createElement("div");
        tiles.className = "gpe-pf-tiles";
        const TILES = [
            { lab: today ? "today" : "month", val: signedNum(total), dir: total },
            { lab: "hands", val: compactNum(period.played) },
            { lab: "busts", val: compactNum(period.busts) },
            { lab: "per game", val: signedNum(period.ppg), dir: period.ppg },
        ];
        TILES.forEach((t) => {
            const cell = document.createElement("div");
            cell.className = "gpe-pf-tile";
            const v = document.createElement("div");
            v.className = "gpe-pf-val" + (t.dir > 0 ? " gpe-pf-up" : t.dir < 0 ? " gpe-pf-down" : "");
            v.textContent = t.val || "–";
            const l = document.createElement("div");
            l.className = "gpe-pf-lab";
            l.textContent = t.lab;
            cell.appendChild(v);
            cell.appendChild(l);
            tiles.appendChild(cell);
        });
        card.appendChild(tiles);
        if (!today) {
            const none = document.createElement("div");
            none.className = "gpe-pf-note";
            none.textContent = "nothing played today";
            card.appendChild(none);
        }

        // Monthly leaderboard trophies first (best finish first); a player with
        // none falls back to their bounty/tournament/team artwork.
        const career = (prof.careerTrophies || []).slice()
            .sort((a, b) => (a.rank || 99) - (b.rank || 99))
            .map((t) => ({ url: t.imageUrl, alt: (t.monthName || "") + " #" + (t.rank || "?") }));
        const wins = career.length ? career
            : (prof.achievements || []).map((a) => ({
                url: a.imageUrl, alt: (a.sourceName || a.bonusType || "") + " #" + (a.rank || "?") }));
        const shown = wins.filter((w) => w.url).slice(0, PROFILE_TROPHY_MAX);
        if (shown.length) {
            const row = document.createElement("div");
            row.className = "gpe-pf-trophies";
            shown.forEach((w) => {
                const img = document.createElement("img");
                img.className = "gpe-pf-trophy";
                img.src = w.url;
                img.alt = w.alt;
                img.decoding = "async";
                row.appendChild(img);
            });
            if (wins.length > shown.length) {
                const more = document.createElement("span");
                more.className = "gpe-pf-more";
                more.textContent = "+" + (wins.length - shown.length);
                row.appendChild(more);
            }
            card.appendChild(row);
        }
        return card;
    }

    // Hand-rolled hover tooltip. (Native title tooltips never appear here:
    // the 300ms badge refresh rewrites the attribute, resetting the
    // browser's tooltip timer every tick.)
    let badgeTip = null; // { badge, name } while one is open — the re-render target
    function showBadgeTip(badge, name) {
        hideBadgeTip();
        badgeTip = { badge, name };
        renderBadgeTip();
    }
    // Rebuilt in place rather than patched: called again when a profile fetch
    // lands, which changes the card's height, so it re-anchors as well.
    function renderBadgeTip() {
        if (!badgeTip) return;
        const { badge, name } = badgeTip;
        if (!badge.isConnected) { hideBadgeTip(); return; }
        let tip = document.getElementById("gpe-stat-tip");
        if (!tip) {
            tip = document.createElement("div");
            tip.id = "gpe-stat-tip";
            document.body.appendChild(tip);
        }
        tip.textContent = "";
        const card = buildProfileCard(name);
        if (card) tip.appendChild(card);
        const body = document.createElement("div");
        body.className = "gpe-tip-body";
        body.textContent = badgeTitleFor(name, !!card); // the card already names them
        tip.appendChild(body);
        const r = badge.getBoundingClientRect();
        tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + "px";
        tip.style.top = r.bottom + 6 + "px";
    }
    function hideBadgeTip() {
        badgeTip = null;
        const t = document.getElementById("gpe-stat-tip");
        if (t) t.remove();
    }

    // Tag the seat-name cell of the player whose turn it is: the site paints
    // its light-green bar via a stylesheet path with no distinguishing class,
    // so dark.css can't target it directly. We detect the painted background
    // and add .gpe-turn (which only restyles the TEXT — never the background,
    // so this detection stays stable).
    function tagTurnHighlights() {
        for (const el of document.querySelectorAll(".iogc-PlayerPanel-name")) {
            // Measure with our class off: dark.css repaints the bar's background,
            // so reading it while tagged would see our own paint and never untag.
            // Remove + re-add happens within one JS turn — nothing is rendered
            // in between, so there's no flicker.
            el.classList.remove("gpe-turn");
            const hl = getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)";
            el.classList.toggle("gpe-turn", hl);
            const card = el.closest(".iogc-GamePanel"); // highlight the whole seat card too
            if (card) card.classList.toggle("gpe-turn-card", hl);
        }
    }

    // One pass: create/update a badge over each visible seat, drop the rest.
    // Badges show only when stats are enabled. Clicking a badge opens the
    // note/nickname editor.
    function updateStatBadges() {
        const wanted = new Set();
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            const name = getSeatName(p);
            if (!name || wanted.has(name)) continue;
            if (!SHOW_STATS) continue;
            const av = p.querySelector("img.iogc-PlayerPanel-avatar");
            if (!av) continue;
            const r = av.getBoundingClientRect();
            if (r.width === 0) continue;
            wanted.add(name);
            let badge = statBadges.get(name);
            if (!badge || !badge.isConnected) {
                badge = document.createElement("div");
                badge.className = "gpe-stat-badge";
                badge.addEventListener("click", () => {
                    hideBadgeTip();
                    openNoteEditor(name, badge.getBoundingClientRect());
                });
                badge.addEventListener("mouseenter", () => showBadgeTip(badge, name));
                badge.addEventListener("mouseleave", hideBadgeTip);
                document.body.appendChild(badge);
                statBadges.set(name, badge);
            }
            // Topper is stats-only now: no nickname/note markers (a home for
            // those indicators is TBD). We only get here when SHOW_STATS is on.
            const text = badgeTextFor(name) || "–/–/–";
            if (badge.textContent !== text) badge.textContent = text; // don't churn the DOM every tick
            // Same width as the avatar, sitting flush on its top edge (no
            // overlap) so it reads as a tab without covering the avatar's
            // rounded top corners.
            badge.style.left = r.left + "px";
            badge.style.width = r.width + "px";
            badge.style.top = r.top + "px";
        }
        for (const [name, el] of statBadges) {
            if (!wanted.has(name)) { el.remove(); statBadges.delete(name); }
        }
        // drop an orphaned tooltip if its badge went away under the cursor
        const tip = document.getElementById("gpe-stat-tip");
        if (tip && ![...statBadges.values()].some((b) => b.matches(":hover"))) hideBadgeTip();
    }

    // ---------- hover topper: nickname + note + edit, over the name/chips panel ----------
    // A second tab in the same style as the stats badge. It's hidden until the
    // seat's name/chips panel is hovered, then slides up flush above it. One
    // shared element serves whichever seat is currently hovered.
    let hoverTopperEl = null;   // the single reused tab
    let hoverTopperName = null; // whose content it's currently showing
    let hoverHideTimer = null;

    function ensureHoverTopper() {
        if (hoverTopperEl && hoverTopperEl.isConnected) return hoverTopperEl;
        const el = document.createElement("div");
        el.id = "gpe-hover-topper";
        el.className = "gpe-hover-topper";
        // Hovering the tab itself keeps it open (it sits just outside the panel).
        el.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
        el.addEventListener("mouseleave", scheduleHideHoverTopper);
        document.body.appendChild(el);
        hoverTopperEl = el;
        hoverTopperName = null; // fresh element -> force a re-render of its content
        return el;
    }

    function renderHoverTopper(name) {
        const el = hoverTopperEl;
        el.textContent = "";
        const nick = document.createElement("span");
        nick.className = "gpe-ht-nick";
        if (playerNicks[name]) {
            nick.textContent = playerNicks[name];
        } else {
            nick.textContent = "no nickname";
            nick.classList.add("gpe-ht-empty");
        }
        el.appendChild(nick);
        if (playerNotes[name]) {
            const note = document.createElement("span");
            note.className = "gpe-ht-note";
            note.textContent = "📝";
            note.title = playerNotes[name];
            el.appendChild(note);
        }
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "gpe-ht-edit";
        edit.textContent = "✎";
        edit.title = "edit nickname & notes";
        edit.addEventListener("click", () => openNoteEditor(name, el.getBoundingClientRect()));
        el.appendChild(edit);
    }

    // Anchor over the name element (falls back to the whole panel) so the tab
    // hugs the name/chips row rather than the avatar's stats badge.
    function positionHoverTopper(panel) {
        const anchor = panel.querySelector(".iogc-PlayerPanel-name") || panel;
        const r = anchor.getBoundingClientRect();
        if (r.width === 0) return false;
        const el = hoverTopperEl;
        el.style.left = r.left + "px";
        el.style.width = r.width + "px";
        el.style.top = r.top + "px"; // translateY(-100%) lifts it above this edge
        return true;
    }

    function showHoverTopper(name, panel) {
        clearTimeout(hoverHideTimer);
        const el = ensureHoverTopper();
        if (hoverTopperName !== name) { hoverTopperName = name; renderHoverTopper(name); }
        el._gpePanel = panel;
        if (!positionHoverTopper(panel)) return;
        requestAnimationFrame(() => el.classList.add("gpe-show"));
    }

    function hideHoverTopper() {
        if (hoverTopperEl) hoverTopperEl.classList.remove("gpe-show");
    }

    // Small grace period so moving between the panel and the tab doesn't flicker.
    function scheduleHideHoverTopper() {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = setTimeout(hideHoverTopper, 140);
    }

    // Wire hover listeners onto each seat panel (once per DOM node — GWT
    // re-renders make fresh nodes, which get re-wired) and keep a shown tab
    // glued to its panel as the layout reflows.
    function updateHoverToppers() {
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            if (p._gpeHoverWired) continue;
            p._gpeHoverWired = true;
            p.addEventListener("mouseenter", () => {
                const name = getSeatName(p);
                if (name) showHoverTopper(name, p);
            });
            p.addEventListener("mouseleave", scheduleHideHoverTopper);
        }
        if (hoverTopperEl && hoverTopperEl.classList.contains("gpe-show") && hoverTopperEl._gpePanel) {
            if (!hoverTopperEl._gpePanel.isConnected) hideHoverTopper();
            else positionHoverTopper(hoverTopperEl._gpePanel);
        }
    }

    // ---------- per-player bet readout (swaps the seat "Level" stat) ----------
    // Sum of the amounts a player bet/raised (calls never counted) over their
    // last BET_WINDOW recorded hands. Null until we've seen at least one hand.
    function betReadoutFor(name) {
        const t = playerStats[name];
        if (!t) return null;
        migrateStat(t); // tolerate records saved before the structured shape
        // Only hands played at the current table count — moving tables (or a
        // tournament re-seat onto a new table name) resets the window.
        const cur = currentTableName();
        if (!cur) return null;
        const here = t.betHands.filter((h) => h.table === cur);
        if (!here.length) return null;
        const recent = here.slice(-BET_WINDOW); // last N of this table's hands
        const total = recent.reduce((sum, hand) =>
            sum + hand.actions.reduce((a, act) => a + (act.amount || 0), 0), 0);
        return { total, hands: recent.length };
    }

    function fmtMoney(n) { return "$" + (n || 0).toLocaleString("en-US"); }

    // Rewrite each visible seat's "Level" stat row in place to show the bet
    // readout (and restore "Level" when the feature is off). GWT re-renders the
    // panel freely, so this runs every poll and is idempotent: the row is found
    // by its label ("Level"), and a data-marker lets us keep managing it after
    // our own overwrite. We stash the original level value so a later toggle-off
    // can put it back even if GWT hasn't repainted the seat since.
    function applyBetReadout() {
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            let row = null;
            for (const r of p.querySelectorAll(".iogc-PlayerStatsPanel")) {
                const lab = r.querySelector(".gwt-InlineLabel");
                if (lab && (lab.dataset.gpeLevel === "1" || lab.textContent.trim() === "Level")) {
                    row = r; break;
                }
            }
            if (!row) continue;
            const val = row.querySelector(".iogc-PlayerPanel-stat");
            const lab = row.querySelector(".gwt-InlineLabel");
            if (!val || !lab) continue;

            if (!BET_READOUT) {
                if (lab.dataset.gpeLevel === "1") { // ours — restore the site's readout
                    if (val.dataset.gpeOrig != null) val.textContent = val.dataset.gpeOrig;
                    lab.textContent = "Level";
                    delete lab.dataset.gpeLevel;
                    delete val.dataset.gpeOrig;
                    row.classList.remove("gpe-bet-readout");
                    row.removeAttribute("title");
                }
                continue;
            }

            if (lab.dataset.gpeLevel !== "1") { // first touch (fresh/native row): remember the level
                val.dataset.gpeOrig = val.textContent;
                lab.dataset.gpeLevel = "1";
                row.classList.add("gpe-bet-readout");
            }
            const name = getSeatName(p);
            const rd = betReadoutFor(name);
            const valText = rd ? fmtMoney(rd.total) : "$0";
            const labText = "Bet " + BET_WINDOW + "h";
            if (val.textContent !== valText) val.textContent = valText;
            if (lab.textContent !== labText) lab.textContent = labText;
            const title = rd
                ? name + " bet/raised " + fmtMoney(rd.total) + " over last " + rd.hands +
                    " hand" + (rd.hands === 1 ? "" : "s")
                : (name || "seat") + " — no bets recorded yet";
            if (row.getAttribute("title") !== title) row.setAttribute("title", title);
        }
    }

    // ---------- end-of-hand watcher (auto-share + harvest, once per hand) ----------
    let sharedThisHand = false;
    let harvestedThisHand = false;
    let lastEnded = false;
    // Snapshot of my most-recently-completed hand, for the inline "share last
    // hand" button (which reveals it during the gap before the next flop).
    let lastHandCaptured = false;
    let lastHandShare = null;      // { cards, gameId, label }
    let sharedLastGameId = null;   // the hand id already revealed (dedupes the click / marks auto-shares)
    let curGameId = null;   // most recent completed hand's id (from the Replay line)
    let prevGameId = null;  // the one before it — a one-hand grace for verification

    // Drop all accumulated per-hand state. Called on a table switch: the new
    // table's log has nothing to do with the old one, so carrying the scope
    // buffer or a half-built summary across would merge two tables' hands.
    function resetHandScope() {
        handScopeBuf = [];
        pendingLogSummary = null;
        summarySnap = null; summaryEl = null; summarySig = ""; summaryEpoch = -1;
        handEpoch++;
        peerReveals.clear();
        sharedThisHand = false; harvestedThisHand = false;
        lastHandCaptured = false; lastHandShare = null; sharedLastGameId = null;
        lastEnded = false;
    }

    // Dedupe received reveals so a repeated paste renders only once.
    // bucket (gameId, or "v1" for legacy) -> Set(member). Pruned to the two live
    // hand ids plus the legacy bucket.
    const shownByHand = new Map();
    function alreadyShown(bucket, member) {
        let set = shownByHand.get(bucket);
        if (set && set.has(member)) return true;
        if (!set) shownByHand.set(bucket, (set = new Set()));
        set.add(member);
        return false;
    }
    function noteGameId(gid) {
        if (!gid || gid === curGameId) return;
        prevGameId = curGameId;
        curGameId = gid;
        // keep only the two live hand ids (plus the legacy bucket)
        for (const k of shownByHand.keys()) {
            if (k !== curGameId && k !== prevGameId && k !== "v1") shownByHand.delete(k);
        }
        retryPendingShares(); // a newly-known id may verify a share that arrived early
    }

    // Render a decoded reveal, skipping my own and deduping repeats.
    function renderDecoded(sender, dec) {
        const bucket = dec.gameId == null ? "v1" : dec.gameId;
        const member = dec.gameId == null ? sender + "|" + cardBody(dec.cards) : sender;
        if (sender === getMyName() || alreadyShown(bucket, member)) return;
        showHandForName(sender, dec.cards, dec.label || handLabelFor(dec.cards));
        // Someone showing their hand after the round is the same event as a
        // showdown, so it belongs in that hand's summary too — which may already be
        // sitting in the log by the time they click. Legacy shares carry no hand id
        // and are deliberately not eligible: there'd be no way to know which hand
        // they belong to.
        if (notePeerReveal(dec.gameId, sender, (dec.cards || []).map(normCard))) refreshHandSummary(false);
    }

    // A share can reach the chat before this client has registered the hand's
    // id (our own Replay line / poll lags the sharer), which would make a valid
    // reveal fail verification and vanish. Stash such shares and re-check them
    // as our id knowledge catches up, dropping anything still unverified after
    // a short window (that covers genuine spoof/replay attempts too).
    const pendingShares = [];
    function stashPendingShare(sender, text) {
        if (pendingShares.some((p) => p.sender === sender && p.text === text)) return;
        pendingShares.push({ sender, text, t: Date.now() });
        if (pendingShares.length > 40) pendingShares.shift();
    }
    function retryPendingShares() {
        if (!pendingShares.length) return;
        const ids = [currentGameId(), curGameId, prevGameId];
        const now = Date.now();
        for (let i = pendingShares.length - 1; i >= 0; i--) {
            const p = pendingShares[i];
            if (now - p.t > 12000) { pendingShares.splice(i, 1); continue; }
            const dec = decodeHand(p.text, p.sender, ids);
            if (dec) { pendingShares.splice(i, 1); renderDecoded(p.sender, dec); }
        }
    }
    // One-shot share, armed from the inline "share hand" checkbox and cleared
    // once it fires. The popup's "always share" setting (SHARE_HAND) is
    // independent and never auto-unchecks. Session-only — not persisted.
    let shareNextHand = false;
    function setShareNextHand(v) {
        shareNextHand = v;
        syncShareToggleUI();
    }
    // While the popup's "always share" is on, it owns the inline box: shown
    // checked and grayed out. Otherwise the box reflects the one-shot state.
    function syncShareToggleUI() {
        const box = document.getElementById("gpe-share-next");
        if (!box) return;
        box.disabled = SHARE_HAND;
        box.checked = SHARE_HAND ? true : shareNextHand;
    }

    // The inline "share last hand" button is offered only while revealing the
    // finished hand is still timely: from the moment a hand ends through the
    // next hand's pre-flop. Once the flop lands (a live hand past pre-flop) the
    // "share hand" checkbox takes its place. Needs a captured hand to reveal.
    function shareLastAvailable() {
        if (!lastHandShare) return false;
        if (handHasEnded()) return true;   // the hand just ended -> still in the gap
        return parseBoard().length < 3;    // otherwise only while the live hand is pre-flop
    }
    function updateShareControlUI() {
        const btn = document.getElementById("gpe-share-last");
        const toggle = document.getElementById("gpe-share-toggle");
        if (!btn || !toggle) return;
        // Hide with a class (visibility, not display) so the unused control keeps
        // its place in the shared slot and the row's width stays put.
        const showBtn = shareLastAvailable();
        btn.classList.toggle("gpe-hidden", !showBtn);
        toggle.classList.toggle("gpe-hidden", showBtn);
        if (showBtn) {
            const done = sharedLastGameId != null && lastHandShare.gameId === sharedLastGameId;
            btn.disabled = done;
            btn.classList.toggle("gpe-shared", done); // swaps which label shows
        }
    }
    function shareLastHand() {
        if (!lastHandShare) return;
        const { cards, gameId, label } = lastHandShare;
        if (LOCAL_TEST) showHandLocal(cards, label);
        else if (gameId) sendMessage(encodeHand(cards, gameId, label));
        else return; // no id yet -> can't be verified by peers; leave it enabled to retry
        sharedLastGameId = gameId;
        updateShareControlUI();
    }

    // ---------- UI: side-panel tools tab ----------
    // The sidebar panel (team / level / money refill) becomes a two-tab panel;
    // the second tab holds the plugin's quick options. GWT re-renders the
    // panel's content freely, so installation is idempotent and re-checked on
    // every poll, and the site's own children are hidden via CSS while "tools"
    // is active (moving GWT's nodes would fight its renderer).
    let sideTab = "site"; // "site" | "tools" | "roster" | "bets"

    // [checkbox id, label, settings key, current value]
    const SIDE_OPTIONS = [
        ["gpe-show-odds", "odds HUD", "showOdds", () => SHOW_ODDS],
        ["gpe-show-stats", "player stats", "showStats", () => SHOW_STATS],
        ["gpe-dark-mode", "dark mode", "darkMode", () => DARK_MODE],
        ["gpe-hand-summary", "hand summary", "handSummary", () => HAND_SUMMARY,
            "recap panel in the game log at the end of each hand"],
        ["gpe-four-color", "four-color deck", "fourColor", () => FOUR_COLOR,
            "Recolors the card art so diamonds are blue and clubs are green, " +
            "leaving hearts red and spades black. For anyone who can't reliably " +
            "separate the two red suits from the two black ones. The site's own " +
            "images are recolored in place — nothing about the game changes."],
        ["gpe-hotkeys", "keyboard shortcuts", "hotkeys", () => HOTKEYS,
            "F = fold · C = check/call · 1–9 = bet-size buttons · ↑/↓ = ±1 big blind"],
        ["gpe-bet-buttons", "bet buttons", "showBetButtons", () => SHOW_BET_BUTTONS],
        ["gpe-bet-readout", "bet readout", "betReadout", () => BET_READOUT,
            "Replaces each player's \"Level\" with the total they've bet/raised " +
            "(calls not counted) over their last N hands. Set N below."],
        ["gpe-table-3d", "3D table", "table3d", () => TABLE_3D,
            "Replaces the flat felt with a live 3D-rendered table (top-down, so " +
            "cards and chips stay aligned). Experimental."],
        ["gpe-mute-chat", "muted players", "muteChat", () => MUTE_CHAT,
            "Hides muted players' chat — in the pane, in the pop-out, and the emotes " +
            "and shared hands their messages would have put on screen. They can still " +
            "see you and still play; you just stop reading them. Unticking this keeps " +
            "the list but stops applying it. \"manage\" edits who's on it."],
        ["gpe-celebrations", "celebrations", "celebrations", () => CELEBRATIONS,
            "The 🎉 and 🕺 buttons by the pot: a burst of chips out of your seat, " +
            "or your avatar leaping onto the table to dance. Only between hands — " +
            "never once the flop is out. Turning this off hides your buttons AND " +
            "stops other players' celebrations from playing for you."],
        ["gpe-coin-toss", "interactions", "coinToss", () => COIN_TOSS,
            "Puts an interact button on the corner of every other player's " +
            "avatar, for throwing a chip from your seat that bounces off them " +
            "and lands on the felt. Everyone at the table sees it, and you see " +
            "theirs. Cosmetic only — it never affects the game. Requires a seat."],
    ];

    // The interaction-creator button rides on the interactions row. It used to be
    // hidden behind a hardcoded username check while it was a dev tool; it's a
    // player feature now, so everyone gets it.
    let chainBtn = null;
    let riverLabBtn = null;
    function updateRiverLabBtn() {
        if (riverLabBtn) riverLabBtn.classList.toggle("gpe-active", RIVER_LAB);
    }
    // Lit while the panel is open. Called both when settings change and from the
    // 1.5s tab poll.
    function updateChainBtn() {
        if (!chainBtn) return;
        chainBtn.classList.toggle("gpe-active", SHOW_TESTER);
    }

    // The card back is a choice, not a toggle, so it gets a <select> row of its
    // own rather than riding SIDE_OPTIONS. Not a <label>: there is no checkbox
    // for a click to fall through to.
    function buildCardBackRow() {
        const row = document.createElement("div");
        row.className = "gpe-side-option";
        row.appendChild(document.createTextNode("card back"));
        const info = document.createElement("span");
        info.className = "gpe-info";
        info.textContent = "\u24d8";
        attachInstantTip(info,
            "Replaces the face-down cards at every seat with one of our own " +
            "designs. Local only \u2014 other players still see whatever back they " +
            "picked, and nothing about the game changes. \"classic\" is gpokr's own.");
        row.appendChild(info);
        const sel = document.createElement("select");
        sel.id = "gpe-card-back";
        sel.className = "gpe-side-select";
        for (const style of [""].concat(CARD_BACK_STYLES)) {
            const opt = document.createElement("option");
            opt.value = style;
            opt.textContent = CARD_BACK_LABELS[style] || style;
            sel.appendChild(opt);
        }
        sel.value = CARD_BACK;
        sel.addEventListener("change", () => saveSetting("cardBack", sel.value));
        row.appendChild(sel);
        return row;
    }

    // Panel checkboxes mirror the persistent settings (same ones as the popup);
    // either UI updates the other through chrome.storage.
    function syncSideOptionsUI() {
        for (const [id, , , current] of SIDE_OPTIONS) {
            const box = document.getElementById(id);
            if (box) box.checked = current();
        }
        const back = document.getElementById("gpe-card-back");
        if (back && document.activeElement !== back) back.value = CARD_BACK;
        syncBetWindowInputs();
        updateChainBtn();
        updateRiverLabBtn();
    }

    // The hand-count lives in two places (tools tab + bets tab); keep both in
    // step, skipping whichever is being edited so the caret doesn't jump.
    function syncBetWindowInputs() {
        for (const id of ["gpe-bet-window", "gpe-bets-window"]) {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el) el.value = String(BET_WINDOW);
        }
    }

    // Apply a new hand-count everywhere: seat cards, the bets list, both inputs,
    // and persistent storage (which also mirrors it to the popup).
    function setBetWindow(v) {
        v = parseInt(v, 10);
        if (!isFinite(v) || v < 1) v = 3;
        v = Math.min(v, BET_HISTORY_MAX);
        BET_WINDOW = v;
        syncBetWindowInputs();
        saveSetting("betWindow", v);
        renderBetsList();
    }

    const SIDE_TAB_ORDER = ["site", "tools", "roster", "bets"];
    function applySideTabState() {
        const inner = document.querySelector(".iogc-LoginPanel .iogc-SidePanel-inner");
        if (!inner) return;
        inner.classList.toggle("gpe-tab-tools", sideTab === "tools");
        inner.classList.toggle("gpe-tab-roster", sideTab === "roster");
        inner.classList.toggle("gpe-tab-bets", sideTab === "bets");
        if (sideTab === "bets") renderBetsList();
        const tabs = inner.querySelector(":scope > .gpe-side-tabs");
        if (!tabs) return;
        // The tab strip no longer holds the version badge, so its children are
        // exactly the tab buttons — index-aligned with SIDE_TAB_ORDER.
        Array.from(tabs.children).forEach((b, i) =>
            b.classList.toggle("gpe-active", sideTab === SIDE_TAB_ORDER[i]));
        updateChainBtn(); // the login name may have arrived since the tabs were built
    }

    // Instant hover popup — replaces the native `title` tooltip, which has an
    // uncontrollable ~1s delay. The popup lives on <body> so the narrow side
    // panel can't clip it, and is positioned under the anchor each time.
    // `text` may be a function, resolved on each hover — that's how the
    // quick-chat buttons preview the current value of their [playername] /
    // [lastwinner] tokens. Returning "" skips the popup entirely.
    let instantTip = null;
    function hideInstantTip() {
        if (instantTip) { instantTip.remove(); instantTip = null; }
    }
    function attachInstantTip(el, text) {
        el.addEventListener("mouseenter", () => {
            hideInstantTip();
            const msg = typeof text === "function" ? text() : text;
            if (!msg) return;
            const pop = document.createElement("div");
            instantTip = pop;
            pop.className = "gpe-tip-pop";
            pop.textContent = msg;
            document.body.appendChild(pop);
            const r = el.getBoundingClientRect();
            const pad = 6;
            let left = r.left;
            if (left + pop.offsetWidth > window.innerWidth - pad) {
                left = window.innerWidth - pad - pop.offsetWidth;
            }
            if (left < pad) left = pad;
            pop.style.left = Math.round(left) + "px";
            pop.style.top = Math.round(r.bottom + 4) + "px";
        });
        el.addEventListener("mouseleave", hideInstantTip);
    }

    // Which build is running, for the badge in the tools tab. As an extension the
    // manifest is authoritative; in the site-hosted build there is no manifest, but
    // we were fetched from tools.gpokr.com/<version>/content.js, so the URL carries
    // it. Worth showing precisely because the two builds differ in what works.
    function buildVersion() {
        try {
            const v = chrome.runtime.getManifest().version;
            if (v) return v;
        } catch (e) { /* not an extension */ }
        const m = SELF_SRC && SELF_SRC.match(/\/(\d+\.\d+\.\d+)\//);
        return m ? m[1] : "";
    }

    function ensureSidePanelTabs() {
        const inner = document.querySelector(".iogc-LoginPanel .iogc-SidePanel-inner");
        if (!inner) return;
        if (inner.querySelector(":scope > .gpe-side-tabs")) { applySideTabState(); return; }

        const tabs = document.createElement("div");
        tabs.className = "gpe-side-tabs";
        [["gpokr", "site"], ["tools", "tools"], ["table", "roster"], ["bets", "bets"]].forEach(([label, tab]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.addEventListener("click", () => { sideTab = tab; applySideTabState(); });
            tabs.appendChild(b);
        });

        const pane = document.createElement("div");
        pane.className = "gpe-side-options";
        for (const [id, label, key, , tip] of SIDE_OPTIONS) {
            const row = document.createElement("label");
            row.className = "gpe-toggle gpe-side-option";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.id = id;
            box.addEventListener("change", () => saveSetting(key, box.checked));
            row.appendChild(box);
            row.appendChild(document.createTextNode(" " + label));
            if (tip) {
                const info = document.createElement("span");
                info.className = "gpe-info";
                info.textContent = "ⓘ";
                attachInstantTip(info, tip);
                // Hover-only: don't let a click on the icon toggle the checkbox.
                info.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
                row.appendChild(info);
            }
            // Version badge rides the first row (odds HUD), pushed to the far right
            // — "top right of the panel", opposite the odds-HUD toggle. It's plain
            // text, so swallow clicks that would otherwise toggle the checkbox.
            if (id === "gpe-show-odds") {
                const ver = buildVersion();
                if (ver) {
                    const badge = document.createElement("span");
                    badge.className = "gpe-side-version";
                    badge.textContent = "v" + ver;
                    badge.title = "GPokr Tools " + ver + (SELF_SRC ? " (site build)" : "");
                    badge.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
                    row.appendChild(badge);
                }
            }
            // Celebrations get a "river" button: holds one on the felt so it can be
            // dragged round and looked at. A dev tool, same as "chain" once was —
            // hidden in release builds, see RIVER_LAB_BTN.
            if (id === "gpe-celebrations" && RIVER_LAB_BTN) {
                const lab = document.createElement("button");
                lab.type = "button";
                lab.className = "gpe-side-edit gpe-river-lab-btn";
                lab.textContent = "river";
                lab.title = "hold the river on the felt — drag it to any angle";
                lab.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    saveSetting("riverLab", !RIVER_LAB);
                });
                row.appendChild(lab);
                riverLabBtn = lab;
            }
            // The interactions option gets a "chain" button — the scripted-throw
            // tester — shown only to us (updateChainBtn gates it). Toggles the panel.
            if (id === "gpe-coin-toss") {
                const chain = document.createElement("button");
                chain.type = "button";
                chain.className = "gpe-side-edit gpe-chain-btn";
                chain.textContent = "chain";
                chain.title = "scripted-interaction builder";
                chain.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    saveSetting("showTester", !SHOW_TESTER);
                });
                row.appendChild(chain);
                chainBtn = chain;
                updateChainBtn();
            }
            // The mute option gets a "manage" button -> the muted-players list.
            if (id === "gpe-mute-chat") {
                const manage = document.createElement("button");
                manage.type = "button";
                manage.className = "gpe-side-edit";
                manage.textContent = "manage";
                manage.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation(); openMuteEditor();
                });
                row.appendChild(manage);
            }
            // The bet-buttons option gets an inline editor (same config the popup edits).
            if (id === "gpe-bet-buttons") {
                const edit = document.createElement("button");
                edit.type = "button";
                edit.className = "gpe-side-edit";
                edit.textContent = "edit";
                edit.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation(); openBetEditor();
                });
                row.appendChild(edit);
            }
            // The 3D-table option gets an "edit" button -> texture-zoom modal.
            if (id === "gpe-table-3d") {
                const edit = document.createElement("button");
                edit.type = "button";
                edit.className = "gpe-side-edit";
                edit.textContent = "edit";
                edit.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation(); openTable3dEditor();
                });
                row.appendChild(edit);
            }
            // The bet-readout option gets an inline "last N hands" number input.
            if (id === "gpe-bet-readout") {
                const num = document.createElement("input");
                num.type = "number";
                num.id = "gpe-bet-window";
                num.className = "gpe-side-num";
                num.min = "1";
                num.max = String(BET_HISTORY_MAX);
                num.step = "1";
                num.value = String(BET_WINDOW);
                // It's a labelable control inside the row <label>, so clicks land
                // on it (not the checkbox); stop propagation to be safe.
                num.addEventListener("click", (e) => e.stopPropagation());
                num.addEventListener("change", () => setBetWindow(num.value));
                const hint = document.createElement("span");
                hint.className = "gpe-side-numhint";
                hint.textContent = "hands";
                row.appendChild(num);
                row.appendChild(hint);
            }
            pane.appendChild(row);
        }
        pane.appendChild(buildCardBackRow());

        // "who's here" roster: its own tab pane
        const rosterPane = document.createElement("div");
        rosterPane.className = "gpe-side-roster";
        const roster = document.createElement("div");
        roster.id = "gpe-roster";
        rosterPane.appendChild(roster);

        // "bets" leaderboard: its own tab pane. A persistent header carries an
        // inline hand-count input (mirrors the tools tab); only the list below
        // re-renders, so editing the count doesn't blur the field.
        const betsPane = document.createElement("div");
        betsPane.className = "gpe-side-bets";
        const betsHead = document.createElement("div");
        betsHead.className = "gpe-bets-head";
        betsHead.appendChild(document.createTextNode("last "));
        const betsNum = document.createElement("input");
        betsNum.type = "number";
        betsNum.id = "gpe-bets-window";
        betsNum.className = "gpe-bets-num";
        betsNum.min = "1";
        betsNum.max = String(BET_HISTORY_MAX);
        betsNum.step = "1";
        betsNum.value = String(BET_WINDOW);
        betsNum.addEventListener("change", () => setBetWindow(betsNum.value));
        betsHead.appendChild(betsNum);
        betsHead.appendChild(document.createTextNode(" hands"));
        const betsList = document.createElement("div");
        betsList.id = "gpe-bets-list";
        betsPane.appendChild(betsHead);
        betsPane.appendChild(betsList);

        inner.prepend(tabs);
        inner.appendChild(pane);
        inner.appendChild(rosterPane);
        inner.appendChild(betsPane);
        syncSideOptionsUI();
        applySideTabState();
        renderRoster();
    }

    // Seated players ranked by how much they've bet/raised over the last
    // BET_WINDOW hands — a plain name + amount list, largest first.
    function renderBetsList() {
        const list = document.getElementById("gpe-bets-list");
        if (!list) return;
        const rows = [];
        const seen = new Set();
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            const name = getSeatName(p);
            if (!name || seen.has(name)) continue;
            if (p.getBoundingClientRect().width === 0) continue; // visible seats only
            seen.add(name);
            const rd = betReadoutFor(name);
            rows.push({ name, total: rd ? rd.total : 0 });
        }
        rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

        // Skip the DOM churn (this runs on every poll) when nothing changed.
        const sig = BET_WINDOW + "|" + rows.map((r) => r.name + ":" + r.total).join(",");
        if (list._gpeSig === sig) return;
        list._gpeSig = sig;

        list.textContent = "";
        if (!rows.length) {
            const empty = document.createElement("div");
            empty.className = "gpe-bets-empty";
            empty.textContent = "No players seated.";
            list.appendChild(empty);
            return;
        }
        rows.forEach((r) => {
            const row = document.createElement("div");
            row.className = "gpe-bets-row";
            const nm = document.createElement("span");
            nm.className = "gpe-bets-name";
            nm.textContent = r.name;
            const val = document.createElement("span");
            val.className = "gpe-bets-val";
            val.textContent = fmtMoney(r.total);
            row.appendChild(nm);
            row.appendChild(val);
            list.appendChild(row);
        });
    }

    // ---------- sidebar sections: collapse, hover-peek, teams visibility ----------
    // Each rail panel is a wrapper holding its own titleRow + .iogc-SidePanel-info
    // + .iogc-SidePanel-inner, so collapsing is just hiding those two content
    // blocks and leaving the title behind. Because the wrapper contains both the
    // title and the content, hover-to-peek is pure CSS: :hover on the wrapper
    // keeps the panel open as the pointer moves down into what it revealed.
    const SIDE_SECTIONS = [
        ["tables", ".iogc-AvailableGameSidePanel", "available tables"],
        ["leaderboard", ".iogc-tourny", "table leaderboard"],
        ["teams", ".iogc-TeamsLeaderboard", "teams"],
        ["following", ".iogc-friends", "following"],
    ];
    let SIDE_COLLAPSED = {}; // section key -> collapsed?
    let SHOW_TEAMS = true;   // the toggle that replaces the site's "Dark Mode" menu item

    function setSectionCollapsed(key, collapsed) {
        SIDE_COLLAPSED = Object.assign({}, SIDE_COLLAPSED, { [key]: collapsed });
        saveSetting("sideCollapsed", SIDE_COLLAPSED);
        applySideSections();
    }

    function ensureSideSections() {
        for (const [key, sel] of SIDE_SECTIONS) {
            const panel = document.querySelector(sel);
            if (!panel) continue;
            const row = panel.querySelector(":scope > .iogc-SidePanel-titleRow");
            if (!row) continue;
            panel.classList.add("gpe-sec");
            if (!row.querySelector(":scope > .gpe-sec-toggle")) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "gpe-sec-toggle";
                // Inserted FIRST: a right-floated box only shares a line with the
                // content that follows it in source order.
                btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation(); // some panel titles are links
                    setSectionCollapsed(key, !SIDE_COLLAPSED[key]);
                });
                row.insertBefore(btn, row.firstChild);
            }
        }
        applySideSections();
    }

    function applySideSections() {
        for (const [key, sel, label] of SIDE_SECTIONS) {
            const panel = document.querySelector(sel);
            if (!panel) continue;
            const off = !!SIDE_COLLAPSED[key];
            panel.classList.toggle("gpe-sec-collapsed", off);
            if (key === "teams") panel.classList.toggle("gpe-sec-hidden", !SHOW_TEAMS);
            const btn = panel.querySelector(":scope > .iogc-SidePanel-titleRow > .gpe-sec-toggle");
            if (!btn) continue;
            const glyph = off ? "▸" : "▾";
            if (btn.textContent !== glyph) btn.textContent = glyph;
            btn.title = off ? "expand " + label + " (or hover to peek)" : "collapse " + label;
        }
    }

    // The site's ⋮ menu: hide its "Dark Mode" item — ours is in the tools tab and
    // restyles far more of the site — and put a Teams panel toggle in its place,
    // the one rail panel the site offers no switch for. GWT rebuilds the menu every
    // time it opens, so this re-applies on each poll (and right after the click
    // that opens it, so the replaced item never flashes into view).
    function patchProfileMenu() {
        const menu = document.querySelector(".iogc-LoginPanel-menuPopup .iogc-LoginPanel-menu tbody");
        if (!menu) return;
        let anchor = null;
        for (const item of menu.querySelectorAll(".gwt-MenuItem")) {
            if (!/^dark mode$/i.test(item.textContent.trim())) continue;
            const tr = item.closest("tr");
            if (tr) { tr.classList.add("gpe-menu-off"); anchor = tr; }
        }
        if (!menu.querySelector(".gpe-menu-teams")) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.className = "gwt-MenuItem iogc-LoginPanel-menuItemToggle gpe-menu-teams";
            td.addEventListener("click", () => {
                SHOW_TEAMS = !SHOW_TEAMS;
                saveSetting("showTeams", SHOW_TEAMS);
                applySideSections();
                syncProfileMenu();
                // The site's own toggles dismiss the menu when clicked; a native
                // mousedown outside it is what GWT's auto-hide listens for.
                document.body.dispatchEvent(
                    new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            });
            tr.appendChild(td);
            if (anchor) anchor.insertAdjacentElement("afterend", tr);
            else menu.appendChild(tr);
        }
        syncProfileMenu();
    }
    // The site marks a toggle on with a leading ✓ and off with padding spaces.
    function syncProfileMenu() {
        const td = document.querySelector(".gpe-menu-teams");
        if (td) td.textContent = (SHOW_TEAMS ? "✓ " : "    ") + "Teams";
    }
    // Patch as soon as the menu opens rather than waiting for the next tick.
    function watchProfileMenuButton() {
        const btn = document.querySelector(".iogc-LoginPanel-menuButton");
        if (!btn || btn._gpeMenuHook) return;
        btn._gpeMenuHook = true;
        btn.addEventListener("click", () => requestAnimationFrame(patchProfileMenu));
    }

    // ---------- who's here roster ----------
    // Seated players come from the seat panels; watcher NAMES are only ever
    // revealed incrementally — "NAME is here / has left" chat events and chat
    // messages — so the roster grows the longer you stay. The site's public
    // table API gives the watcher COUNT, letting us say how many remain unseen
    // (lurkers who arrived before we did have no other footprint).
    const presentNames = new Map(); // name -> last seen (ms)
    let rosterTable = "";           // table the presence map belongs to
    // listed: null = not fetched yet, true = found in public table list (count
    // is authoritative), false = fetched but absent (tournament/SNG tables are
    // not in /api/gpokr/tables, so their viewer total can't be verified).
    let viewerInfo = { table: "", count: -1, listed: null, fetchedAt: 0 };

    function notePresence(name, present) {
        if (!name) return;
        if (present) presentNames.set(name, Date.now());
        else presentNames.delete(name);
    }

    function currentTableName() {
        const el = document.querySelector(".iogc-GameWindow .title");
        return el && el.getBoundingClientRect().width > 0 ? el.textContent.trim() : "";
    }

    // Name -> profile href, harvested from every profile link the page shows
    // (seat panels, leaderboard, following lists...). Profiles are keyed by
    // numeric id — there's no name-based URL — so watchers who never appear in
    // any list stay unlinked. Refreshed each render (cheap querySelectorAll).
    function profileLinks() {
        const map = {};
        document.querySelectorAll('a[href*="/profile/"]').forEach((a) => {
            const name = a.textContent.trim();
            const href = a.getAttribute("href");
            if (name && href && !map[name]) map[name] = href;
        });
        return map;
    }

    function seatedNames() {
        const names = new Set();
        document.querySelectorAll(".iogc-PlayerPanel-name").forEach((n) => {
            const t = n.textContent.trim();
            if (t && n.getBoundingClientRect().width > 0) names.add(t);
        });
        return names;
    }

    // The watcher count for this table, from the site's own public JSON API
    // (the same data the lobby's eye icons show). Polled at most every 30s and
    // only while the tools tab is open. Tournament tables may not be listed.
    function refreshViewerCount() {
        const table = rosterTable;
        if (!table) return;
        if (viewerInfo.table === table && Date.now() - viewerInfo.fetchedAt < 30000) return;
        viewerInfo = { table, count: -1, listed: null, fetchedAt: Date.now() }; // rate-limits failures too
        fetch("/api/gpokr/tables", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                noteLobbySnap(data); // same payload the lobby filter needs — share it
                if (!data || rosterTable !== table) return;
                const t = (data.tables || []).find((x) => x.name === table);
                if (t) { viewerInfo.count = t.viewerCount; viewerInfo.listed = true; }
                else { viewerInfo.listed = false; } // tournament/SNG: count not exposed
                renderRoster();
            })
            .catch(() => {});
    }

    function trackRoster() {
        const table = currentTableName();
        // Ignore transient empty titles (they blank out between hands) — only
        // react to a real, changed table name.
        if (table && table !== rosterTable) {
            const firstSight = rosterTable === "";
            rosterTable = table;
            presentNames.clear();
            if (!firstSight) resetHandScope(); // switching tables: don't merge the old table's hand into the new one
            viewerInfo = { table: "", count: -1, listed: null, fetchedAt: 0 }; // re-verify for the new table
            // Seed presence from the chat panel ONLY on the first sighting (a
            // fresh page load, where the panel holds this table's history). On
            // an in-session anchor switch GWT keeps the *previous* table's chat
            // in the same panel, so seeding there would carry stale watchers
            // over (the reported bug) — start empty and let live "is here" /
            // "has left" events refill it.
            if (firstSight) {
                document.querySelectorAll(".iogc-ChatPanel-messages div.gwt-HTML").forEach((e) => {
                    const b = e.querySelector("b");
                    if (b) { notePresence(b.textContent.trim(), true); return; }
                    const m = e.textContent.trim().match(/^(.+?) (is here|has left)$/);
                    if (m) notePresence(m[1].trim(), m[2] === "is here");
                });
            }
        }
        if (sideTab === "roster") { refreshViewerCount(); refreshFollowing(false); }
        renderRoster();
    }

    // Anchor-based table switches don't reload the page, so reset roster
    // presence the instant the hash changes rather than waiting for the next
    // poll; trackRoster then picks up the new table name and re-verifies count.
    window.addEventListener("hashchange", () => {
        presentNames.clear();
        resetHandScope(); // drop the previous table's accumulated hand the instant we navigate
        viewerInfo = { table: "", count: -1, listed: null, fetchedAt: 0 };
        forceRosterRender();
    });

    // ---------- follow / unfollow (the site's "watch someone") ----------
    // Same API the site's Preferences > Following tab uses:
    //   GET  /api/gpokr/me/following            -> ["name", ...]
    //   POST /api/gpokr/user/{name}/following   body true|false
    let followingSet = new Set();
    let followingFetchedAt = 0;

    function forceRosterRender() {
        const box = document.getElementById("gpe-roster");
        if (box) box._gpeKey = "";
        renderRoster();
    }

    function refreshFollowing(force) {
        if (!force && Date.now() - followingFetchedAt < 30000) return;
        followingFetchedAt = Date.now();
        fetch("/api/gpokr/me/following", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((names) => {
                if (!Array.isArray(names)) return;
                followingSet = new Set(names);
                forceRosterRender();
            })
            .catch(() => {});
    }

    function setFollowing(name, follow) {
        if (follow) followingSet.add(name); else followingSet.delete(name); // optimistic
        forceRosterRender();
        fetch("/api/gpokr/user/" + encodeURIComponent(name) + "/following", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(!!follow),
        }).then(() => refreshFollowing(true), () => refreshFollowing(true)); // confirm either way
    }

    function renderRoster() {
        const box = document.getElementById("gpe-roster");
        if (!box) return;
        const seated = seatedNames();
        const me = getMyName();
        if (me) notePresence(me, true); // I'm certainly here
        const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
        const playing = Array.from(seated).sort(byName);
        const watching = Array.from(presentNames.keys())
            .filter((n) => !seated.has(n))
            .sort(byName);

        // Watcher total: authoritative when the table is in the public list,
        // otherwise unverifiable (tournament/SNG) — we then show only observed.
        const verified = viewerInfo.table === rosterTable && viewerInfo.listed === true && viewerInfo.count >= 0;
        const unverifiable = viewerInfo.table === rosterTable && viewerInfo.listed === false;
        const unknownCount = verified ? Math.max(0, viewerInfo.count - watching.length) : 0;
        const links = profileLinks();

        // Skip the DOM churn when nothing changed (stars + linked-state included).
        const key = rosterTable + "|" + playing.join(",") + "|" + watching.join(",") +
            "|" + unknownCount + "|" + verified + "|" + unverifiable +
            "|" + playing.concat(watching).map((n) =>
                (followingSet.has(n) ? 1 : 0) + (isMuted(n) ? "M" : "") + (links[n] ? "L" : "")).join();
        if (box._gpeKey === key) return;
        box._gpeKey = key;

        box.textContent = "";
        if (!rosterTable) { box.textContent = "not at a table"; return; }
        const group = (label, count, names, unknownCount, note) => {
            const head = document.createElement("div");
            head.className = "gpe-roster-group";
            const lbl = document.createElement("span");
            lbl.textContent = label;
            const cnt = document.createElement("span");
            cnt.className = "gpe-roster-count";
            cnt.textContent = count;
            head.appendChild(lbl);
            head.appendChild(cnt);
            box.appendChild(head);
            if (!names.length && !unknownCount && !note) {
                const empty = document.createElement("div");
                empty.className = "gpe-roster-empty";
                empty.textContent = "no one";
                box.appendChild(empty);
                return;
            }
            for (const n of names) {
                const row = document.createElement("div");
                row.className = "gpe-roster-row";
                const followed = followingSet.has(n);
                const star = document.createElement("button");
                star.type = "button";
                star.className = "gpe-follow-star" + (followed ? " gpe-followed" : "");
                star.textContent = followed ? "★" : "☆";
                star.title = (followed ? "unfollow " : "follow ") + n;
                star.addEventListener("click", () => setFollowing(n, !followingSet.has(n)));
                // Mute, right beside the star: the roster is where you're already
                // looking when someone becomes a problem.
                const muted = isMuted(n);
                const mute = document.createElement("button");
                mute.type = "button";
                mute.className = "gpe-mute-btn" + (muted ? " gpe-muted" : "");
                mute.textContent = muted ? "🔇" : "🔈";
                mute.title = (muted ? "unmute " : "mute ") + n + " in chat";
                mute.addEventListener("click", () => setMuted(n, !isMuted(n)));
                // Name links to the player's profile when the page has exposed
                // their id; opens in a new tab so the table isn't navigated away.
                let nameEl;
                if (links[n]) {
                    nameEl = document.createElement("a");
                    nameEl.href = links[n];
                    nameEl.target = "_blank";
                    nameEl.rel = "noopener";
                    nameEl.title = "view " + n + "'s profile";
                } else {
                    nameEl = document.createElement("span");
                }
                nameEl.className = "gpe-roster-name";
                nameEl.textContent = n;
                row.appendChild(star);
                row.appendChild(mute);
                row.appendChild(nameEl);
                box.appendChild(row);
            }
            // Watchers the API count proves exist but who left no named
            // footprint (arrived before we did, never spoke).
            if (unknownCount > 0) {
                const row = document.createElement("div");
                row.className = "gpe-roster-row gpe-roster-empty";
                row.textContent = "unknown (" + unknownCount + ")";
                box.appendChild(row);
            }
            // Tournament/SNG tables aren't in the public count API, so the
            // watcher total can't be verified — say so rather than imply it's
            // complete (lurkers who arrived before us leave no trace).
            if (note) {
                const n = document.createElement("div");
                n.className = "gpe-roster-note";
                n.textContent = note;
                box.appendChild(n);
            }
        };
        // Watching header: verified total (named + unknown) when listed; else
        // just the observed names, flagged as a partial count.
        const watchTotal = verified ? watching.length + unknownCount : watching.length;
        group("playing", String(playing.length), playing);
        group("watching", String(watchTotal), watching, unknownCount,
            unverifiable ? "observed only — total not shown for tournaments" : "");
    }

    function pollHandState() {
        updateHandScope(); // accumulate the full hand across polls (survives log trimming)
        updateOddsHud();
        addBetSizeButtons();
        trackRoster();
        scanDepartures();
        scanWinner();

        const ended = handHasEnded();
        if (!ended && lastEnded) {
            sharedThisHand = false; harvestedThisHand = false; lastHandCaptured = false; // new hand began -> reset guards
            handEpoch++;              // the next summary is a different hand's, never a rebuild of this one
            flushPendingLogSummary(); // drop the finished hand's cards in before this new hand
            // Keep [playername] through the bustout hand and one grace hand, then
            // drop it so "gg" never addresses a player who left several hands ago.
            if (lastDeparted && ++departedAgeHands > 1) lastDeparted = "";
        }
        lastEnded = ended;

        noteGameId(currentGameId()); // track the current/previous hand id for verification
        retryPendingShares(); // re-check shares that arrived before we knew the id

        if (ended && !harvestedThisHand) {
            harvestedThisHand = true;
            harvestHand(currentHandScope());
        }

        // Built on the first poll after the hand ends and kept up to date from
        // there: late reveals are the norm, not the exception.
        if (ended && HAND_SUMMARY) refreshHandSummary(true);

        // Snapshot my finished hand for the "share last hand" button, regardless
        // of the auto-share settings. Retries across polls until the Replay line
        // gives the id (needed so a peer can verify the reveal).
        if (ended && !lastHandCaptured) {
            const hand = readMyHand();
            const gameId = currentGameId();
            if (hand && (gameId || LOCAL_TEST)) {
                lastHandCaptured = true;
                const cards = hand.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
                lastHandShare = { cards, gameId, label: handLabelFor(cards) };
            }
        }

        if (ended && !sharedThisHand && (SHARE_HAND || shareNextHand || LOCAL_TEST)) {
            const hand = readMyHand();
            const gameId = currentGameId();
            // Wait for the Replay line so the shared token is bound to this hand;
            // without it a peer couldn't verify. LOCAL_TEST needs no id.
            if (hand && (gameId || LOCAL_TEST)) {
                const cards = hand.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
                sharedThisHand = true; // one share per hand; mid-hand sharing is impossible
                const label = handLabelFor(cards); // best hand vs the board that was shown
                if (LOCAL_TEST) showHandLocal(cards, label);
                else if (SHARE_HAND || shareNextHand) {
                    sendMessage(encodeHand(cards, gameId, label));
                    sharedLastGameId = gameId; // auto-shared -> the button shows as done
                    if (shareNextHand) setShareNextHand(false); // consume the one-shot
                }
            }
        }

        updateShareControlUI(); // swap the button/checkbox for the current game phase
    }

    // ---------- lobby: sort + tier filter for "Available Tables" ----------
    // The site's tile list is a flex column, so sorting is done with CSS `order`
    // and hiding with a class: GWT's own nodes are never moved or removed, which
    // matters because it re-renders that list constantly. Everything is re-applied
    // from the same 1.5s poll that installs the rest of our sidebar furniture.
    const LOBBY_SORTS = [
        ["site", "site order"],
        ["tier", "tier ↑"],
        ["-tier", "tier ↓"],
        ["-players", "most players"],
        ["players", "fewest players"],
    ];
    let LOBBY_SORT = "site";
    let LOBBY_TIERS = [];        // [] = show every tier; else the tier keys to show
    let LOBBY_MINE_ONLY = false; // show only tiers whose min entry my score meets

    // Tier metadata (min entry per tier) comes from the lobby endpoint's
    // `categories`. Refreshed at most every 30s, and only once the list is on
    // screen. The roster's viewer-count fetch feeds the same cache for free.
    let lobbySnap = { categories: [], at: 0, loading: false };
    function noteLobbySnap(data) {
        if (!data || !data.categories) return;
        lobbySnap.categories = data.categories;
        lobbySnap.at = Date.now();
    }
    function refreshLobbySnap() {
        if (lobbySnap.loading || Date.now() - lobbySnap.at < 30000) return;
        lobbySnap.loading = true;
        const done = (data) => {
            lobbySnap.loading = false;
            lobbySnap.at = Date.now(); // stamped on failure too, so a dead endpoint isn't hammered
            if (data) { noteLobbySnap(data); renderLobbyFilters(); }
        };
        fetch("/api/gpokr/tables", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then(done, () => done(null));
    }

    // Tier key = the tile's badge text, uppercased ("TIER 1", "TIER 0 SNG"), which
    // is the category name in caps. Union of the API's categories and whatever
    // badges are actually on screen, so nothing in the list is unfilterable.
    function lobbyTierMeta() {
        const out = new Map();
        for (const c of lobbySnap.categories) {
            if (!c || !c.name) continue;
            out.set(String(c.name).toUpperCase(), {
                label: c.name,
                min: typeof c.minimumScore === "number" ? c.minimumScore : null,
            });
        }
        for (const t of lobbyTiles()) {
            if (t.tier && !out.has(t.tier)) out.set(t.tier, { label: t.tier, min: null });
        }
        return out;
    }
    function lobbyList() { return document.querySelector(".iogc-AvailableGamePanel-list"); }
    function lobbyTiles() {
        const list = lobbyList();
        if (!list) return [];
        return Array.from(list.querySelectorAll(":scope > .iogc-AvailableGamePanel-tile")).map((el, i) => {
            const badge = el.querySelector(".iogc-AvailableGamePanel-categoryBadge");
            // The stats row is "<seated>/<seats>" then the bounty; find the one
            // shaped like a seat count rather than trusting its position.
            let players = -1;
            for (const s of el.querySelectorAll(".iogc-AvailableGamePanel-stat")) {
                const m = s.textContent.match(/(\d+)\s*\/\s*(\d+)/);
                if (m) { players = parseInt(m[1], 10); break; }
            }
            return { el, i, players, tier: badge ? badge.textContent.trim().toUpperCase() : "" };
        });
    }

    // "Tiers I can play" = my monthly score meets the tier's min entry (the site
    // labels it "Min Entry" in its own change-table dialog). While my score is
    // unknown the filter stays open rather than hiding the whole lobby.
    function lobbyTierAllowed(key, meta, score) {
        if (LOBBY_MINE_ONLY) {
            if (score == null) return true;
            const m = meta.get(key);
            return !m || m.min == null || score >= m.min;
        }
        return !LOBBY_TIERS.length || LOBBY_TIERS.includes(key);
    }

    function applyLobbyView() {
        const list = lobbyList();
        if (!list) return;
        refreshLobbySnap();
        const meta = lobbyTierMeta();
        const score = myMonthlyScore();
        const tiles = lobbyTiles();
        const visible = [];
        for (const t of tiles) {
            const ok = lobbyTierAllowed(t.tier, meta, score);
            t.el.classList.toggle("gpe-lobby-off", !ok);
            if (t.el.style.order) t.el.style.order = ""; // reset; re-assigned below when sorting
            if (ok) visible.push(t);
        }
        if (LOBBY_SORT !== "site") {
            const min = (t) => {
                const m = meta.get(t.tier);
                return m && m.min != null ? m.min : Number.MAX_SAFE_INTEGER;
            };
            const key = {
                tier: (t) => min(t),
                "-tier": (t) => -min(t),
                players: (t) => t.players,
                "-players": (t) => -t.players,
            }[LOBBY_SORT];
            visible
                .map((t) => ({ t, k: key(t) }))
                .sort((a, b) => a.k - b.k || a.t.i - b.t.i) // original order breaks ties
                .forEach(({ t }, n) => { t.el.style.order = String(n); });
        }
        syncLobbyControls(visible.length, tiles.length);
    }

    let lobbyPanelOpen = false; // session-only: survives the re-inserts below

    function ensureLobbyTools() {
        const list = lobbyList();
        if (!list) return;
        let bar = document.getElementById("gpe-lobby-bar");
        const fresh = !bar;
        if (fresh) bar = buildLobbyBar();
        // GWT re-renders this panel whenever the lobby changes, which can leave our
        // bar detached or in the wrong place. MOVE the existing node rather than
        // rebuilding it — a rebuild would drop the open filter panel mid-use.
        if (bar.nextElementSibling !== list) list.insertAdjacentElement("beforebegin", bar);
        if (fresh) renderLobbyFilters(); // needs the panel in the document
        applyLobbyView();
    }

    function buildLobbyBar() {
        const bar = document.createElement("div");
        bar.id = "gpe-lobby-bar";

        const sort = document.createElement("select");
        sort.id = "gpe-lobby-sort";
        sort.className = "gpe-lobby-sel";
        LOBBY_SORTS.forEach(([value, label]) => {
            const o = document.createElement("option");
            o.value = value;
            o.textContent = label;
            sort.appendChild(o);
        });
        sort.value = LOBBY_SORT;
        sort.addEventListener("change", () => {
            LOBBY_SORT = sort.value;
            saveSetting("lobbySort", LOBBY_SORT);
            applyLobbyView();
        });

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.id = "gpe-lobby-tiers";
        toggle.className = "gpe-lobby-btn";
        toggle.addEventListener("click", () => {
            const panel = document.getElementById("gpe-lobby-panel");
            if (!panel) return;
            lobbyPanelOpen = panel.hidden;
            panel.hidden = !lobbyPanelOpen;
            toggle.classList.toggle("gpe-open", lobbyPanelOpen);
            if (lobbyPanelOpen) renderLobbyFilters();
        });

        const note = document.createElement("div");
        note.id = "gpe-lobby-note";
        note.className = "gpe-lobby-note";
        note.hidden = true;

        const panel = document.createElement("div");
        panel.id = "gpe-lobby-panel";
        panel.className = "gpe-lobby-panel";
        panel.hidden = !lobbyPanelOpen;
        toggle.classList.toggle("gpe-open", lobbyPanelOpen);

        bar.appendChild(sort);
        bar.appendChild(toggle);
        bar.appendChild(note);
        bar.appendChild(panel);
        return bar;
    }

    // Panel body: the "only tiers I can play" mode, then one row per tier with its
    // min entry. Rebuilt whenever the tier list or my score changes.
    function renderLobbyFilters() {
        const panel = document.getElementById("gpe-lobby-panel");
        if (!panel) return;
        const meta = lobbyTierMeta();
        const score = myMonthlyScore();
        const key = JSON.stringify([[...meta.keys()], score, LOBBY_MINE_ONLY, LOBBY_TIERS]);
        if (panel._gpeKey === key) return; // nothing changed -> don't churn the DOM
        panel._gpeKey = key;
        panel.textContent = "";

        const mine = document.createElement("label");
        mine.className = "gpe-lobby-row";
        const mineBox = document.createElement("input");
        mineBox.type = "checkbox";
        mineBox.id = "gpe-lobby-mine";
        mineBox.checked = LOBBY_MINE_ONLY;
        mineBox.addEventListener("change", () => {
            LOBBY_MINE_ONLY = mineBox.checked;
            saveSetting("lobbyMineOnly", LOBBY_MINE_ONLY);
            panel._gpeKey = ""; // the per-tier rows change state with the mode
            renderLobbyFilters();
            applyLobbyView();
        });
        mine.appendChild(mineBox);
        mine.appendChild(document.createTextNode("only tiers I can play"));
        panel.appendChild(mine);
        if (LOBBY_MINE_ONLY && score == null) {
            const hint = document.createElement("div");
            hint.className = "gpe-lobby-hint";
            hint.textContent = "waiting for my score…";
            panel.appendChild(hint);
        }

        const rule = document.createElement("div");
        rule.className = "gpe-lobby-rule";
        panel.appendChild(rule);

        const tiers = [...meta.entries()].sort((a, b) => {
            const am = a[1].min == null ? Number.MAX_SAFE_INTEGER : a[1].min;
            const bm = b[1].min == null ? Number.MAX_SAFE_INTEGER : b[1].min;
            return am - bm || a[1].label.localeCompare(b[1].label);
        });
        for (const [tierKey, m] of tiers) {
            const row = document.createElement("label");
            row.className = "gpe-lobby-row" + (LOBBY_MINE_ONLY ? " gpe-dim" : "");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.disabled = LOBBY_MINE_ONLY;
            // In "only mine" mode the boxes mirror eligibility (read-only); otherwise
            // an empty filter list means everything is on.
            box.checked = LOBBY_MINE_ONLY
                ? lobbyTierAllowed(tierKey, meta, score)
                : (!LOBBY_TIERS.length || LOBBY_TIERS.includes(tierKey));
            box.addEventListener("change", () => {
                const boxes = [...panel.querySelectorAll(".gpe-lobby-tier")];
                const on = boxes.filter((b) => b.checked).map((b) => b.dataset.tier);
                LOBBY_TIERS = on.length === boxes.length ? [] : on; // all checked = no filter
                saveSetting("lobbyTiers", LOBBY_TIERS);
                panel._gpeKey = "";
                applyLobbyView();
            });
            box.className = "gpe-lobby-tier";
            box.dataset.tier = tierKey;
            const label = document.createElement("span");
            label.textContent = m.label;
            const minEntry = document.createElement("span");
            minEntry.className = "gpe-lobby-min";
            minEntry.textContent = m.min == null ? "" : "$" + m.min.toLocaleString();
            row.appendChild(box);
            row.appendChild(label);
            row.appendChild(minEntry);
            panel.appendChild(row);
        }

        const foot = document.createElement("div");
        foot.className = "gpe-lobby-foot";
        const setAll = (pick) => {
            LOBBY_TIERS = pick;
            saveSetting("lobbyTiers", LOBBY_TIERS);
            panel._gpeKey = "";
            renderLobbyFilters();
            applyLobbyView();
        };
        const allBtn = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = "gpe-lobby-link";
        allBtn.textContent = "all";
        allBtn.disabled = LOBBY_MINE_ONLY;
        allBtn.addEventListener("click", () => setAll([]));
        const noneBtn = document.createElement("button");
        noneBtn.type = "button";
        noneBtn.className = "gpe-lobby-link";
        noneBtn.textContent = "none";
        noneBtn.disabled = LOBBY_MINE_ONLY;
        // A single impossible key hides everything without meaning "no filter".
        noneBtn.addEventListener("click", () => setAll([" none"]));
        foot.appendChild(allBtn);
        foot.appendChild(noneBtn);
        panel.appendChild(foot);
    }

    // Keep the bar's own widgets truthful (settings can also change from the popup
    // or another tab) and report what the current filter leaves visible.
    function syncLobbyControls(shown, total) {
        const sort = document.getElementById("gpe-lobby-sort");
        if (sort && sort.value !== LOBBY_SORT) sort.value = LOBBY_SORT;
        const toggle = document.getElementById("gpe-lobby-tiers");
        if (toggle) {
            const label = LOBBY_MINE_ONLY ? "mine"
                : !LOBBY_TIERS.length ? "all"
                : String(LOBBY_TIERS.filter((t) => t !== " none").length);
            toggle.textContent = "tiers: " + label + " ▾";
        }
        const note = document.getElementById("gpe-lobby-note");
        if (note) {
            note.hidden = !(total && !shown);
            if (!note.hidden) note.textContent = "no tables match this filter";
        }
        const mineBox = document.getElementById("gpe-lobby-mine");
        if (mineBox && mineBox.checked !== LOBBY_MINE_ONLY) {
            const panel = document.getElementById("gpe-lobby-panel");
            if (panel) panel._gpeKey = "";
            renderLobbyFilters();
        }
    }

    // ---------- sending ----------
    function getChatInput() {
        return document.querySelector(".iogc-MessagePanel input[type=text]") ||
            document.querySelector(".iogc-ChatPanel input[type=text]");
    }
    function getSendButton(input) {
        const panel = input.closest(".iogc-MessagePanel") || input.closest("table");
        if (!panel) return null;
        return Array.from(panel.querySelectorAll("button")).find((b) => b.textContent.trim() === "Send") || null;
    }
    function sendMessage(message) {
        const input = getChatInput();
        if (!input) return;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, message);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        ["keydown", "keypress", "keyup"].forEach((type) => {
            input.dispatchEvent(new KeyboardEvent(type, {
                bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13
            }));
        });
        setTimeout(() => {
            if (input.value === message) {
                const send = getSendButton(input);
                if (send) send.click();
                setTimeout(() => { if (input.value === message) setter.call(input, ""); }, 150);
            }
        }, 60);
    }

    // ---------- UI: blind-multiple bet sizing ----------
    // Sits next to the bet input inside the action bar, so it shows/hides with
    // it. 2x/3x = that multiple of the big blind; all in = my full stack.
    // Amounts the site considers illegal (below min raise, over stack) are
    // clamped by the game itself on submit.

    // Big blind from the table status label, e.g. "9 player ring, $25/$50".
    // (Blind posts are never written to the game log.)
    function parseBigBlind() {
        const status = document.querySelector(".iogc-GameWindow-status");
        if (!status) return 0;
        const m = status.textContent.match(/\$\s*[\d,]+\s*\/\s*\$\s*([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
    }

    // My chip stack, from my (visible) seat panel.
    // A seat's chip stack, read from its "Chips" stat row specifically. (Not
    // parseMoney(panel.textContent): the bet-readout swaps the "Level" row for a
    // "$" amount, which would otherwise be the first dollar value matched.)
    function seatChips(panel) {
        for (const row of panel.querySelectorAll(".iogc-PlayerStatsPanel")) {
            const lab = row.querySelector(".gwt-InlineLabel");
            if (lab && lab.textContent.trim() === "Chips") {
                const val = row.querySelector(".iogc-PlayerPanel-stat");
                if (val) return parseMoney(val.textContent);
            }
        }
        return 0;
    }

    function myStack() {
        const me = getMyName();
        if (!me) return 0;
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            if (getSeatName(p) !== me) continue;
            if (p.getBoundingClientRect().width === 0) continue;
            const v = seatChips(p);
            if (v) return v;
        }
        return 0;
    }

    // Raise-to = call amount + fraction of the pot after calling.
    function potBet(frac) {
        const { pot, toCall } = parsePotAndToCall();
        return toCall + Math.round((pot + toCall) * frac);
    }

    // Trim float noise for labels: 0.6700000000000001 -> "0.67"
    function fmtMult(m) { return String(parseFloat(m.toFixed(4))); }

    // Build one column's button list from BET_CONFIG, in the user's defined
    // order. "all in" is just another entry now (see the "allin" base).
    function betButtonsFor(pos) {
        const btns = [];
        for (const c of BET_CONFIG) {
            if (c.pos !== pos) continue;
            if (c.base === "allin") {
                btns.push(["all in", () => myStack()]);
            } else if (c.base === "blind") {
                btns.push([fmtMult(c.mult) + "x blind", () => Math.round(c.mult * parseBigBlind())]);
            } else {
                btns.push([c.mult === 1 ? "pot" : fmtMult(c.mult) + "x pot", () => potBet(c.mult)]);
            }
        }
        return btns;
    }

    // Float a column flush against the bet input (above or below), matching
    // its width; hidden whenever the input is (i.e. not my turn to bet).
    function placeBetColumn(wrap, below) {
        const input = document.querySelector("input.gpokr-GameWindow-betInput");
        const r = input ? input.getBoundingClientRect() : null;
        if (!r || r.width === 0) { wrap.style.display = "none"; return; }
        wrap.style.display = "";
        wrap.style.width = r.width + "px";
        wrap.style.left = r.left + "px";
        wrap.style.top = (below ? r.bottom : r.top - wrap.offsetHeight) + "px";
    }

    // Write a value into the bet input the way GWT expects: via the native
    // value setter, then fire input/change so the site's model picks it up.
    function setBetInput(inp, amount) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, String(amount));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function makeBetColumn(id, btns, below) {
        if (!btns.length || document.getElementById(id)) return;
        const wrap = document.createElement("div");
        wrap.id = id;
        wrap.className = "gpe-bet-col";
        btns.forEach(([label, amountFn]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.addEventListener("click", () => {
                const inp = document.querySelector("input.gpokr-GameWindow-betInput");
                if (!inp) return;
                const amount = amountFn();
                if (!amount) return; // blind/stack/pot not readable yet
                setBetInput(inp, amount);
            });
            wrap.appendChild(b);
        });
        document.body.appendChild(wrap);
        placeBetColumn(wrap, below);
        wrap._gpeReposition = setInterval(() => placeBetColumn(wrap, below), 200);
    }

    function addBetSizeButtons() {
        if (!SHOW_BET_BUTTONS) return;
        makeBetColumn("gpe-bet-sizes", betButtonsFor("top"), false);
        makeBetColumn("gpe-pot-sizes", betButtonsFor("bottom"), true);
    }

    // Tear down and recreate both columns (after a config change from the popup).
    function rebuildBetColumns() {
        for (const id of ["gpe-bet-sizes", "gpe-pot-sizes"]) {
            const el = document.getElementById(id);
            if (el) { clearInterval(el._gpeReposition); el.remove(); }
        }
        addBetSizeButtons();
    }

    // ---------- UI: in-page bet-button editor ----------
    // A modal that edits the same betButtons config the popup does; saving goes
    // through saveSetting, so storage.onChanged rebuilds the columns and the
    // popup UI mirrors it (and vice versa).
    let betEditorList = null;   // working copy while the modal is open
    let betEditorDrag = null;   // index of the row being dragged

    function makeBetSelect(options, value, onChange, labelOf) {
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

    function commitBetEditor() {
        saveSetting("betButtons", betEditorList.map((c) => ({ mult: c.mult, base: c.base, pos: c.pos })));
        renderBetEditorRows(); // reflect adds/deletes/reorders immediately
    }

    function renderBetEditorRows() {
        const wrap = document.getElementById("gpe-bet-editor-rows");
        if (!wrap) return;
        wrap.textContent = "";
        betEditorList.forEach((c, i) => {
            const row = document.createElement("div");
            row.className = "gpe-bet-erow";

            const handle = document.createElement("span");
            handle.className = "gpe-drag";
            handle.textContent = "⠿";
            handle.title = "drag to reorder";
            handle.addEventListener("mousedown", () => { row.draggable = true; });
            row.addEventListener("dragstart", (e) => {
                betEditorDrag = i;
                row.classList.add("gpe-dragging");
                e.dataTransfer.effectAllowed = "move";
            });
            row.addEventListener("dragend", () => {
                row.draggable = false;
                row.classList.remove("gpe-dragging");
                betEditorDrag = null;
            });
            row.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (betEditorDrag !== null && betEditorDrag !== i) row.classList.add("gpe-dragover");
            });
            row.addEventListener("dragleave", () => row.classList.remove("gpe-dragover"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("gpe-dragover");
                if (betEditorDrag === null || betEditorDrag === i) return;
                const moved = betEditorList.splice(betEditorDrag, 1)[0];
                betEditorList.splice(i, 0, moved);
                betEditorDrag = null;
                commitBetEditor();
            });

            const num = document.createElement("input");
            num.type = "number";
            num.min = "0";
            num.step = "any";
            num.value = c.mult;
            num.addEventListener("change", () => {
                const v = parseFloat(num.value);
                if (!isFinite(v) || v <= 0) { num.value = c.mult; return; } // reject junk, keep old
                betEditorList[i].mult = v;
                commitBetEditor();
            });

            const x = document.createElement("span");
            x.textContent = "×";

            // "all in" ignores the multiplier, so hide it (kept in state so a
            // switch back to blind/pot restores the old value).
            if (c.base === "allin") { num.style.display = "none"; x.style.display = "none"; }

            const base = makeBetSelect(["blind", "pot", "allin"], c.base,
                (v) => { betEditorList[i].base = v; commitBetEditor(); }, baseLabel);
            const pos = makeBetSelect(["top", "bottom"], c.pos, (v) => { betEditorList[i].pos = v; commitBetEditor(); });

            const del = document.createElement("button");
            del.className = "gpe-del";
            del.type = "button";
            del.textContent = "✕";
            del.title = "remove";
            del.addEventListener("click", () => { betEditorList.splice(i, 1); commitBetEditor(); });

            row.append(handle, num, x, base, pos, del);
            wrap.appendChild(row);
        });
    }

    function buildBetEditor() {
        const backdrop = document.createElement("div");
        backdrop.id = "gpe-bet-editor";
        backdrop.className = "gpe-modal-backdrop";
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeBetEditor(); });

        const modal = document.createElement("div");
        modal.className = "gpe-modal";

        const head = document.createElement("div");
        head.className = "gpe-modal-head";
        head.appendChild(document.createTextNode("Bet buttons"));
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "✕";
        close.title = "close";
        close.addEventListener("click", closeBetEditor);
        head.appendChild(close);

        const rows = document.createElement("div");
        rows.id = "gpe-bet-editor-rows";

        const add = document.createElement("button");
        add.id = "gpe-bet-add";
        add.type = "button";
        add.textContent = "+ Add button";
        add.addEventListener("click", () => { betEditorList.push({ mult: 1, base: "pot", pos: "bottom" }); commitBetEditor(); });

        const hint = document.createElement("div");
        hint.className = "gpe-modal-hint";
        hint.textContent = "multiplier × blind or pot — decimals OK (.5 = half). " +
            "Set a row's base to \"all in\" for the all-in button. " +
            "Top/bottom picks the column above or below the bet field; drag ⠿ to reorder.";

        modal.append(head, rows, add, hint);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        return backdrop;
    }

    function openBetEditor() {
        betEditorList = BET_CONFIG.map((c) => ({ mult: c.mult, base: c.base, pos: c.pos }));
        const backdrop = document.getElementById("gpe-bet-editor") || buildBetEditor();
        backdrop.style.display = "flex";
        renderBetEditorRows();
    }

    function closeBetEditor() {
        const backdrop = document.getElementById("gpe-bet-editor");
        if (backdrop) backdrop.style.display = "none";
    }

    // ---------- UI: 3D-table texture editor (felt / leather zoom sliders) ----------
    function closeTable3dEditor() {
        const b = document.getElementById("gpe-table3d-editor");
        if (b) b.style.display = "none";
    }
    function buildTable3dEditor() {
        // A floating panel (NOT a dimming modal), so the felt stays fully visible
        // while dragging the sliders.
        const modal = document.createElement("div");
        modal.id = "gpe-table3d-editor";
        modal.className = "gpe-modal gpe-float-panel";

        const head = document.createElement("div");
        head.className = "gpe-modal-head";
        head.appendChild(document.createTextNode("3D table textures"));
        const close = document.createElement("button");
        close.type = "button"; close.textContent = "✕"; close.title = "close";
        close.addEventListener("click", closeTable3dEditor);
        head.appendChild(close);

        // Each slider keeps a refresh() so openTable3dEditor can re-sync it to the
        // current setting. Live on drag (input), persisted on release (change).
        const refreshers = [];
        const makeSlider = (label, getVal, apply, saveKey, opts) => {
            const o = opts || {};
            const min = o.min != null ? o.min : 0.1, max = o.max != null ? o.max : 10, step = o.step || 0.05;
            const fmt = o.fmt || ((n) => n.toFixed(2) + "×");
            const row = document.createElement("div");
            row.className = "gpe-slider-row";
            const lab = document.createElement("span");
            lab.className = "gpe-slider-label"; lab.textContent = label;
            const s = document.createElement("input");
            s.type = "range"; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(getVal());
            const val = document.createElement("span");
            val.className = "gpe-slider-val"; val.textContent = fmt(getVal());
            s.addEventListener("input", () => { const z = parseFloat(s.value); val.textContent = fmt(z); apply(z); });
            s.addEventListener("change", () => saveSetting(saveKey, parseFloat(s.value)));
            refreshers.push(() => { const v = getVal(); s.value = String(v); val.textContent = fmt(v); });
            row.append(lab, s, val);
            return row;
        };

        const zoomOpts = { min: 0.1, max: 10, step: 0.05, fmt: (n) => n.toFixed(2) + "×" };
        const depthOpts = { min: 0, max: 3, step: 0.05, fmt: (n) => n.toFixed(2) };

        // A color swatch row (live on input, persisted on change).
        const makeColorRow = (label, getVal, apply, saveKey) => {
            const row = document.createElement("div");
            row.className = "gpe-slider-row";
            const lab = document.createElement("span");
            lab.className = "gpe-slider-label"; lab.textContent = label;
            const inp = document.createElement("input");
            inp.type = "color"; inp.className = "gpe-color-input"; inp.value = getVal();
            inp.addEventListener("input", () => apply(inp.value));
            inp.addEventListener("change", () => saveSetting(saveKey, inp.value));
            refreshers.push(() => { inp.value = getVal(); });
            row.append(lab, inp);
            return row;
        };

        const feltColor = makeColorRow("felt color",
            () => TABLE3D_FELT_COLOR,
            (c) => { TABLE3D_FELT_COLOR = c; if (window.GPE_TABLE3D) GPE_TABLE3D.setFeltColor(c); },
            "table3dFeltColor");
        // Background gets its own row shape: a color input can't express "unset",
        // so it pairs with an auto button that hands control back to the art.
        const bgRow = (() => {
            const row = document.createElement("div");
            row.className = "gpe-slider-row";
            const lab = document.createElement("span");
            lab.className = "gpe-slider-label"; lab.textContent = "background";
            const inp = document.createElement("input");
            inp.type = "color"; inp.className = "gpe-color-input";
            const auto = document.createElement("button");
            auto.type = "button"; auto.className = "gpe-reset-btn gpe-bg-auto";
            auto.textContent = "auto";
            auto.title = "match the table art behind the felt";
            const push = (v) => {
                TABLE3D_BG_COLOR = v;
                if (window.GPE_TABLE3D && GPE_TABLE3D.setSurroundColor) GPE_TABLE3D.setSurroundColor(v);
                auto.classList.toggle("gpe-on", !v);
            };
            inp.addEventListener("input", () => push(inp.value));
            inp.addEventListener("change", () => saveSetting("table3dBgColor", inp.value));
            auto.addEventListener("click", () => { push(""); saveSetting("table3dBgColor", ""); });
            refreshers.push(() => {
                inp.value = TABLE3D_BG_COLOR || "#000000";
                auto.classList.toggle("gpe-on", !TABLE3D_BG_COLOR);
            });
            row.append(lab, inp, auto);
            return row;
        })();

        // Floor under the table. A row of toggles rather than a color input,
        // because these are whole generated surfaces, not a value — and "none"
        // is one of the choices, which a color picker cannot express.
        const backdropRow = (() => {
            const row = document.createElement("div");
            row.className = "gpe-slider-row";
            const lab = document.createElement("span");
            lab.className = "gpe-slider-label"; lab.textContent = "floor";
            const group = document.createElement("div");
            group.className = "gpe-backdrop-group";
            const btns = [];
            const pick = (style) => {
                TABLE3D_BACKDROP = style;
                if (window.GPE_TABLE3D && GPE_TABLE3D.setBackdrop) GPE_TABLE3D.setBackdrop(style);
                saveSetting("table3dBackdrop", style);
                btns.forEach((b) => b.classList.toggle("gpe-on", b.dataset.style === style));
            };
            [["", "none"], ["grain", "grain"], ["glow", "glow"],
                ["carpet", "carpet"], ["clover", "clover"], ["deco", "deco"], ["wood", "wood"]]
                .forEach(([style, label]) => {
                    const b = document.createElement("button");
                    b.type = "button";
                    b.className = "gpe-reset-btn gpe-backdrop-btn";
                    b.dataset.style = style;
                    b.textContent = label;
                    b.addEventListener("click", () => pick(style));
                    btns.push(b);
                    group.appendChild(b);
                });
            refreshers.push(() => {
                btns.forEach((b) => b.classList.toggle("gpe-on", b.dataset.style === TABLE3D_BACKDROP));
            });
            row.append(lab, group);
            return row;
        })();

        // Seats are their own row rather than part of the floor: they are
        // furniture, not a surface, and someone may want one without the other.
        const seatRow = (() => {
            const row = document.createElement("div");
            row.className = "gpe-slider-row";
            const lab = document.createElement("span");
            lab.className = "gpe-slider-label"; lab.textContent = "seats";
            const group = document.createElement("div");
            group.className = "gpe-backdrop-group";
            const btns = [];
            const pick = (style) => {
                TABLE3D_SEATS = style;
                if (window.GPE_TABLE3D && GPE_TABLE3D.setSeats) GPE_TABLE3D.setSeats(style);
                saveSetting("table3dSeats", style);
                btns.forEach((b) => b.classList.toggle("gpe-on", b.dataset.seat === style));
            };
            [["", "none"], ["stool", "stools"], ["chair", "chairs"]].forEach(([style, label]) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "gpe-reset-btn gpe-backdrop-btn";
                b.dataset.seat = style;
                b.textContent = label;
                b.addEventListener("click", () => pick(style));
                btns.push(b);
                group.appendChild(b);
            });
            refreshers.push(() => {
                btns.forEach((b) => b.classList.toggle("gpe-on", b.dataset.seat === TABLE3D_SEATS));
            });
            row.append(lab, group);
            return row;
        })();

        const leatherColor = makeColorRow("leather color",
            () => TABLE3D_LEATHER_COLOR,
            (c) => { TABLE3D_LEATHER_COLOR = c; if (window.GPE_TABLE3D) GPE_TABLE3D.setLeatherColor(c); },
            "table3dLeatherColor");

        const feltZoom = makeSlider("felt zoom",
            () => TABLE3D_FELT_ZOOM,
            (z) => { TABLE3D_FELT_ZOOM = z; if (window.GPE_TABLE3D) GPE_TABLE3D.setTexZoom(z, undefined); },
            "table3dFeltZoom", zoomOpts);
        const feltDepth = makeSlider("felt depth",
            () => TABLE3D_FELT_DEPTH,
            (d) => { TABLE3D_FELT_DEPTH = d; if (window.GPE_TABLE3D) GPE_TABLE3D.setTexDepth(d, undefined); },
            "table3dFeltDepth", depthOpts);
        const leatherZoom = makeSlider("leather zoom",
            () => TABLE3D_LEATHER_ZOOM,
            (z) => { TABLE3D_LEATHER_ZOOM = z; if (window.GPE_TABLE3D) GPE_TABLE3D.setTexZoom(undefined, z); },
            "table3dLeatherZoom", zoomOpts);
        const leatherDepth = makeSlider("leather depth",
            () => TABLE3D_LEATHER_DEPTH,
            (d) => { TABLE3D_LEATHER_DEPTH = d; if (window.GPE_TABLE3D) GPE_TABLE3D.setTexDepth(undefined, d); },
            "table3dLeatherDepth", depthOpts);

        const logoOpacity = makeSlider("logo opacity",
            () => TABLE3D_LOGO_OPACITY,
            (o) => { TABLE3D_LOGO_OPACITY = o; if (window.GPE_TABLE3D) GPE_TABLE3D.setLogoOpacity(o); },
            "table3dLogoOpacity", { min: 0, max: 1, step: 0.05, fmt: (n) => Math.round(n * 100) + "%" });

        const hint = document.createElement("div");
        hint.className = "gpe-modal-hint";
        hint.textContent = "Zoom = feature size (0.1×–10×). Depth = relief strength. Floor = a generated "
            + "surface under the table, which also catches its shadow. Updates live; needs \"3D table\" on.";

        // ---- reset to defaults ----
        const resetRow = document.createElement("div");
        resetRow.className = "gpe-reset-row";
        const resetBtn = document.createElement("button");
        resetBtn.type = "button"; resetBtn.className = "gpe-reset-btn"; resetBtn.textContent = "Reset to defaults";
        resetBtn.addEventListener("click", () => {
            const d = TABLE3D_DEFAULTS;
            TABLE3D_FELT_COLOR = d.table3dFeltColor; TABLE3D_FELT_ZOOM = d.table3dFeltZoom; TABLE3D_FELT_DEPTH = d.table3dFeltDepth;
            TABLE3D_LEATHER_COLOR = d.table3dLeatherColor; TABLE3D_LEATHER_ZOOM = d.table3dLeatherZoom; TABLE3D_LEATHER_DEPTH = d.table3dLeatherDepth;
            TABLE3D_LOGO_OPACITY = d.table3dLogoOpacity;
            TABLE3D_BG_COLOR = d.table3dBgColor; TABLE3D_BACKDROP = d.table3dBackdrop;
            TABLE3D_SEATS = d.table3dSeats;
            if (window.GPE_TABLE3D) {
                GPE_TABLE3D.setTexZoom(TABLE3D_FELT_ZOOM, TABLE3D_LEATHER_ZOOM);
                GPE_TABLE3D.setTexDepth(TABLE3D_FELT_DEPTH, TABLE3D_LEATHER_DEPTH);
                GPE_TABLE3D.setFeltColor(TABLE3D_FELT_COLOR);
                GPE_TABLE3D.setLeatherColor(TABLE3D_LEATHER_COLOR);
                GPE_TABLE3D.setLogoOpacity(TABLE3D_LOGO_OPACITY);
                if (GPE_TABLE3D.setSurroundColor) GPE_TABLE3D.setSurroundColor(TABLE3D_BG_COLOR);
                if (GPE_TABLE3D.setBackdrop) GPE_TABLE3D.setBackdrop(TABLE3D_BACKDROP);
                if (GPE_TABLE3D.setSeats) GPE_TABLE3D.setSeats(TABLE3D_SEATS);
            }
            Object.keys(d).forEach((k) => saveSetting(k, d[k]));
            modal._refresh();
        });
        resetRow.appendChild(resetBtn);

        modal._refresh = () => refreshers.forEach((fn) => fn());
        modal.append(head, feltColor, feltZoom, feltDepth, leatherColor, leatherZoom, leatherDepth, logoOpacity, bgRow, backdropRow, seatRow, hint, resetRow);
        document.body.appendChild(modal);
        return modal;
    }
    function openTable3dEditor() {
        const panel = document.getElementById("gpe-table3d-editor") || buildTable3dEditor();
        if (panel.style.display === "block") { panel.style.display = "none"; return; } // toggle
        if (panel._refresh) panel._refresh(); // reflect current values (may have changed)
        panel.style.display = "block";
    }

    // ---------- UI: quick-chat buttons ----------
    // Full text of each game-log line, read from the gwt-HTML rows rather than
    // logLines() — logLines() keeps only childless leaves, so a line whose player
    // name is a profile link (e.g. tournament finishes) is dropped. textContent
    // here includes linked/bold names.
    function logRowTexts() {
        return Array.from(document.querySelectorAll(".iogc-MessagePanel-messages div.gwt-HTML:not(.gpe-log-cards)"))
            .map((e) => e.textContent.trim()).filter(Boolean);
    }

    // Bottom-most line matching `re` (capture group 1 = name) whose name isn't
    // mine — the quick-chat tokens must always refer to someone else, never the
    // logged-in player. Advances the tracker only when that line is a new one,
    // so it survives the line later scrolling out of the log.
    function scanLastName(re, prevLine, set) {
        const me = getMyName();
        const rows = logRowTexts();
        for (let i = rows.length - 1; i >= 0; i--) {
            const m = rows[i].match(re);
            if (!m) continue;
            const name = m[1].trim();
            if (me && name === me) continue; // skip myself; look further back for someone else
            if (rows[i] !== prevLine) set(rows[i], name);
            return;
        }
    }

    // "NAME finishes the tournament Nth" is announced tournament-wide, so it also
    // names players busting out at OTHER tables — gg'ing them would be nonsense.
    // "NAME stands up" is table-local: the seat only empties in our own log. So a
    // finish counts only once we've also seen that player stand up. The stand-up
    // line can lag the finish by a poll (or land after the next hand starts), so
    // both the current hand and the visible log window are searched.
    function sawStandUp(name) {
        const re = /^(.+?) stands up\b/i;
        const has = (rows) => rows.some((l) => {
            const m = l.match(re);
            return m && m[1].trim() === name;
        });
        return has(fullHandScope()) || has(logRowTexts());
    }

    // [playername] = someone who busted THIS hand at our table (see sawStandUp).
    // Scoped to the current hand (not the whole log window) so a finisher from
    // many hands ago can't resurface; fullHandScope() survives the visible log
    // trimming mid-hand and keeps the linked-name row (logLines drops it).
    // Expiry (a one-hand grace) is handled at the new-hand edge in pollHandState.
    function scanDepartures() {
        const re = /^(.+?) finishes the tournament \d+(?:st|nd|rd|th)$/i;
        const me = getMyName();
        const rows = fullHandScope();
        for (let i = rows.length - 1; i >= 0; i--) {
            const m = rows[i].match(re);
            if (!m) continue;
            const name = m[1].trim();
            if (me && name === me) continue;   // never gg myself; look further back
            if (!sawStandUp(name)) continue;   // another table's bustout; keep looking
            lastDeparted = name;
            departedAgeHands = 0; // seen in the current hand -> fresh
            return;
        }
    }

    // [lastwinner] = main-pot winner of the most recent hand. Only the MAIN pot
    // counts (a side-pot line would otherwise win as the bottom-most match).
    function scanWinner() {
        scanLastName(/^(.+?) wins main pot \$[\d,]+/i,
            lastWinnerLine, (line, name) => { lastWinnerLine = line; lastWinner = name; });
    }

    // Fill the tokens, collapsing the space they leave when unknown
    // ("gg [playername]" -> "gg").
    function chatButtonMessage(template) {
        return template
            .replace(/\[playername\]/gi, displayName(lastDeparted))
            .replace(/\[lastwinner\]/gi, displayName(lastWinner))
            .replace(/\s+/g, " ").trim();
    }

    // Hover preview for a quick-chat button: the message as it would go out
    // right now, with the tokens filled in. A token whose player isn't known
    // yet drops out of the message, so name it rather than silently showing a
    // shorter line ("gg [playername]" with nobody busted -> "sends: gg").
    const CHAT_TOKENS = [
        { re: /\[playername\]/i, label: "[playername]", value: () => displayName(lastDeparted) },
        { re: /\[lastwinner\]/i, label: "[lastwinner]", value: () => displayName(lastWinner) },
    ];
    function chatButtonTip(b) {
        const used = CHAT_TOKENS.filter((t) => t.re.test(b.text));
        if (!used.length) {
            // No tokens: only worth a tip when the caption hides the message.
            return b.name && b.name !== b.text ? "sends: " + b.text : "";
        }
        const unknown = used.filter((t) => !t.value()).map((t) => t.label);
        const msg = chatButtonMessage(b.text);
        if (!msg) return "nothing to send yet — " + unknown.join(" and ") + " unknown";
        return "sends: " + msg + (unknown.length ? "  (" + unknown.join(" and ") + " unknown)" : "");
    }

    function renderChatButtons() {
        const wrap = document.getElementById("gpe-chat-btns");
        if (!wrap) return;
        hideInstantTip(); // the anchors below are about to be destroyed
        wrap.textContent = "";
        CHAT_CONFIG.forEach((b) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "gpe-chat-btn";
            btn.textContent = b.name || b.text;      // caption defaults to the message
            // Preview the outgoing message on hover — resolved at hover time so
            // the token values shown are the current ones.
            attachInstantTip(btn, () => chatButtonTip(b));
            btn.addEventListener("click", () => {
                const msg = chatButtonMessage(b.text);
                if (msg) sendMessage(msg);
            });
            wrap.appendChild(btn);
        });
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "gpe-chat-edit";
        edit.textContent = "✎";
        edit.title = "edit chat buttons";
        edit.addEventListener("click", openChatEditor);
        wrap.appendChild(edit);
    }

    // ---------- UI: quick-chat editor (modal, mirrors the bet-button editor) ----------
    let chatEditorList = null;  // working copy of the user's buttons while open
    let chatEditorDrag = null;

    function saveChatButtons() {
        saveSetting("chatButtons", chatEditorList
            .map((b) => ({ name: b.name.trim(), text: b.text.trim() }))
            .filter((b) => b.text));
    }
    function commitChatEditor() { // for structural changes (add/remove/reorder)
        saveChatButtons();
        renderChatEditorRows();
    }

    // name (short caption) + message inputs; live-update without re-rendering so
    // focus is kept, persist on blur/enter.
    function chatEditorInputs(row, b) {
        const name = document.createElement("input");
        name.type = "text";
        name.className = "gpe-chat-name";
        name.value = b.name;
        name.placeholder = "name";
        name.title = "button label (defaults to the message)";
        const txt = document.createElement("input");
        txt.type = "text";
        txt.className = "gpe-chat-text";
        txt.value = b.text;
        txt.placeholder = "message (use [playername])";
        name.addEventListener("input", () => { b.name = name.value; });
        name.addEventListener("change", saveChatButtons);
        txt.addEventListener("input", () => { b.text = txt.value; });
        txt.addEventListener("change", saveChatButtons);
        row.append(name, txt);
    }

    function renderChatEditorRows() {
        const wrap = document.getElementById("gpe-chat-editor-rows");
        if (!wrap) return;
        wrap.textContent = "";

        // Every button is editable, draggable, and removable.
        chatEditorList.forEach((b, i) => {
            const row = document.createElement("div");
            row.className = "gpe-bet-erow gpe-chat-erow";

            const handle = document.createElement("span");
            handle.className = "gpe-drag";
            handle.textContent = "⠿";
            handle.title = "drag to reorder";
            handle.addEventListener("mousedown", () => { row.draggable = true; });
            row.addEventListener("dragstart", (e) => {
                chatEditorDrag = i;
                row.classList.add("gpe-dragging");
                e.dataTransfer.effectAllowed = "move";
            });
            row.addEventListener("dragend", () => {
                row.draggable = false;
                row.classList.remove("gpe-dragging");
                chatEditorDrag = null;
            });
            row.addEventListener("dragover", (e) => {
                e.preventDefault();
                if (chatEditorDrag !== null && chatEditorDrag !== i) row.classList.add("gpe-dragover");
            });
            row.addEventListener("dragleave", () => row.classList.remove("gpe-dragover"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("gpe-dragover");
                if (chatEditorDrag === null || chatEditorDrag === i) return;
                const moved = chatEditorList.splice(chatEditorDrag, 1)[0];
                chatEditorList.splice(i, 0, moved);
                chatEditorDrag = null;
                commitChatEditor();
            });

            row.appendChild(handle);
            chatEditorInputs(row, b);

            const del = document.createElement("button");
            del.className = "gpe-del";
            del.type = "button";
            del.textContent = "✕";
            del.title = "remove";
            del.addEventListener("click", () => { chatEditorList.splice(i, 1); commitChatEditor(); });
            row.appendChild(del);

            wrap.appendChild(row);
        });
    }

    function buildChatEditor() {
        const backdrop = document.createElement("div");
        backdrop.id = "gpe-chat-editor";
        backdrop.className = "gpe-modal-backdrop";
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeChatEditor(); });

        const modal = document.createElement("div");
        modal.className = "gpe-modal";

        const head = document.createElement("div");
        head.className = "gpe-modal-head";
        head.appendChild(document.createTextNode("Chat buttons"));
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "✕";
        close.title = "close";
        close.addEventListener("click", closeChatEditor);
        head.appendChild(close);

        const rows = document.createElement("div");
        rows.id = "gpe-chat-editor-rows";

        const add = document.createElement("button");
        add.id = "gpe-chat-add";
        add.type = "button";
        add.textContent = "+ Add button";
        add.addEventListener("click", () => { chatEditorList.push({ name: "", text: "" }); commitChatEditor(); });

        const hint = document.createElement("div");
        hint.className = "gpe-modal-hint";
        hint.textContent = "Name is the button label (defaults to the message). The message is " +
            "what gets posted — use [playername] (last to finish the tournament) or " +
            "[lastwinner] (winner of the last hand). Add, rename, remove, or drag ⠿ to reorder.";

        modal.append(head, rows, add, hint);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        return backdrop;
    }

    function openChatEditor() {
        chatEditorList = CHAT_CONFIG.map((b) => ({ ...b }));
        const backdrop = document.getElementById("gpe-chat-editor") || buildChatEditor();
        backdrop.style.display = "flex";
        renderChatEditorRows();
    }

    function closeChatEditor() {
        const backdrop = document.getElementById("gpe-chat-editor");
        if (backdrop) backdrop.style.display = "none";
    }

    // ---------- muted players (manage) ----------
    // Mirrors the chat-buttons editor: a modal list with a remove per row and an add
    // at the bottom. The add box is backed by a datalist of everyone currently at the
    // table, since that's who you're usually muting — but free text works too, so
    // someone can be muted before they next show up.
    function buildMuteEditor() {
        const backdrop = document.createElement("div");
        backdrop.id = "gpe-mute-editor";
        backdrop.className = "gpe-modal-backdrop";
        backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeMuteEditor(); });

        const modal = document.createElement("div");
        modal.className = "gpe-modal";

        const head = document.createElement("div");
        head.className = "gpe-modal-head";
        head.appendChild(document.createTextNode("Muted players"));
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "✕";
        close.title = "close";
        close.addEventListener("click", closeMuteEditor);
        head.appendChild(close);

        const rows = document.createElement("div");
        rows.id = "gpe-mute-editor-rows";

        const addRow = document.createElement("div");
        addRow.id = "gpe-mute-add-row";
        const input = document.createElement("input");
        input.type = "text";
        input.id = "gpe-mute-add-name";
        input.placeholder = "player name";
        input.setAttribute("list", "gpe-mute-names");
        input.autocomplete = "off";
        const list = document.createElement("datalist");
        list.id = "gpe-mute-names";
        const add = document.createElement("button");
        add.type = "button";
        add.id = "gpe-mute-add";
        add.textContent = "+ Mute";
        const commit = () => {
            const n = input.value.trim();
            if (!n) return;
            setMuted(n, true);      // re-renders the rows
            input.value = "";
            input.focus();
        };
        add.addEventListener("click", commit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
        addRow.append(input, list, add);

        const hint = document.createElement("div");
        hint.className = "gpe-modal-hint";
        hint.textContent = "Muting hides that player's chat for you — the pane, the pop-out, and the " +
            "emotes and shared hands their messages trigger. It is local to you: they are not told, " +
            "and nothing about their play changes. Names match regardless of case. You can also mute " +
            "straight from the roster tab, next to the follow star.";

        modal.append(head, rows, addRow, hint);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        return backdrop;
    }

    // Safe to call whenever the list changes: a no-op while the modal is closed.
    function renderMuteEditorRows() {
        const rows = document.getElementById("gpe-mute-editor-rows");
        if (!rows) return;
        rows.textContent = "";
        if (!mutedList.length) {
            const empty = document.createElement("div");
            empty.className = "gpe-mute-empty";
            empty.textContent = "nobody muted";
            rows.appendChild(empty);
        }
        for (const name of mutedList) {
            const row = document.createElement("div");
            row.className = "gpe-mute-row";
            const who = document.createElement("span");
            who.className = "gpe-mute-name";
            who.textContent = name;
            const rm = document.createElement("button");
            rm.type = "button";
            rm.className = "gpe-mute-x";
            rm.textContent = "✕";
            rm.title = "unmute " + name;
            rm.addEventListener("click", () => setMuted(name, false));
            row.append(who, rm);
            rows.appendChild(row);
        }
        // Offer the table's current occupants for the add box.
        const dl = document.getElementById("gpe-mute-names");
        if (dl) {
            dl.textContent = "";
            const me = getMyName();
            const here = new Set();
            for (const n of seatedNames()) here.add(n);
            for (const n of Object.keys(profileLinks())) here.add(n);
            for (const n of [...here].sort()) {
                if (n === me || mutedKeys.has(n.toLowerCase())) continue;
                const o = document.createElement("option");
                o.value = n;
                dl.appendChild(o);
            }
        }
    }

    function openMuteEditor() {
        const backdrop = document.getElementById("gpe-mute-editor") || buildMuteEditor();
        backdrop.style.display = "flex";
        renderMuteEditorRows();
        const input = document.getElementById("gpe-mute-add-name");
        if (input) input.focus();
    }

    function closeMuteEditor() {
        const backdrop = document.getElementById("gpe-mute-editor");
        if (backdrop) backdrop.style.display = "none";
    }

    // ---------- chat popout ----------
    // A real browser window you can drag to another monitor. Built from the tapped
    // event stream rather than mirroring the site's chat pane: we already receive
    // every ChatEvent with its sender, text and messageId, so the popout is a first
    // class view instead of a scraped copy — and reactions work in it for free.
    //
    // The window is about:blank, which inherits our origin, so this tab builds and
    // updates its DOM directly. Nothing runs inside it: no script injection, no CSP
    // to satisfy, no content-script match rules. It is a passive view owned here.
    const CHAT_LOG_MAX = 300;
    const POPOUT_NAME = "gpe-chat-popout";
    const chatLog = [];              // {msgId, name, text}
    let popout = null;
    const popoutRows = new Map();    // messageId -> row element inside the popout

    function popoutAlive() {
        try { return !!(popout && !popout.closed && popout.document && popout.document.body); }
        catch (e) { return false; }  // window navigated away from our origin
    }

    function noteChatLine(entry) {
        chatLog.push(entry);
        if (chatLog.length > CHAT_LOG_MAX) chatLog.splice(0, chatLog.length - CHAT_LOG_MAX);
        if (popoutAlive()) appendPopoutRow(entry);
    }

    // Everything the popout needs, inlined: it can't load overlay.css (that isn't a
    // web-accessible resource, and wiring one up for a window we fully control would
    // be pointless). Follows the page's current theme.
    function popoutCss(dark) {
        const bg = dark ? "#161a22" : "#ffffff";
        const fg = dark ? "#e6ebf2" : "#222222";
        const dim = dark ? "#8a97ab" : "#6b7280";
        const line = dark ? "#2b3648" : "#e5e7eb";
        const chip = dark ? "#2b3648" : "#eceff3";
        const chipBorder = dark ? "#3c4a61" : "#d3d9e2";
        const mine = dark ? "#33465e" : "#dbe8f7";
        const mineBorder = dark ? "#5c7ea8" : "#8fb4dd";
        const inputBg = dark ? "#1f2530" : "#ffffff";
        return `
html,body{margin:0;padding:0;background:${bg};color:${fg};font:13px/1.45 Arial,Helvetica,sans-serif}
/* Viewport units, not height:100%: the chain html->body->flex only resolves
   reliably in standards mode, and 100vh is immune to how the document was made.
   overflow:hidden on body so the WINDOW never scrolls — only the log does. */
html{height:100%}
body{height:100vh;overflow:hidden;display:flex;flex-direction:column}
/* min-height:0 is the whole fix for the send row sliding below the fold: a flex
   item defaults to min-height:auto, so the log refused to shrink under its own
   content and pushed the body taller than the window. */
#log{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 10px}
.row{padding:2px 0;border-bottom:1px solid ${line};position:relative;word-wrap:break-word}
.row:last-child{border-bottom:none}
.who{font-weight:bold}
.txt{margin-left:4px}
.sys{color:${dim};font-style:italic}
.bar{margin-left:6px}
.badge{display:inline-block;margin:0 3px 0 0;padding:0 5px;font-size:11px;line-height:17px;border-radius:9px;
  background:${chip};border:1px solid ${chipBorder};cursor:default;user-select:none}
.badge.mine{background:${mine};border-color:${mineBorder}}
.add{display:none;position:absolute;right:2px;top:50%;transform:translateY(-50%);white-space:nowrap;
  padding:1px 4px;border-radius:10px;background:${bg};box-shadow:0 1px 5px rgba(0,0,0,.35);z-index:2}
.row:hover>.add{display:inline-block}
.add button{all:unset;cursor:pointer;font-size:14px;line-height:1;padding:1px 3px;border-radius:5px;opacity:.75}
.add button:hover{opacity:1}
#ctrls{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 8px 0}
.ctrl{all:unset;cursor:pointer;font:12px Arial,sans-serif;color:${fg};background:${chip};
  border:1px solid ${chipBorder};border-radius:6px;padding:3px 8px;line-height:1.3}
.ctrl:hover{border-color:${mineBorder}}
#send{flex:0 0 auto;display:flex;gap:6px;padding:8px;border-top:1px solid ${line}}
#send input{flex:1;box-sizing:border-box;padding:6px 8px;font:13px Arial,sans-serif;color:${fg};
  background:${inputBg};border:1px solid ${chipBorder};border-radius:6px}
#send button{all:unset;cursor:pointer;padding:6px 12px;border-radius:6px;background:${chip};
  border:1px solid ${chipBorder};font:12px Arial,sans-serif;color:${fg}}
#picker{position:fixed;display:none;grid-template-columns:repeat(8,30px);grid-auto-rows:30px;gap:3px;
  padding:8px;background:${bg};border:1px solid ${chipBorder};border-radius:10px;
  box-shadow:0 6px 22px rgba(0,0,0,.45);max-height:230px;overflow-y:auto;z-index:5}
#picker.open{display:grid}
#picker button{all:unset;cursor:pointer;font-size:18px;width:30px;height:30px;border-radius:6px;
  display:flex;align-items:center;justify-content:center}
#picker button:hover{background:${chip}}
#stale{display:none;padding:6px 10px;background:#7f1d1d;color:#fff;font-size:12px}
`;
    }

    function buildPopout(w) {
        const dark = document.documentElement.classList.contains("gpe-dark");
        const d = w.document;
        // Written with a doctype rather than assembled into the blank document:
        // about:blank has none, which lands the window in QUIRKS mode where the
        // percentage-height chain misbehaves. One write, then DOM as usual.
        d.open();
        d.write("<!doctype html><html><head><meta charset=\"utf-8\"><title>GPokr chat</title></head><body></body></html>");
        d.close();
        const style = d.createElement("style");
        style.textContent = popoutCss(dark);
        d.head.appendChild(style);
        const body = d.body;
        const stale = d.createElement("div");
        stale.id = "stale";
        stale.textContent = "the gpokr tab this was opened from has gone — reopen it there";
        const log = d.createElement("div");
        log.id = "log";
        const sendRow = d.createElement("div");
        sendRow.id = "send";
        const input = d.createElement("input");
        input.type = "text";
        input.placeholder = "message…";
        const btn = d.createElement("button");
        btn.textContent = "Send";
        const picker = d.createElement("div");
        picker.id = "picker";

        // The same controls as the in-page row. Built here rather than cloned: the
        // nodes have to belong to the popout's document, and the behaviour comes from
        // reusing chatButtonMessage()/sendMessage() so tokens like [playername]
        // resolve exactly as they do in the page.
        const ctrls = d.createElement("div");
        ctrls.id = "ctrls";
        const emote = d.createElement("button");
        emote.className = "ctrl";
        emote.textContent = "😀";
        emote.title = "send an emote";
        emote.addEventListener("click", (e) => {
            e.stopPropagation();
            const p = picker;
            p._msgId = 0;              // 0 = send as a message, not as a reaction
            p.classList.add("open");
            const r = emote.getBoundingClientRect();
            const ph = p.offsetHeight || 200;
            p.style.left = Math.max(4, Math.min(r.left, w.innerWidth - 260)) + "px";
            p.style.top = (r.top - ph - 6 > 4 ? r.top - ph - 6 : r.bottom + 6) + "px";
        });
        ctrls.appendChild(emote);
        w._gpeCtrls = ctrls;

        // Sending goes back through the page's own chat input (sendMessage), so the
        // popout needs no API of its own and inherits whatever the site allows.
        const submit = () => {
            const text = input.value.trim();
            if (!text) return;
            input.value = "";
            sendMessage(text);
        };
        btn.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });

        EMOTES.forEach((glyph) => {
            const b = d.createElement("button");
            b.textContent = glyph;
            b.addEventListener("click", () => {
                const id = picker._msgId;
                picker.classList.remove("open");
                // Opened from a line: react to it. Opened from the emote button:
                // send it as a message, same as the in-page picker does.
                if (id) sendReaction(id, glyph);
                else sendMessage(glyph);
            });
            picker.appendChild(b);
        });
        body.addEventListener("mousedown", (e) => {
            if (picker.classList.contains("open") && !picker.contains(e.target)) picker.classList.remove("open");
        });

        body.append(stale, log, ctrls, sendRow, picker);
        sendRow.append(input, btn);
        w._gpeLog = log;
        renderPopoutChatButtons(w);
        w._gpePicker = picker;
        return w;
    }

    // Mirrors renderChatButtons() into the popout. Kept as its own function so the
    // popout can be refreshed when the user edits their buttons in the page.
    function renderPopoutChatButtons(w) {
        if (!w || !w._gpeCtrls) return;
        const d = w.document;
        const ctrls = w._gpeCtrls;
        // Wipe everything after the emote button and rebuild.
        while (ctrls.children.length > 1) ctrls.removeChild(ctrls.lastChild);
        CHAT_CONFIG.forEach((b) => {
            const btn = d.createElement("button");
            btn.className = "ctrl quick";
            btn.textContent = b.name || b.text;
            btn.title = b.text;
            btn.addEventListener("click", () => {
                const msg = chatButtonMessage(b.text);   // resolves [playername] etc. live
                if (msg) sendMessage(msg);
            });
            ctrls.appendChild(btn);
        });
    }

    function appendPopoutRow(entry) {
        const w = popout, d = w.document, log = w._gpeLog;
        if (!log) return;
        if (isMuted(entry.name)) return;   // the popout is a first-class view: mute applies here too
        const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
        const row = d.createElement("div");
        row.className = "row";
        if (entry.name) {
            const who = d.createElement("span");
            who.className = "who";
            who.textContent = entry.name + ":";
            const txt = d.createElement("span");
            txt.className = "txt";
            txt.textContent = entry.text;
            row.append(who, txt);
        } else {
            row.className = "row sys";
            row.textContent = entry.text;
        }
        if (entry.msgId) {
            const add = d.createElement("span");
            add.className = "add";
            for (const emoji of QUICK_REACTIONS.concat(["➕"])) {
                const b = d.createElement("button");
                b.textContent = emoji;
                b.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (emoji === "➕") {
                        const p = w._gpePicker;
                        p._msgId = entry.msgId;
                        p.classList.add("open");
                        const r = b.getBoundingClientRect();
                        const ph = p.offsetHeight || 200;
                        p.style.left = Math.max(4, Math.min(r.left - 120, w.innerWidth - 260)) + "px";
                        p.style.top = (r.top - ph - 6 > 4 ? r.top - ph - 6 : r.bottom + 6) + "px";
                    } else {
                        sendReaction(entry.msgId, emoji);
                    }
                });
                add.appendChild(b);
            }
            row.appendChild(add);
            popoutRows.set(entry.msgId, row);
        }
        log.appendChild(row);
        if (atBottom) log.scrollTop = log.scrollHeight;   // don't yank the view if they scrolled up
        if (entry.msgId) updatePopoutReactions(entry.msgId);
    }

    function updatePopoutReactions(msgId) {
        if (!popoutAlive()) return;
        const row = popoutRows.get(msgId);
        if (!row || !row.isConnected) return;
        const d = popout.document;
        const byEmoji = reactionsByMsgId.get(msgId);
        let bar = row.querySelector(".bar");
        if (!byEmoji || !byEmoji.size) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = d.createElement("span");
            bar.className = "bar";
            const add = row.querySelector(".add");
            row.insertBefore(bar, add || null);
        }
        bar.textContent = "";
        const me = getMyName();
        for (const [emoji, names] of byEmoji) {
            const b = d.createElement("span");
            b.className = "badge" + (me && names.has(me) ? " mine" : "");
            b.textContent = names.size > 1 ? emoji + " " + names.size : emoji;
            b.title = Array.from(names).join(", ");
            bar.appendChild(b);
        }
    }

    function renderPopoutAll() {
        if (!popoutAlive()) return;
        popoutRows.clear();
        popout._gpeLog.textContent = "";
        for (const entry of chatLog) appendPopoutRow(entry);
        popout._gpeLog.scrollTop = popout._gpeLog.scrollHeight;
    }

    // Seed from the lines already on screen, so a freshly opened popout isn't empty.
    // These have no messageId (their events predate us or were never matched), so
    // they show but can't be reacted to — same honesty rule as the in-page pane.
    function seedChatLog() {
        if (chatLog.length) return;
        for (const node of document.querySelectorAll(".iogc-ChatPanel-messages div.gwt-HTML")) {
            const nameEl = node.querySelector("b");
            const text = nameEl
                ? node.textContent.slice(nameEl.textContent.length).replace(/^\s*:\s*/, "")
                : node.textContent.trim();
            if (!text) continue;
            chatLog.push({ msgId: node._gpeMsgId || 0, name: nameEl ? nameEl.textContent.trim() : "", text });
        }
    }

    function openChatPopout() {
        seedChatLog();
        // A NAMED window: clicking again focuses the existing one instead of
        // stacking duplicates, and a page reload re-attaches to the same window
        // rather than orphaning it.
        let w = null;
        try {
            w = window.open("", POPOUT_NAME, "popup=yes,width=440,height=660");
        } catch (e) { w = null; }
        if (!w) {
            console.warn("[gpe] chat popout blocked — allow popups for gpokr.com");
            return;
        }
        popout = w;
        buildPopout(w);
        renderPopoutAll();
        try { w.focus(); } catch (e) {}
    }

    // If this tab goes away the popout can't be fed any more; say so in it rather
    // than leaving a window that silently stops updating.
    window.addEventListener("beforeunload", () => {
        if (!popoutAlive()) return;
        try {
            const s = popout.document.getElementById("stale");
            if (s) s.style.display = "block";
        } catch (e) {}
    });

    // Lives at the far right of the action bar (pot / fold / call / raise), not in
    // the chat row. GWT rebuilds that bar between hands, so this is re-checked on
    // the poll and re-attaches when its host is replaced — same approach as the
    // splash button.
    function addChatPopoutButton() {
        const bar = document.querySelector(".iogc-Controls");
        if (!bar) return;
        const existing = document.getElementById("gpe-popout-btn");
        if (existing && existing.parentElement === bar) return;
        if (existing) existing.remove();   // stale: the bar was rebuilt under it
        bar.classList.add("gpe-controls-host");   // positioning context for the button

        const b = document.createElement("button");
        b.id = "gpe-popout-btn";
        b.type = "button";
        b.title = "pop chat out into its own window (drag it to another monitor)";
        b.textContent = "⧉";
        b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();   // the bar's own cells have handlers
            openChatPopout();
        });
        bar.appendChild(b);
    }

    // ---------- UI: emote picker ----------
    function addPicker() {
        const input = getChatInput();
        if (!input || document.getElementById("gpe-picker-btn")) return;

        const btn = document.createElement("button");
        btn.id = "gpe-picker-btn";
        btn.type = "button";
        btn.textContent = "😀";

        const panel = document.createElement("div");
        panel.id = "gpe-picker-panel";
        EMOTES.forEach((glyph) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = glyph;
            b.addEventListener("click", () => {
                sendMessage(glyph);
                panel.classList.remove("gpe-open");
            });
            panel.appendChild(b);
        });

        btn.addEventListener("click", () => {
            const opening = !panel.classList.contains("gpe-open");
            panel.classList.toggle("gpe-open");
            if (opening) {
                const r = btn.getBoundingClientRect();
                const panelH = panel.offsetHeight;
                panel.style.left = window.scrollX + r.left + "px";
                panel.style.top = window.scrollY + r.top - panelH - 6 + "px"; // open upward
            }
        });

        // Inline one-shot "share hand": share at the end of this hand only,
        // then uncheck. (Persistent settings live in the extension popup.)
        const shareToggle = document.createElement("label");
        shareToggle.id = "gpe-share-toggle";
        shareToggle.className = "gpe-toggle";
        const shareBox = document.createElement("input");
        shareBox.type = "checkbox";
        shareBox.id = "gpe-share-next";
        shareBox.addEventListener("change", () => { shareNextHand = shareBox.checked; });
        shareToggle.appendChild(shareBox);
        shareToggle.appendChild(document.createTextNode("share hand")); // gap, not a space, sets the offset

        // Its counterpart: a one-click button to reveal the hand that just
        // ended, shown (in place of the checkbox) only in the gap before the
        // next flop. updateShareControlUI() toggles which of the two is visible.
        // Both of its labels stay in the layout (one hidden) so the button's
        // width never changes when it flips to "hand shared ✓".
        const shareLast = document.createElement("button");
        shareLast.type = "button";
        shareLast.id = "gpe-share-last";
        shareLast.className = "gpe-share-last gpe-stack gpe-hidden";
        const shareLastIdle = document.createElement("span");
        shareLastIdle.className = "gpe-share-last-idle";
        shareLastIdle.textContent = "share last hand";
        const shareLastDone = document.createElement("span");
        shareLastDone.className = "gpe-share-last-done";
        shareLastDone.textContent = "hand shared ✓";
        shareLast.appendChild(shareLastIdle);
        shareLast.appendChild(shareLastDone);
        shareLast.addEventListener("click", shareLastHand);

        // The checkbox and the button swap in and out of view, so they share one
        // fixed-size slot: both stay in the layout (the inactive one hidden) and
        // the slot stays as wide as the wider of the two. Without this, swapping
        // them resized the row and shifted the quick-chat buttons sideways —
        // right under a click that was aimed at the share control.
        const shareSlot = document.createElement("div");
        shareSlot.id = "gpe-share-slot";
        shareSlot.className = "gpe-stack";
        shareSlot.appendChild(shareToggle);
        shareSlot.appendChild(shareLast);

        // One tidy flex row under the chat input for all our controls.
        // (The "odds" toggle moved up to the side panel's tools tab.)
        const tools = document.createElement("div");
        tools.id = "gpe-chat-tools";
        tools.appendChild(btn);
        tools.appendChild(shareSlot);
        // Quick-chat buttons live to the right of "share hand".
        const chatBtns = document.createElement("div");
        chatBtns.id = "gpe-chat-btns";
        tools.appendChild(chatBtns);

        // The chat input sits in a 2-cell row: [ input | Send ]. Placing our
        // tools inside the input's cell makes the Send cell stretch tall (its
        // lower half wasted). Instead give the tools their own full-width row
        // (colspan across both cells) beneath it, so the buttons reclaim the
        // space under Send. Falls back to inline placement if the layout differs.
        const cell = input.closest("td");
        const row = cell && cell.closest("tr");
        if (row && cell.parentElement === row) {
            const stale = document.getElementById("gpe-chat-tools-row");
            if (stale) stale.remove();
            const toolRow = document.createElement("tr");
            toolRow.id = "gpe-chat-tools-row";
            const toolCell = document.createElement("td");
            toolCell.colSpan = row.children.length; // span input + Send columns
            toolCell.appendChild(tools);
            toolRow.appendChild(toolCell);
            row.insertAdjacentElement("afterend", toolRow);
        } else {
            input.insertAdjacentElement("afterend", tools);
        }
        renderChatButtons();
        syncShareToggleUI();
        updateShareControlUI();
        document.body.appendChild(panel);
    }

    // ---------- UI: "splash" (3D chip portal) ----------
    // The animation lives in two extra files (vendor/three.iife.js and
    // 3d/chips3d.js). As an extension they are declared as content scripts, so
    // window.GPE_CHIPS already exists by the time this runs. When gpokr hosts the
    // tools itself its loader fetches a fixed list — overlay.css, dark.css,
    // odds.js, content.js — and knows nothing about the other two, so the button
    // was there but silently did nothing. Rather than require a site-side change
    // every time we add a file, fetch them on demand from wherever this file came
    // from. They only need to be present alongside it on the host.
    let chipsLoad = null;

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const el = document.createElement("script");
            el.src = url;
            el.async = false;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error(url));
            (document.head || document.documentElement).appendChild(el);
        });
    }

    // Resolves to whether window.GPE_CHIPS is available. Caches the in-flight
    // load so hovering then clicking doesn't fetch three.js twice; on failure the
    // cache is cleared so a later click can retry.
    function ensureChips() {
        if (window.GPE_CHIPS) return Promise.resolve(true);
        if (!SELF_SRC) return Promise.resolve(false);
        if (!chipsLoad) {
            const base = SELF_SRC.replace(/[^/]*$/, "");
            chipsLoad = loadScript(base + "vendor/three.iife.js")
                .then(() => loadScript(base + "3d/chips3d.js"))
                .then(() => !!window.GPE_CHIPS)
                .catch((err) => {
                    console.warn("[gpe] chip portal unavailable — could not load " + err.message);
                    chipsLoad = null;
                    return false;
                });
        }
        return chipsLoad;
    }

    // TEST FEATURE, no settings toggle yet: drops 3D chips through a portal over
    // the felt. Purely cosmetic and local — nothing is sent to the site.
    //
    // The button goes in the pot label's own table cell, as a SIBLING of the
    // label rather than a child: the label is a GWT widget whose text is rewritten
    // on every pot change, which would wipe out any child we put inside it. It is
    // then positioned (see overlay.css) into the 50px right margin the site
    // already leaves on the label, so the controls row can't reflow.
    // Re-checked on the poll loop, since GWT rebuilds the controls between hands.
    function addSplashButton() {
        const pot = document.querySelector(".gpokr-GameWindow-potLabel");
        if (!pot) return;
        const cell = pot.parentElement;
        if (!cell) return;
        const existing = document.getElementById("gpe-splash-btn");
        if (existing && existing.parentElement === cell) return;
        if (existing) existing.remove();   // stale: GWT rebuilt the row
        cell.classList.add("gpe-pot-cell");   // positioning context for the button

        const btn = document.createElement("button");
        btn.id = "gpe-splash-btn";
        btn.type = "button";
        btn.textContent = "splash";
        btn.title = "Splash the pot — dump 3D chips on the table";
        const flash = () => {
            btn.classList.add("gpe-splash-busy");
            setTimeout(() => btn.classList.remove("gpe-splash-busy"), 180);
        };
        // Warm the animation up on hover so the first click isn't waiting on
        // three.js. Harmless if it never arrives — the click path awaits it too.
        btn.addEventListener("pointerenter", () => { ensureChips(); }, { once: true });
        btn.addEventListener("click", async () => {
            if (!window.GPE_CHIPS) {
                btn.classList.add("gpe-splash-busy");   // held until the fetch lands
                const ready = await ensureChips();
                btn.classList.remove("gpe-splash-busy");
                if (!ready) return;
            }
            // drop() returns false while one is already running; flash the button
            // so the click doesn't feel dropped.
            if (!window.GPE_CHIPS.drop()) flash();
        });
        pot.insertAdjacentElement("afterend", btn);
        placeSplashButton();
    }

    // Tuck the button just right of the pot TEXT. The label's box is a fixed
    // 150px with its text left-aligned, so any fixed offset is wrong: clearing
    // the box leaves the button 70px away from a short pot (and jammed against
    // the fold/call/raise controls), while a closer offset would collide once
    // the pot runs long. So measure the text and follow it, clamped inside the
    // cell. Re-measured only when the pot text actually changes.
    let lastPotText = null;
    function placeSplashButton() {
        const btn = document.getElementById("gpe-splash-btn");
        const pot = document.querySelector(".gpokr-GameWindow-potLabel");
        if (!btn || !pot) return;
        if (pot.textContent === lastPotText && btn.style.left) return;
        lastPotText = pot.textContent;

        const cell = pot.parentElement;
        if (!cell) return;
        const cellBox = cell.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(pot);
        const textBox = range.getBoundingClientRect();

        // The label empties out between hands, which collapses the measurement to
        // a zero rect. Hold the last good spot rather than darting to the left
        // edge and back every time a hand ends; only fall back on first placement.
        if (textBox.width <= 0) {
            if (!btn.style.left) {
                btn.style.left = (pot.getBoundingClientRect().left - cellBox.left + 8) + "px";
            }
            return;
        }

        const left = textBox.right - cellBox.left + 8;
        const max = cellBox.width - btn.offsetWidth - 3;   // stay inside the cell
        btn.style.left = Math.max(0, Math.min(left, max)) + "px";
    }

    // Personal-interaction menu: a single trigger button tucked just right of
    // Splash that opens a fly-out of the celebrations (Celebrate, Dance, Rail
    // slide, ...), built exactly like the per-seat throw menu — same panel/item
    // classes, same open-on-hover-and-stay behavior, same cooldown readout. Unlike
    // Splash (local-only chips) these ride the interaction wire, so the whole table
    // sees them. Personal items live outside INTERACT_ORDER, so PERSONAL_ORDER is
    // their own menu order.
    const PERSONAL_ORDER = ["celebrate", "clap", "dance", "rail", "river"];
    let personalPanel = null;
    let personalCloseTimer = 0;

    function personalMenu() {
        if (personalPanel && personalPanel.isConnected) return personalPanel;
        const panel = document.createElement("div");
        panel.id = "gpe-personal-panel";
        for (const key of PERSONAL_ORDER) {
            const item = INTERACT_ITEMS[key];
            if (!item) continue;
            const b = document.createElement("button");
            b.type = "button";
            b.className = "gpe-interact-item";   // same look/cooldown styling as the throw menu
            b.dataset.gpeItem = key;
            b.textContent = item.glyph + " " + item.label;
            // Like the throw menu, does NOT close on click — pick another, or fire
            // again once it's off cooldown.
            b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                firePersonal(key);
                syncMenuCooldowns();
            });
            panel.appendChild(b);
        }
        panel.addEventListener("mouseenter", holdPersonalMenu);
        panel.addEventListener("mouseleave", scheduleClosePersonalMenu);
        document.body.appendChild(panel);
        personalPanel = panel;
        return panel;
    }

    function openPersonalMenu(btn) {
        if (btn.disabled) return;            // paused mid-hand: nothing to open
        const panel = personalMenu();
        holdPersonalMenu();
        const br = btn.getBoundingClientRect();
        panel.style.left = br.left + "px";
        panel.style.top = (br.bottom + 4) + "px";
        panel.classList.add("gpe-open");
        // Keep it on screen when Splash sits near the right/bottom edge.
        const pr = panel.getBoundingClientRect();
        if (pr.right > window.innerWidth - 4) {
            panel.style.left = Math.max(4, window.innerWidth - pr.width - 4) + "px";
        }
        if (pr.bottom > window.innerHeight - 4) {
            panel.style.top = Math.max(4, br.top - pr.height - 4) + "px";
        }
        syncMenuCooldowns();
    }

    function holdPersonalMenu() {
        if (personalCloseTimer) { clearTimeout(personalCloseTimer); personalCloseTimer = 0; }
    }
    function scheduleClosePersonalMenu() {
        holdPersonalMenu();
        personalCloseTimer = setTimeout(closePersonalMenu, 320);
    }
    function closePersonalMenu() {
        holdPersonalMenu();
        if (personalPanel) personalPanel.classList.remove("gpe-open");
    }

    // The trigger button, right of Splash. Hover or click opens the menu. Same
    // re-attach dance as Splash, since GWT rebuilds the controls row between hands.
    function addPersonalButton() {
        const splash = document.getElementById("gpe-splash-btn");
        if (!splash) return;                 // positioned off Splash; wait for it
        const cell = splash.parentElement;
        if (!cell) return;
        const existing = document.getElementById("gpe-personal-btn");
        if (existing && existing.parentElement === cell) return;
        if (existing) existing.remove();     // stale: GWT rebuilt the row

        const btn = document.createElement("button");
        btn.id = "gpe-personal-btn";
        btn.type = "button";
        btn.className = "gpe-personal-btn";
        btn.textContent = "🥳";
        btn.addEventListener("mouseenter", () => openPersonalMenu(btn));
        btn.addEventListener("mouseleave", scheduleClosePersonalMenu);
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPersonalMenu(btn);
        });
        splash.insertAdjacentElement("afterend", btn);
        placePersonalButton();
    }

    // Follow Splash's right edge. Hidden unless I can actually fire one (wire +
    // seat); between hands it's live, from the flop it goes disabled/dim (and the
    // menu shuts), since celebrations pause while a hand is in play. Re-run on the
    // fast poll so position and state stay current.
    function placePersonalButton() {
        const btn = document.getElementById("gpe-personal-btn");
        const splash = document.getElementById("gpe-splash-btn");
        if (!btn || !splash) return;
        if (!canPersonal()) { btn.style.display = "none"; closePersonalMenu(); return; }
        btn.style.display = "";
        const open = celebrationsAllowed();
        btn.disabled = !open;
        btn.title = open ? "Celebrations" : "not while the hand is playing — free again once it's over";
        if (!open) closePersonalMenu();
        const left = parseFloat(splash.style.left) || 0;
        btn.style.left = (left + splash.offsetWidth + 6) + "px";
    }

    // ---------- avatar stunts (dance, rail slide, ...) ----------
    // Shared skeleton for the personal interactions that make a seat's avatar do
    // something over the table: clone the avatar image into a fixed, click-through
    // overlay, hide the real seat avatar (via visibility, so the fold-dimming poll
    // — which writes opacity — doesn't fight it), and drive the clone each frame
    // through a choreographer until it says it's done, then clean up and restore.
    // Runs the same on every viewer, each resolving the celebrant's own seat.
    //   step(t, api) -> false when finished. api.put(x, y, scale, rotZ, flipX)
    //   places the clone; api carries the seat center (sx, sy), size (w, h) and the
    //   table rect.
    // opts.cls adds a class to the clone — the one use is dropping it below the 3D
    // layer so a stunt can have props drawn IN FRONT of the avatar (see clap).
    function avatarStunt(avatarEl, fromRect, tableRect, step, opts) {
        if (!avatarEl || !fromRect || typeof step !== "function") return false;
        const src = avatarEl.currentSrc || avatarEl.src;
        if (!src) return false;

        const img = document.createElement("img");
        img.src = src;
        img.className = "gpe-dance" + ((opts && opts.cls) ? " " + opts.cls : "");
        img.style.width = fromRect.width + "px";
        img.style.height = fromRect.height + "px";
        document.body.appendChild(img);

        const prevVis = avatarEl.style.visibility;
        avatarEl.style.visibility = "hidden";
        const cleanup = () => { img.remove(); if (avatarEl.isConnected) avatarEl.style.visibility = prevVis; };

        // perspective() leads so rotateX reads as a somersault and rotateY as a
        // turn-around, not flat squashes. put(x, y, scale, rotZ, flipX, spinY).
        const put = (x, y, scale, rotZ, flipX, spinY) => {
            img.style.transform = "perspective(600px) translate(" + x + "px," + y + "px) " +
                "translate(-50%,-50%) rotateX(" + (flipX || 0) + "deg) rotateY(" + (spinY || 0) + "deg) " +
                "rotate(" + (rotZ || 0) + "deg) scale(" + (scale == null ? 1 : scale) + ")";
        };
        const api = {
            put,
            sx: fromRect.left + fromRect.width / 2,
            sy: fromRect.top + fromRect.height / 2,
            w: fromRect.width, h: fromRect.height,
            table: tableRect || liveRect(document.querySelector(".iogc-GameWindow-table")),
        };
        put(api.sx, api.sy, 1, 0, 0);

        const t0 = performance.now();
        function frame(now) {
            if (step(now - t0, api) === false) { cleanup(); return; }
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        return true;
    }

    // The table's rail as a screen-space ellipse: the felt oval (art-space
    // measurements, the same the 3D table/coin code uses) grown by `pad` art px so
    // a rider sits out on the rail rather than on the felt. null if there's no table.
    function railEllipse(tableRect, pad) {
        if (!tableRect || tableRect.width < 40) return null;
        const ART_W = 790, CX = 395, CY = 190, HW = 290, HD = 102;   // felt, art space
        const sc = tableRect.width / ART_W;
        return {
            cx: tableRect.left + CX * sc,
            cy: tableRect.top + CY * sc,
            ax: (HW + (pad || 0)) * sc,
            by: (HD + (pad || 0)) * sc,
        };
    }

    // Dance: leap to the middle, dance, backflip, hop back. ~4.25s, to match the
    // celebrate track.
    function danceAvatar(avatarEl, fromRect, tableRect) {
        return avatarStunt(avatarEl, fromRect, tableRect, function (t, api) {
            const { put, sx, sy, h, table } = api;
            const tx = table ? table.left + table.width / 2 : sx;        // middle of the table
            const ty = table ? table.top + table.height / 2 : sy - 140;
            const HOP = Math.min(130, h * 1.6);
            const JUMP = 520, DANCE = 2650, FLIP = 620, RET = 460;
            if (t >= JUMP + DANCE + FLIP + RET) return false;
            if (t < JUMP) {                          // leap from the seat to the center
                const k = t / JUMP, e = 1 - Math.pow(1 - k, 3);
                put(sx + (tx - sx) * e, sy + (ty - sy) * e - Math.sin(k * Math.PI) * HOP, 1 + 0.3 * e, 0, 0);
            } else if (t < JUMP + DANCE) {           // dance in the middle
                const d = (t - JUMP) / 1000;
                put(tx + Math.sin(d * 3) * 26, ty - Math.abs(Math.sin(d * 6)) * 18,
                    1.3 * (1 + Math.sin(d * 12) * 0.06), Math.sin(d * 6) * 12, 0);
            } else if (t < JUMP + DANCE + FLIP) {    // backflip finale
                const k = (t - JUMP - DANCE) / FLIP;
                put(tx, ty - Math.sin(k * Math.PI) * (HOP * 0.95), 1.3, 0, 360 * k);
            } else {                                 // hop back to the seat
                const k = (t - JUMP - DANCE - FLIP) / RET, e = 1 - Math.pow(1 - k, 3);
                put(tx + (sx - tx) * e, ty + (sy - ty) * e - Math.sin(k * Math.PI) * (HOP * 0.6),
                    1.3 + (1 - 1.3) * e, 0, 0);
            }
            return true;
        });
    }

    // Stand up and applaud: the avatar rises out of its seat, drives down into
    // eight claps, and sits back. The hands themselves are 3D — a pair of gloves
    // from props3d — because the avatar image has none to clap with. The
    // choreography constants are CLAP_*, declared up with INTERACT_ITEMS.
    function standAndClap(avatarEl, fromRect, tableRect) {
        if (!avatarEl || !fromRect) return false;
        const h = fromRect.height || 40;
        const lift = Math.min(46, h * 0.55);

        // The gloves are a separate renderer on coin3d's layer, not part of the
        // stunt: they're aimed at the seat once, up front, since the avatar holds
        // still for the whole applause and only the rise and the sit move it.
        //
        // dropY drops them into the gap the avatar opens up by standing: it rises
        // by `lift` and grows to 1.18, leaving the lower half of its seat empty,
        // and the hands clap there. 0.41 of the avatar's height lands just under
        // its risen bottom edge — far enough down to sit in the gap, close enough
        // to still read as attached to the body rather than floating below it.
        if (window.GPE_PROPS) {
            GPE_PROPS.toss("clap", fromRect, fromRect, tableRect, { dropY: h * 0.41 });
        }

        return avatarStunt(avatarEl, fromRect, tableRect, function (t, api) {
            const { put, sx, sy } = api;
            const APPLAUD = CLAP_COUNT * CLAP_PERIOD;
            if (t >= CLAP_LEAD + APPLAUD + CLAP_TAIL) return false;
            if (t < CLAP_LEAD) {                       // stand up out of the seat
                const e = 1 - Math.pow(1 - t / CLAP_LEAD, 3);
                put(sx, sy - lift * e, 1 + 0.18 * e, 0, 0);
            } else if (t < CLAP_LEAD + APPLAUD) {      // applaud
                // One pulse per clap, peaking as the palms meet: the whole body
                // drives down into the strike instead of hanging level above it.
                const u = ((t - CLAP_LEAD) % CLAP_PERIOD) / CLAP_PERIOD;
                const beat = Math.sin(Math.PI * u);
                put(sx, sy - lift + beat * 5, 1.18, beat * 2.5, 0);
            } else {                                   // sit back down
                const k = (t - CLAP_LEAD - APPLAUD) / CLAP_TAIL;
                const e = 1 - Math.pow(1 - k, 3);
                put(sx, sy - lift * (1 - e), 1.18 + (1 - 1.18) * e, 0, 0);
            }
            return true;
        }, { cls: "gpe-under-props" });   // ...so the gloves draw in front of the chest
    }

    // The river pours from the pot to the last hand's winner, so its target is
    // resolved here rather than sent: scanWinner() reads the main-pot line out of
    // the game log, which every client at the table has, so all of them aim at the
    // same seat off the same source without a name on the wire.
    //
    // Two ways that can come up empty — we joined mid-hand and have not seen a
    // showdown yet, or the winner has since left the table — and both pour it over
    // the player who fired it instead. A celebration that silently does nothing
    // reads as a broken button; one that lands on the wrong seat reads as a joke.
    function riverToWinner(fromRect, tableRect) {
        if (!window.GPE_PROPS) return false;
        const seat = lastWinner ? liveRect(findAvatarByName(lastWinner)) : null;
        return !!GPE_PROPS.toss("river", fromRect, seat || fromRect, tableRect);
    }

    // ---------- river inspector ----------
    // Holds one river on the felt and lets you drag it round to any heading.
    //
    // The celebration is a 5s event behind a between-hands gate, so looking at it
    // properly used to mean a reload, a wait for the gate, and a screenshot race —
    // per attempt. This keeps it on screen and turnable, which is the only sane
    // way to judge a 3D shape. It holds a REAL one through GPE_PROPS.holdRiver, so
    // what you turn over is the same geometry, mask and projection players get.
    let riverLabAngle = -Math.PI / 4;   // start on a diagonal, where the lean shows most
    let riverLabDrag = false;
    let riverLabAt = 0;                 // last rebuild, for throttling

    function riverLabTable() { return document.querySelector(".iogc-GameWindow-table"); }

    // Rebuilding is the only way to change the heading: the lean and the camera
    // projection are baked into the vertices, so spinning the group would spin
    // those with it and the light would come from the wrong side. A river is a few
    // hundred vertices, but not per mousemove — hence the throttle.
    function riverLabRender(force) {
        if (!RIVER_LAB || !window.GPE_PROPS || !GPE_PROPS.holdRiver) return;
        const now = Date.now();
        if (!force && now - riverLabAt < 60) return;
        riverLabAt = now;
        const el = riverLabTable();
        if (el) GPE_PROPS.holdRiver(riverLabAngle, liveRect(el));
    }

    function riverLabAngleFrom(ev) {
        const el = riverLabTable();
        if (!el || !window.GPE_COIN || typeof GPE_COIN.feltBounds !== "function") return null;
        const f = GPE_COIN.feltBounds(liveRect(el));
        if (!f) return null;
        // Measured against the felt's own ellipse rather than raw pixels, so
        // dragging to a spot on the rail gives the heading that actually points
        // there — the felt is well under half as tall as it is wide.
        return Math.atan2((ev.clientY - f.cy) / f.by, (ev.clientX - f.cx) / f.ax);
    }

    function onRiverLabDown(ev) {
        if (!RIVER_LAB || ev.button !== 0) return;
        const a = riverLabAngleFrom(ev);
        if (a === null) return;
        riverLabDrag = true;
        riverLabAngle = a;
        riverLabRender(true);
        ev.preventDefault();
    }
    function onRiverLabMove(ev) {
        if (!riverLabDrag) return;
        const a = riverLabAngleFrom(ev);
        if (a === null) return;
        riverLabAngle = a;
        riverLabRender(false);
    }
    function onRiverLabUp() {
        if (!riverLabDrag) return;
        riverLabDrag = false;
        riverLabRender(true);      // land exactly where the mouse was let go
    }

    // move/up listen on the document so a drag that wanders off the table still
    // tracks, and still ends when the button comes up somewhere else.
    let riverLabWired = false;
    function syncRiverLab() {
        const el = riverLabTable();
        if (RIVER_LAB) {
            if (!riverLabWired && el) {
                el.addEventListener("mousedown", onRiverLabDown);
                document.addEventListener("mousemove", onRiverLabMove);
                document.addEventListener("mouseup", onRiverLabUp);
                riverLabWired = true;
            }
            document.documentElement.classList.add("gpe-river-lab");
            // The models have to be loaded before a river can be built, and the
            // celebration's own ensure() is what knows which ones.
            const item = INTERACT_ITEMS.river;
            if (item && item.ensure) item.ensure().then((ok) => { if (ok) riverLabRender(true); });
            return;
        }
        if (riverLabWired) {
            if (el) el.removeEventListener("mousedown", onRiverLabDown);
            document.removeEventListener("mousemove", onRiverLabMove);
            document.removeEventListener("mouseup", onRiverLabUp);
            riverLabWired = false;
        }
        riverLabDrag = false;
        document.documentElement.classList.remove("gpe-river-lab");
        if (window.GPE_PROPS && GPE_PROPS.releaseRiver) GPE_PROPS.releaseRiver();
    }

    // Rail slide: leap up onto the rail, grind a full lap around the table's oval,
    // then hop back down to the seat.
    function railSlideAvatar(avatarEl, fromRect, tableRect) {
        return avatarStunt(avatarEl, fromRect, tableRect, function (t, api) {
            const { put, sx, sy, table } = api;
            const JUMP = 520, SLIDE = 2900, RET = 560;
            if (t >= JUMP + SLIDE + RET) return false;
            const e = railEllipse(table, 16);        // sit ~16 art px out onto the rail
            if (!e) return false;                    // no table -> nothing to grind
            const ang0 = Math.atan2((sy - e.cy) / e.by, (sx - e.cx) / e.ax); // rail point nearest the seat
            const on = (a) => ({ x: e.cx + Math.cos(a) * e.ax, y: e.cy + Math.sin(a) * e.by });
            if (t < JUMP) {                          // leap from the seat onto the rail
                const k = t / JUMP, ee = 1 - Math.pow(1 - k, 3), p = on(ang0);
                put(sx + (p.x - sx) * ee, sy + (p.y - sy) * ee - Math.sin(k * Math.PI) * 90, 1 + 0.15 * ee, 0, 0);
            } else if (t < JUMP + SLIDE) {           // grind one lap around the oval
                const k = (t - JUMP) / SLIDE, ang = ang0 + k * Math.PI * 2, p = on(ang);
                const lean = -Math.sin(ang) * 20;    // carve into the turn
                const chatter = Math.sin(k * Math.PI * 10) * 3;   // rail vibration
                put(p.x, p.y - chatter, 1.15, lean, 0);
            } else {                                 // leap off the rail with a spin, back to the seat
                const k = (t - JUMP - SLIDE) / RET, ee = 1 - Math.pow(1 - k, 3), p = on(ang0);
                put(p.x + (sx - p.x) * ee, p.y + (sy - p.y) * ee - Math.sin(k * Math.PI) * 95,
                    1.15 + (1 - 1.15) * ee, 0, 0, 360 * k);   // one full horizontal spin (about the vertical axis)
            }
            return true;
        });
    }

    // Nudge the bet input by `steps` big blinds (may be negative), clamped to
    // [0, my stack]. Shared by the ↑/↓ hotkeys and the scroll wheel. Returns
    // true only if it actually changed the field.
    function nudgeBet(steps) {
        const inp = document.querySelector("input.gpokr-GameWindow-betInput");
        if (!inp || inp.getBoundingClientRect().width === 0) return false;
        const bb = parseBigBlind();
        if (!bb) return false;
        const cur = parseInt(String(inp.value).replace(/[^\d]/g, ""), 10) || 0;
        let next = cur + steps * bb;
        if (next < 0) next = 0;
        const stack = myStack();
        if (stack && next > stack) next = stack; // cap at all-in
        setBetInput(inp, next);
        return true;
    }

    // Scrolling over the focused bet field steps it by ±1 big blind — the same
    // increment as the native slider beside it and the ↑/↓ hotkeys. Gated on the
    // field being focused, so it never hijacks ordinary page scrolling; passive
    // false so we can swallow the scroll once it's ours.
    document.addEventListener("wheel", (e) => {
        const inp = document.querySelector("input.gpokr-GameWindow-betInput");
        if (!inp || document.activeElement !== inp || inp.getBoundingClientRect().width === 0) return;
        if (nudgeBet(e.deltaY < 0 ? 1 : -1)) e.preventDefault(); // wheel up = raise
    }, { passive: false });

    // ---------- keyboard shortcuts ----------
    // f = fold, c = check/call, 1-9 = fill the nth bet-sizing button's amount
    // (top column first, then bottom — no auto-submit). Gated by the popup's
    // "Keyboard shortcuts" setting (off by default: a stray F folding a hand
    // would be bad). Never fires while typing (chat box, bet input, ...).
    function visibleActionBtn(sel) {
        const el = document.querySelector(sel);
        return el && el.getBoundingClientRect().width > 0 ? el : null;
    }
    document.addEventListener("keydown", (e) => {
        if (!HOTKEYS || e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT" || t.isContentEditable)) return;
        const k = e.key.toLowerCase();
        // Up/Down nudge the bet field by one big blind (only when it's my turn
        // to bet, i.e. the input is on screen).
        if (k === "arrowup" || k === "arrowdown") {
            if (nudgeBet(k === "arrowup" ? 1 : -1)) e.preventDefault();
            return;
        }
        let btn = null;
        if (k === "f") btn = visibleActionBtn(".gpokr-GameWindow-foldButton");
        else if (k === "c") btn = visibleActionBtn(".gpokr-GameWindow-checkCallButton");
        else if (/^[1-9]$/.test(k)) {
            const btns = Array.from(document.querySelectorAll("#gpe-bet-sizes button, #gpe-pot-sizes button"))
                .filter((b) => b.getBoundingClientRect().width > 0);
            btn = btns[parseInt(k, 10) - 1] || null;
        }
        if (btn) { e.preventDefault(); btn.click(); }
    });

    // Keep the 3D table in step with the setting and the live DOM: turn it on
    // once a table appears, rebuild it if GWT recycled the host (wiping our
    // canvas), and tear it down when it's off or we've left the table.
    // The 3D-table renderer lives in vendor/three.iife.js + 3d/table3d.js. As an
    // extension both are content scripts (window.GPE_TABLE3D already exists); when
    // gpokr hosts the tools its loader only fetches the core files, so pull the
    // renderer from wherever this file came from — same trick as the chip
    // portal (ensureChips3d) and coin toss (ensureCoin3d).
    let table3dLoad = null;
    function ensureTable3d() {
        if (window.GPE_TABLE3D) return Promise.resolve(true);
        if (!SELF_SRC) return Promise.resolve(false);
        if (!table3dLoad) {
            const base = SELF_SRC.replace(/[^/]*$/, "");
            const three = window.THREE ? Promise.resolve() : loadScript(base + "vendor/three.iife.js");
            table3dLoad = three
                .then(() => loadScript(base + "3d/table3d.js"))
                .then(() => !!window.GPE_TABLE3D)
                .catch((err) => {
                    console.warn("[gpe] 3D table unavailable — could not load " + err.message);
                    table3dLoad = null;
                    return false;
                });
        }
        return table3dLoad;
    }

    // Push the current felt/leather/logo settings into the live renderer.
    function applyTable3dSettings() {
        const api = window.GPE_TABLE3D;
        if (!api) return;
        api.setTexZoom(TABLE3D_FELT_ZOOM, TABLE3D_LEATHER_ZOOM);
        api.setTexDepth(TABLE3D_FELT_DEPTH, TABLE3D_LEATHER_DEPTH);
        api.setFeltColor(TABLE3D_FELT_COLOR);
        api.setLeatherColor(TABLE3D_LEATHER_COLOR);
        api.setLogoOpacity(TABLE3D_LOGO_OPACITY);
        if (api.setSurroundColor) api.setSurroundColor(TABLE3D_BG_COLOR);
        if (api.setBackdrop) api.setBackdrop(TABLE3D_BACKDROP);
        if (api.setSeats) api.setSeats(TABLE3D_SEATS);
    }

    function syncTable3d() {
        const hasTable = !!document.querySelector(".iogc-GameWindow-table");
        const api = window.GPE_TABLE3D;
        if (!api) {
            // Embedded: the renderer isn't a content script here — fetch it, then
            // re-run once GPE_TABLE3D is in. (No-op as an extension: api exists.)
            if (TABLE_3D && hasTable) ensureTable3d().then((ok) => { if (ok) syncTable3d(); });
            return;
        }
        if (TABLE_3D && hasTable) {
            if (!api.isOn() || !document.getElementById("gpe-table3d")) {
                api.disable(); api.enable(); applyTable3dSettings();
            }
        } else if (api.isOn()) {
            api.disable();
        }
    }

    // ---------- boot ----------
    // No-op as an extension (the manifest installs the tap at document_start, in
    // the page's own world, which is the only way to beat the client's socket).
    ensureWsMonitor();
    warmSounds();
    watchCardImages(); // track card images as GWT swaps them
    sweepCardImgs();
    // As an extension props3d is already a content script, so its catalog is here
    // immediately; the site build fetches it now (the poll below also re-syncs, but
    // only this kicks off the fetch).
    syncInteractCatalog();
    ensurePropsCatalog();
    // We load after the session frame has already gone by, so ask rather than wait
    // for the announcement. Keeps asking until answered: a socket reconnect (table
    // change, dropped connection) starts a new session we may need to hear about.
    probeBridge();
    setInterval(probeBridge, 4000);

    setInterval(() => {
        updateStatBadges(); updateHoverToppers(); tagTurnHighlights(); applyBetReadout(); applyFoldDimming();
        updateInteractButtons(); // interact buttons track their avatars as seats move
        updateInteractTester(); // keep the tester's target list + send-ability current
        patchProfileMenu(); // the ⋮ menu is short-lived: catch it while it's open
        placeSplashButton(); // follows the pot total as it changes
        placePersonalButton(); // rides Splash's right edge; also tracks seat/send-ability
        syncTable3d(); // keep the 3D felt attached across GWT re-renders
        sweepCardImgs(); // backstop for any card the observer missed
        // The inspector may have been switched on before the table existed, or
        // GWT may have replaced the element under us; re-arm if so.
        if (RIVER_LAB && !riverLabWired) syncRiverLab();
    }, 300); // track avatars + turn highlight live
    const boot = setInterval(() => {
        const ready = watchChat();
        addPicker();
        addSplashButton();
        addPersonalButton();
        addChatPopoutButton();
        ensureSidePanelTabs();
        ensureLobbyTools();
        ensureSideSections();
        watchProfileMenuButton();
        if (ready) {
            clearInterval(boot);
            setInterval(() => {
                watchChat(); addPicker(); addSplashButton(); addPersonalButton(); addChatPopoutButton(); ensureSidePanelTabs(); ensureLobbyTools();
                if (syncInteractCatalog()) updateInteractButtons();   // menu grew
                ensureSideSections(); watchProfileMenuButton(); pollHandState();
            }, 1500);
        }
    }, 800);
})();