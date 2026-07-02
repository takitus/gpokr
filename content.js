(function () {
    "use strict";

    const EMOTES = ["🙂","🙁","😀","😉","😡","😭","😎","😍","🤔","🫡","🔥","💩","👏","💀","🤑","🤫"];

    const DISPLAY_MS = 2500;
    const HAND_MS = 6000;

    // Settings (persisted in chrome.storage.local; live-updated from the popup)
    let LOCAL_TEST = false;
    let SHARE_HAND = false;
    let SHOW_ODDS = false;
    let SHOW_STATS = false;
    let HOTKEYS = false;
    let DARK_MODE = false;

    // User-defined bet-sizing buttons: multiplier × base ("blind"/"pot"),
    // placed in the column above or below the bet input per `pos`. The top
    // column is always capped by "all in". List order = render order.
    const DEFAULT_BET_BTNS = [
        { mult: 3, base: "blind", pos: "top" },
        { mult: 2, base: "blind", pos: "top" },
        { mult: 0.5, base: "pot", pos: "bottom" },
        { mult: 0.67, base: "pot", pos: "bottom" },
        { mult: 1, base: "pot", pos: "bottom" },
    ];
    let BET_CONFIG = DEFAULT_BET_BTNS;

    // Defaults only when nothing was ever saved; an explicitly emptied list
    // stays empty (just "all in"). Bad entries are dropped; entries saved
    // before `pos` existed infer it from the base (blind->top, pot->bottom).
    function sanitizeBetConfig(list) {
        if (!Array.isArray(list)) return DEFAULT_BET_BTNS;
        return list
            .filter((c) => c && (c.base === "blind" || c.base === "pot") &&
                typeof c.mult === "number" && isFinite(c.mult) && c.mult > 0)
            .map((c) => ({
                mult: c.mult,
                base: c.base,
                pos: c.pos === "top" || c.pos === "bottom" ? c.pos
                    : (c.base === "blind" ? "top" : "bottom"),
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
        const cfg = sanitizeBetConfig(s && s.betButtons);
        if (JSON.stringify(cfg) !== JSON.stringify(BET_CONFIG)) {
            BET_CONFIG = cfg;
            rebuildBetColumns();
        }
        syncShareToggleUI();
        syncSideOptionsUI();
    }

    // Persist a single setting without clobbering the others; the popup picks
    // the change up via chrome.storage.onChanged (and vice versa).
    function saveSetting(key, value) {
        if (EXT_STORE) {
            // try/catch: an orphaned context (extension updated while the tab
            // stayed open) throws "context invalidated" on any storage call.
            try {
                EXT_STORE.get(["gpe_settings"], (res) => {
                    const s = res.gpe_settings || {};
                    s[key] = value;
                    try { EXT_STORE.set({ gpe_settings: s }); } catch (e) {}
                });
            } catch (e) {}
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
        ".gpe-hand-wrap, .gpe-emote-overlay, #gpe-odds-hud, #gpe-local-hand, #gpe-picker-btn, #gpe-picker-panel, .gpe-toggle, #gpe-chat-tools, .gpe-bet-col, .gpe-stat-badge, #gpe-note-editor, #gpe-stat-tip, .gpe-side-tabs, .gpe-side-options, .gpe-side-roster"
    ).forEach((el) => el.remove());
    // ...and un-hide the site's panel content if the old context left a
    // non-site tab active (the class survives but the tab bar above is gone).
    document.querySelectorAll(".gpe-tools-active, .gpe-tab-tools, .gpe-tab-roster").forEach((el) =>
        el.classList.remove("gpe-tools-active", "gpe-tab-tools", "gpe-tab-roster"));

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

    function initStorage() {
        if (!EXT_STORE) { // no extension storage available: legacy fallback
            applySettings(legacyLocalStorageSettings());
            cardStore = legacyLocalStorageCardStore();
            return;
        }
        EXT_STORE.get(["gpe_settings", CARD_STORE_KEY, PLAYER_STATS_KEY, NOTES_KEY], (res) => {
            if (res.gpe_settings) applySettings(res.gpe_settings);
            else { // one-time migration from the old localStorage toggles
                const legacy = legacyLocalStorageSettings();
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
        const handHtml = '<span class="' + equityClass(eq, nOpp) + '">' + hand.join(" ") + "</span>";
        const boardHtml = board
            .map((c, i) => '<span class="' + deltaClass(boardDeltas[i] || 0) + '">' + c + "</span>")
            .join(" ");
        // (Equity is still computed: it colors the hole cards and drives the
        // CALL/FOLD verdict — just no longer shown as its own row.)
        let html =
            '<div class="gpe-odds-row gpe-odds-title">' + handHtml +
            (board.length ? " | " + boardHtml : "") +
            ' <span class="gpe-odds-street">(' + streets[board.length] + ")</span></div>" +
            '<div class="gpe-odds-row">' + oddsLabel + "</div>";
        if (oddsDraw) {
            const parts = [];
            if (oddsDraw.flushOuts) parts.push("flush " + oddsDraw.flushOuts);
            if (oddsDraw.straightOuts)
                parts.push((oddsDraw.straightRanks >= 2 ? "straight " : "gutshot ") + oddsDraw.straightOuts);
            if (oddsDraw.otherOuts) parts.push("boat " + oddsDraw.otherOuts);
            html += '<div class="gpe-odds-row">draw: ' + parts.join(" + ") + " = " + oddsDraw.outs +
                " outs (~" + pct(oddsDraw.hitProb) + ")</div>";
        }
        if (toCall > 0) {
            html += '<div class="gpe-odds-row">pot $' + pot.toLocaleString() +
                " | call $" + toCall.toLocaleString() +
                " | need " + pct(odds) +
                ' <span class="gpe-odds-' + dec.action + '"><b>' + dec.action.toUpperCase() + "</b></span></div>";
        } else {
            html += '<div class="gpe-odds-row">pot $' + pot.toLocaleString() + " | nothing to call</div>";
        }
        hud.innerHTML = html;
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
    function handChecksum(body) {
        let h = 7919;
        const salt = "gpHand!";
        const combined = salt + body + salt;
        for (let i = 0; i < combined.length; i++) h = ((h << 5) + h + combined.charCodeAt(i)) >>> 0;
        return (h % 46656).toString(36).padStart(3, "0");
    }

    function encodeHand(cards) {
        const body = cards.map((c) => c[0].toUpperCase() + c[1].toLowerCase()).join("").toLowerCase();
        return "[gh:" + body + "." + handChecksum(body) + "]";
    }

    function decodeHand(text) {
        const m = text.match(/\[gh:([2-9tjqka][cdhs](?:[2-9tjqka][cdhs])?)\.([0-9a-z]{3})\]/i);
        if (!m) return null;
        const body = m[1].toLowerCase();
        if (handChecksum(body) !== m[2].toLowerCase()) return null;
        const cards = [];
        for (let i = 0; i < body.length; i += 2) cards.push(body[i].toUpperCase() + body[i + 1].toLowerCase());
        return cards;
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

    const handOverlays = new Map(); // player name -> overlay
    function showHandForName(name, cards) {
        if (!name || !cards || !cards.length) return;
        const prev = handOverlays.get(name);
        if (prev && prev.isConnected) prev.remove();
        const wrap = document.createElement("div");
        wrap.className = "gpe-hand-wrap";
        wrap.style.position = "fixed";
        wrap.style.transform = "translate(-50%, -50%)";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
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
    function showHandLocal(cards) {
        if (!cards || !cards.length) return;
        let wrap = document.getElementById("gpe-local-hand");
        if (wrap) wrap.remove();
        wrap = document.createElement("div");
        wrap.id = "gpe-local-hand";
        wrap.className = "gpe-hand-wrap";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
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

        const cards = decodeHand(text);
        if (cards) {
            // Never render my own share back onto my avatar — I can already
            // see my cards; the overlay is for everyone else at the table.
            if (name !== getMyName()) showHandForName(name, cards);
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

    function updatePlayerStats(lines) {
        // Per-hand tallies: vpip/pfr/showdown/sdWin are 0/1 flags,
        // bets/raises/calls are postflop counts (for aggression factor).
        const per = {};
        const get = (n) => (per[n] = per[n] ||
            { vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, showdown: 0, sdWin: 0 });
        let preflop = true;
        for (const line of lines) {
            if (/^Dealing (?:flop|turn|river)/i.test(line)) { preflop = false; continue; }
            let m;
            if ((m = line.match(/^(.+?) (?:folds|checks)$/i))) { get(m[1].trim()); continue; }
            if ((m = line.match(/^(.+?) calls$/i))) {
                const s = get(m[1].trim());
                if (preflop) s.vpip = 1; else s.calls++;
                continue;
            }
            if ((m = line.match(/^(.+?) (bets|raises) \$[\d,]+$/i))) {
                const s = get(m[1].trim());
                const isRaise = /raises/i.test(m[2]);
                if (preflop) { s.vpip = 1; if (isRaise) s.pfr = 1; }
                else if (isRaise) s.raises++;
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
            const t = playerStats[n] ||
                { hands: 0, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, showdowns: 0, sdWins: 0 };
            t.hands++;
            t.vpip += h.vpip;
            t.pfr += h.pfr;
            t.bets += h.bets;
            t.raises += h.raises;
            t.calls += h.calls;
            t.showdowns += h.showdown;
            t.sdWins += h.sdWin;
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

    // ---------- end-of-hand watcher (auto-share + harvest, once per hand) ----------
    let sharedThisHand = false;
    let harvestedThisHand = false;
    let lastEnded = false;
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
    let sideTab = "site"; // "site" | "tools" | "roster"

    // [checkbox id, label, settings key, current value]
    const SIDE_OPTIONS = [
        ["gpe-show-odds", "odds HUD", "showOdds", () => SHOW_ODDS],
        ["gpe-show-stats", "player stats", "showStats", () => SHOW_STATS],
        ["gpe-dark-mode", "dark mode", "darkMode", () => DARK_MODE],
        ["gpe-always-share", "always show cards", "shareHand", () => SHARE_HAND],
        ["gpe-hotkeys", "keyboard shortcuts", "hotkeys", () => HOTKEYS],
    ];

    // Panel checkboxes mirror the persistent settings (same ones as the popup);
    // either UI updates the other through chrome.storage.
    function syncSideOptionsUI() {
        for (const [id, , , current] of SIDE_OPTIONS) {
            const box = document.getElementById(id);
            if (box) box.checked = current();
        }
    }

    const SIDE_TAB_ORDER = ["site", "tools", "roster"];
    function applySideTabState() {
        const inner = document.querySelector(".iogc-LoginPanel .iogc-SidePanel-inner");
        if (!inner) return;
        inner.classList.toggle("gpe-tab-tools", sideTab === "tools");
        inner.classList.toggle("gpe-tab-roster", sideTab === "roster");
        const tabs = inner.querySelector(":scope > .gpe-side-tabs");
        if (!tabs) return;
        Array.from(tabs.children).forEach((b, i) =>
            b.classList.toggle("gpe-active", sideTab === SIDE_TAB_ORDER[i]));
    }

    function ensureSidePanelTabs() {
        const inner = document.querySelector(".iogc-LoginPanel .iogc-SidePanel-inner");
        if (!inner) return;
        if (inner.querySelector(":scope > .gpe-side-tabs")) { applySideTabState(); return; }

        const tabs = document.createElement("div");
        tabs.className = "gpe-side-tabs";
        [["gpokr", "site"], ["tools", "tools"], ["table", "roster"]].forEach(([label, tab]) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.addEventListener("click", () => { sideTab = tab; applySideTabState(); });
            tabs.appendChild(b);
        });

        const pane = document.createElement("div");
        pane.className = "gpe-side-options";
        for (const [id, label, key] of SIDE_OPTIONS) {
            const row = document.createElement("label");
            row.className = "gpe-toggle gpe-side-option";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.id = id;
            box.addEventListener("change", () => saveSetting(key, box.checked));
            row.appendChild(box);
            row.appendChild(document.createTextNode(" " + label));
            pane.appendChild(row);
        }

        // "who's here" roster: its own tab pane
        const rosterPane = document.createElement("div");
        rosterPane.className = "gpe-side-roster";
        const roster = document.createElement("div");
        roster.id = "gpe-roster";
        rosterPane.appendChild(roster);

        inner.prepend(tabs);
        inner.appendChild(pane);
        inner.appendChild(rosterPane);
        syncSideOptionsUI();
        applySideTabState();
        renderRoster();
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

        if (ended && !harvestedThisHand) {
            harvestedThisHand = true;
            harvestHand(currentHandScope());
        }

        if (ended && !sharedThisHand && (SHARE_HAND || shareNextHand || LOCAL_TEST)) {
            const hand = readMyHand();
            if (hand) {
                const cards = hand.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
                sharedThisHand = true; // one share per hand; mid-hand sharing is impossible
                if (LOCAL_TEST) showHandLocal(cards);
                else if (SHARE_HAND || shareNextHand) {
                    sendMessage(encodeHand(cards));
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
    function myStack() {
        const me = getMyName();
        if (!me) return 0;
        for (const p of document.querySelectorAll('table[class*="iogc-PlayerPanel"]')) {
            if (getSeatName(p) !== me) continue;
            if (p.getBoundingClientRect().width === 0) continue;
            const v = parseMoney(p.textContent);
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
    // order. "all in" always caps the top column.
    function betButtonsFor(pos) {
        const btns = pos === "top" ? [["all in", () => myStack()]] : [];
        for (const c of BET_CONFIG) {
            if (c.pos !== pos) continue;
            if (c.base === "blind") {
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
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                setter.call(inp, String(amount));
                inp.dispatchEvent(new Event("input", { bubbles: true }));
                inp.dispatchEvent(new Event("change", { bubbles: true }));
            });
            wrap.appendChild(b);
        });
        document.body.appendChild(wrap);
        placeBetColumn(wrap, below);
        wrap._gpeReposition = setInterval(() => placeBetColumn(wrap, below), 200);
    }

    function addBetSizeButtons() {
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
    setInterval(() => { updateStatBadges(); tagTurnHighlights(); }, 300); // track avatars + turn highlight live
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