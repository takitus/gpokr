(function () {
    "use strict";

    const EMOTES = [
        // general reactions
        "🙂","🙁","😀","😅","😂","🤣","😉","😡","😭","😎","😍","🤔","🫡","🔥","💩","👏","💀","🤑","🤫",
        // poker flavor: cards & suits, chips & money, luck, and table reactions
        "🃏","♠️","♥️","♦️","♣️","💰","💵","💸","🪙","🎰","🎲","🏆","👑","🥳","🎁","🤝","🍀","🤞","🥶","🤯","🤡",
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
    let SHOW_BET_BUTTONS = true; // bet-size columns default on (opt-out, unlike the rest)
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

    function applySettings(s) {
        LOCAL_TEST = !!(s && s.localTest);
        SHARE_HAND = !!(s && s.shareHand);
        SHOW_ODDS = !!(s && s.showOdds);
        SHOW_STATS = !!(s && s.showStats);
        HOTKEYS = !!(s && s.hotkeys);
        DARK_MODE = !!(s && s.darkMode);
        document.documentElement.classList.toggle("gpe-dark", DARK_MODE);
        // Opt-out: only an explicit `false` turns the bet buttons off.
        const prevShowBet = SHOW_BET_BUTTONS;
        SHOW_BET_BUTTONS = !(s && s.showBetButtons === false);
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
        ".gpe-hand-wrap, .gpe-emote-overlay, #gpe-odds-hud, #gpe-local-hand, #gpe-picker-btn, #gpe-picker-panel, .gpe-toggle, #gpe-chat-tools, .gpe-bet-col, .gpe-stat-badge, #gpe-note-editor, #gpe-stat-tip, .gpe-side-tabs, .gpe-side-options, .gpe-side-roster, .gpe-side-bets"
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

    function firstEmoteIn(text) {
        for (const e of EMOTES) if (text.includes(e)) return e;
        return null;
    }

    // ---------- card store (learning) ----------
    // v2: the v1 store got poisoned by learning from other players' showdown cards.
    // Kept in memory; persisted to chrome.storage.local so the popup can show
    // progress and export/import it. (Was page localStorage; migrated on first run.)
    const CARD_STORE_KEY = "gpe_card_images_v2";
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

    let cardStore = {};
    function loadCardStore() { return cardStore; }
    function saveCardStore(store) {
        cardStore = store;
        if (EXT_STORE) { try { EXT_STORE.set({ [CARD_STORE_KEY]: store }); } catch (e) {} }
        else { try { localStorage.setItem(CARD_STORE_KEY, JSON.stringify(store)); } catch (e) {} }
    }

    function legacyLocalStorageCardStore() {
        try { return JSON.parse(localStorage.getItem(CARD_STORE_KEY)) || {}; }
        catch (e) { return {}; }
    }

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
            applySettings(legacyLocalStorageSettings());
            cardStore = legacyLocalStorageCardStore();
            return;
        }
        EXT_STORE.get(["gpe_settings", CARD_STORE_KEY, PLAYER_STATS_KEY, NOTES_KEY], (res) => {
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
            let stored = res[CARD_STORE_KEY];
            if (!stored) {
                stored = legacyLocalStorageCardStore();
                if (Object.keys(stored).length) EXT_STORE.set({ [CARD_STORE_KEY]: stored });
            }
            // first-write-wins across the async load: persisted entries beat
            // anything this session learned before the callback fired.
            cardStore = Object.assign({}, cardStore, stored);
            updateOddsHud();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            if (changes.gpe_settings) { applySettings(changes.gpe_settings.newValue || {}); updateOddsHud(); }
            if (changes[CARD_STORE_KEY]) cardStore = changes[CARD_STORE_KEY].newValue || {};
            if (changes[PLAYER_STATS_KEY]) playerStats = changes[PLAYER_STATS_KEY].newValue || {};
            if (changes[NOTES_KEY]) playerNotes = changes[NOTES_KEY].newValue || {};
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

    // Unique per-hand id, read from the end-of-hand log line
    // "Replay: <a href=.../games/<ID>>". Public and identical for every seat, so
    // sharer and receiver derive the same value. Returns null until the current
    // hand ends (the Replay link is inside an <a>, so it lives on a gwt-HTML row
    // that logLines() drops — we read these rows directly and scope to the
    // stretch after the last "Starting Hand").
    function currentGameId() {
        const rows = Array.from(document.querySelectorAll(".iogc-MessagePanel-messages div.gwt-HTML"));
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

    // My pocket cards for the current/most-recent hand.
    function readMyHand() {
        const pocket = currentHandScope().find((t) => /pocket cards/i.test(t));
        if (!pocket) return null;
        const m = pocket.match(/\[([^,]+),\s*([^\]]+)\]/);
        return m ? [m[1].trim(), m[2].trim()] : null;
    }

    // End-of-hand signal: prefer the showdown "shows [..]" line; fall back to "wins pot".
    // (Fold-only hands have no showdown, so they only produce a pot award.)
    function handHasEnded() {
        const scope = currentHandScope();
        if (scope.some((t) => /\bshows \[/i.test(t))) return true;
        if (scope.some((t) => /wins (main|side) pot/i.test(t))) return true;
        return false;
    }

    // ---------- game-state parsing (odds feature) ----------
    function normCard(c) {
        c = c.trim();
        if (c.startsWith("10")) c = "T" + c.slice(2);
        return c[0].toUpperCase() + c[1].toLowerCase();
    }

    // Community cards from the log: "Dealing flop: [Ts, 7c, 4d]" / turn / river.
    // (The 5 board <img> slots exist even face-down, so the log is the reliable source.)
    function parseBoard() {
        const board = [];
        for (const line of currentHandScope()) {
            const m = line.match(/Dealing (?:flop|turn|river):\s*\[([^\]]+)\]/i);
            if (m) m[1].split(",").forEach((c) => board.push(normCard(c)));
        }
        return board.slice(0, 5);
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

    // Float over the game window's header bar, horizontally centered on it —
    // fixed positioning so it never expands the bar's layout.
    function placeOddsHud(hud) {
        if (hud.style.display === "none") return;
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

    let lastSeenHand = "";
    function learnMyCards() {
        if (handHasEnded()) return;
        const hand = readMyHand();
        if (!hand) { lastSeenHand = ""; return; }
        // Wait until the same hand has been read on two consecutive polls, so the
        // seat <img>s have caught up with the log (they update a beat later).
        const key = hand.join("");
        const stable = key === lastSeenHand;
        lastSeenHand = key;
        if (!stable) return;
        const pair = findMySeatCards();
        if (!pair || pair[0].src === pair[1].src) return;
        const store = loadCardStore();
        let changed = false;
        changed = learnInto(store, hand[0], pair[0]) || changed;
        changed = learnInto(store, hand[1], pair[1]) || changed;
        if (changed) saveCardStore(store);
    }

    // Board cards are public: map the logged board (deal order) onto the visible
    // community-card slots, left to right. Up to 5 learned images per hand.
    let lastSeenBoard = "";
    function learnBoardCards() {
        const board = parseBoard();
        if (!board.length) { lastSeenBoard = ""; return; }
        const key = board.join("");
        const stable = key === lastSeenBoard;
        lastSeenBoard = key;
        if (!stable) return; // same two-poll settling as learnMyCards
        const imgs = Array.from(document.querySelectorAll("img.gpokr-communityCard"))
            .filter((im) => im.getBoundingClientRect().width > 0)
            .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
        if (imgs.length < board.length) return;
        const store = loadCardStore();
        let changed = false;
        for (let i = 0; i < board.length; i++) changed = learnInto(store, board[i], imgs[i]) || changed;
        if (changed) saveCardStore(store);
    }

    // Showdown reveals are public too: "NAME shows [Ah, Kd]" + that seat's face-up imgs.
    let lastSeenShows = "";
    function learnShowdownCards() {
        const shows = currentHandScope()
            .map((t) => t.match(/^(.+?) shows \[([^,\]]+),\s*([^\]]+)\]/i))
            .filter(Boolean);
        if (!shows.length) { lastSeenShows = ""; return; }
        const key = shows.map((m) => m[0]).join("|");
        const stable = key === lastSeenShows;
        lastSeenShows = key;
        if (!stable) return;
        const store = loadCardStore();
        let changed = false;
        for (const m of shows) {
            const pair = findSeatCardsByName(m[1].trim());
            if (!pair || pair[0].src === pair[1].src) continue;
            changed = learnInto(store, normCard(m[2]), pair[0]) || changed;
            changed = learnInto(store, normCard(m[3]), pair[1]) || changed;
        }
        if (changed) saveCardStore(store);
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

    // ---------- rendering shared hands ----------
    function makeCardEl(card) {
        const store = loadCardStore();
        if (store[card]) {
            const img = document.createElement("img");
            img.src = store[card];
            img.className = "gpe-shared-card";
            return img;
        }
        const rank = card[0], suit = card[1];
        const div = document.createElement("div");
        div.className = "gpe-shared-card gpe-text-card gpe-suit-" + suit;
        div.textContent = (RANK_LABEL[rank] || rank) + (SUIT_GLYPH[suit] || "");
        return div;
    }

    // A small caption pinned under the shared cards, naming the made hand.
    function appendHandLabel(wrap, label) {
        if (!label) return;
        const capEl = document.createElement("div");
        capEl.className = "gpe-hand-label";
        capEl.textContent = label;
        wrap.appendChild(capEl);
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

    // A seat's two hole-card <img>s, identified by name (visible panel only).
    function findSeatCardsByName(name) {
        if (!name) return null;
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            if (getSeatName(p) !== name) continue;
            const c0 = p.querySelector(".gpokr-Card0 img");
            const c1 = p.querySelector(".gpokr-Card1 img");
            if (c0 && c1 && c0.getBoundingClientRect().width > 0) return [c0, c1];
        }
        return null;
    }
    function findMySeatCards() { return findSeatCardsByName(getMyName()); }

    function faceUpImg(im) {
        return !!im && im.src.startsWith("data:") && im.src.length > 800;
    }
    // First write wins; never overwrite a learned card.
    function learnInto(store, card, img) {
        if (!faceUpImg(img) || store[card]) return false;
        store[card] = img.src;
        return true;
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
        notePresence(name, true); // chatting proves presence
        const text = node.textContent.slice(nameEl.textContent.length).replace(/^\s*:\s*/, "");

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

    function watchChat() {
        const chat = document.querySelector(".iogc-ChatPanel-messages");
        if (!chat) return false;
        if (chat._gpeWatched) return true;
        chat._gpeWatched = true;
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

        const box = document.createElement("textarea");
        box.value = playerNotes[name] || "";
        box.placeholder = "notes on " + name + "…";

        const row = document.createElement("div");
        row.className = "gpe-note-row";
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = "Save";
        save.addEventListener("click", () => { saveNote(name, box.value); ed.remove(); });
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Delete";
        del.addEventListener("click", () => { saveNote(name, ""); ed.remove(); });
        row.appendChild(save);
        row.appendChild(del);

        ed.appendChild(head);
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
        return pct(t.vpip) + "/" + pct(t.pfr) + " (" + t.hands + ")";
    }

    // Hover tooltip: spell the numbers out in plain English.
    function badgeTitleFor(name) {
        const t = playerStats[name];
        const lines = [];
        if (t && t.hands) {
            const pct = (x) => Math.round((x / t.hands) * 100) + "%";
            lines.push(name + " — " + t.hands + " hand" + (t.hands === 1 ? "" : "s") + " observed");
            lines.push("plays " + pct(t.vpip) + " of hands (VPIP)");
            lines.push("raises " + pct(t.pfr) + " preflop (PFR)");
            const aggr = (t.bets || 0) + (t.raises || 0);
            if (aggr || t.calls) lines.push("postflop: " + aggr + " bets/raises vs " + (t.calls || 0) + " calls");
            if (t.showdowns) lines.push("won " + t.sdWins + " of " + t.showdowns + " showdowns");
        } else {
            lines.push(name + " — no hands observed yet");
        }
        if (playerNotes[name]) lines.push("📝 " + playerNotes[name]);
        lines.push("(click to edit note)");
        return lines.join("\n");
    }

    // Hand-rolled hover tooltip. (Native title tooltips never appear here:
    // the 300ms badge refresh rewrites the attribute, resetting the
    // browser's tooltip timer every tick.)
    function showBadgeTip(badge, name) {
        hideBadgeTip();
        const tip = document.createElement("div");
        tip.id = "gpe-stat-tip";
        tip.textContent = badgeTitleFor(name);
        document.body.appendChild(tip);
        const r = badge.getBoundingClientRect();
        tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + "px";
        tip.style.top = r.bottom + 6 + "px";
    }
    function hideBadgeTip() {
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
    // Badges show when stats are enabled, or minimally (just 📝) for players
    // with a note even when they're off. Clicking a badge opens the editor.
    function updateStatBadges() {
        const wanted = new Set();
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            const name = getSeatName(p);
            if (!name || wanted.has(name)) continue;
            if (!SHOW_STATS && !playerNotes[name]) continue;
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
            const stats = SHOW_STATS ? badgeTextFor(name) : null;
            const parts = [];
            if (SHOW_STATS) parts.push(stats || "–/– (0)");
            if (playerNotes[name]) parts.push("📝");
            const text = parts.join(" ");
            if (badge.textContent !== text) badge.textContent = text; // don't churn the DOM every tick
            // sit just above the avatar's top-left corner
            badge.style.left = r.left + "px";
            badge.style.top = r.top - 2 + "px";
        }
        for (const [name, el] of statBadges) {
            if (!wanted.has(name)) { el.remove(); statBadges.delete(name); }
        }
        // drop an orphaned tooltip if its badge went away under the cursor
        const tip = document.getElementById("gpe-stat-tip");
        if (tip && ![...statBadges.values()].some((b) => b.matches(":hover"))) hideBadgeTip();
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
    let curGameId = null;   // most recent completed hand's id (from the Replay line)
    let prevGameId = null;  // the one before it — a one-hand grace for verification

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
        if (sender !== getMyName() && !alreadyShown(bucket, member))
            showHandForName(sender, dec.cards, dec.label || handLabelFor(dec.cards));
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
        ["gpe-always-share", "always show cards", "shareHand", () => SHARE_HAND],
        ["gpe-hotkeys", "keyboard shortcuts", "hotkeys", () => HOTKEYS,
            "F = fold · C = check/call · 1–9 = bet-size buttons · ↑/↓ = ±1 big blind"],
        ["gpe-bet-buttons", "bet buttons", "showBetButtons", () => SHOW_BET_BUTTONS],
        ["gpe-bet-readout", "bet readout", "betReadout", () => BET_READOUT,
            "Replaces each player's \"Level\" with the total they've bet/raised " +
            "(calls not counted) over their last N hands. Set N below."],
    ];

    // Panel checkboxes mirror the persistent settings (same ones as the popup);
    // either UI updates the other through chrome.storage.
    function syncSideOptionsUI() {
        for (const [id, , , current] of SIDE_OPTIONS) {
            const box = document.getElementById(id);
            if (box) box.checked = current();
        }
        syncBetWindowInputs();
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
        Array.from(tabs.children).forEach((b, i) =>
            b.classList.toggle("gpe-active", sideTab === SIDE_TAB_ORDER[i]));
    }

    // Instant hover popup — replaces the native `title` tooltip, which has an
    // uncontrollable ~1s delay. The popup lives on <body> so the narrow side
    // panel can't clip it, and is positioned under the anchor each time.
    function attachInstantTip(el, text) {
        let pop = null;
        const hide = () => { if (pop) { pop.remove(); pop = null; } };
        el.addEventListener("mouseenter", () => {
            hide();
            pop = document.createElement("div");
            pop.className = "gpe-tip-pop";
            pop.textContent = text;
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
        el.addEventListener("mouseleave", hide);
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
            "|" + playing.concat(watching).map((n) => (followingSet.has(n) ? 1 : 0) + (links[n] ? "L" : "")).join();
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
        learnMyCards();
        learnBoardCards();
        learnShowdownCards();
        updateOddsHud();
        addBetSizeButtons();
        trackRoster();

        const ended = handHasEnded();
        if (!ended && lastEnded) { sharedThisHand = false; harvestedThisHand = false; } // new hand began -> reset guards
        lastEnded = ended;

        noteGameId(currentGameId()); // track the current/previous hand id for verification
        retryPendingShares(); // re-check shares that arrived before we knew the id

        if (ended && !harvestedThisHand) {
            harvestedThisHand = true;
            harvestHand(currentHandScope());
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
                    if (shareNextHand) setShareNextHand(false); // consume the one-shot
                }
            }
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
        shareToggle.className = "gpe-toggle";
        const shareBox = document.createElement("input");
        shareBox.type = "checkbox";
        shareBox.id = "gpe-share-next";
        shareBox.addEventListener("change", () => { shareNextHand = shareBox.checked; });
        shareToggle.appendChild(shareBox);
        shareToggle.appendChild(document.createTextNode(" share hand"));

        // One tidy flex row under the chat input for all our controls.
        // (The "odds" toggle moved up to the side panel's tools tab.)
        const tools = document.createElement("div");
        tools.id = "gpe-chat-tools";
        tools.appendChild(btn);
        tools.appendChild(shareToggle);
        input.insertAdjacentElement("afterend", tools);
        syncShareToggleUI();
        document.body.appendChild(panel);
    }

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
            const inp = document.querySelector("input.gpokr-GameWindow-betInput");
            if (!inp || inp.getBoundingClientRect().width === 0) return;
            const bb = parseBigBlind();
            if (!bb) return;
            const cur = parseInt(String(inp.value).replace(/[^\d]/g, ""), 10) || 0;
            let next = cur + (k === "arrowup" ? bb : -bb);
            if (next < 0) next = 0;
            const stack = myStack();
            if (stack && next > stack) next = stack; // cap at all-in
            e.preventDefault();
            setBetInput(inp, next);
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

    // ---------- boot ----------
    setInterval(() => { updateStatBadges(); tagTurnHighlights(); applyBetReadout(); }, 300); // track avatars + turn highlight live
    const boot = setInterval(() => {
        const ready = watchChat();
        addPicker();
        ensureSidePanelTabs();
        if (ready) {
            clearInterval(boot);
            setInterval(() => { watchChat(); addPicker(); ensureSidePanelTabs(); pollHandState(); }, 1500);
        }
    }, 800);
})();