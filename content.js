(function () {
    "use strict";

    const EMOTES = ["🙂","🙁","😀","😉","😡","😭","😎","😍","🤔","🫡","🔥","💩","👏","💀","🤑","🤫"];

    const DISPLAY_MS = 2500;
    const HAND_MS = 6000;

    // Settings (persisted in chrome.storage.local; live-updated from the popup)
    let LOCAL_TEST = false;
    let SHARE_HAND = false;
    let SHOW_ODDS = false;

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
        const cfg = sanitizeBetConfig(s && s.betButtons);
        if (JSON.stringify(cfg) !== JSON.stringify(BET_CONFIG)) {
            BET_CONFIG = cfg;
            rebuildBetColumns();
        }
        syncShareToggleUI();
        syncOddsToggleUI();
    }

    // Persist a single setting without clobbering the others; the popup picks
    // the change up via chrome.storage.onChanged (and vice versa).
    function saveSetting(key, value) {
        if (EXT_STORE) {
            EXT_STORE.get(["gpe_settings"], (res) => {
                const s = res.gpe_settings || {};
                s[key] = value;
                EXT_STORE.set({ gpe_settings: s });
            });
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
        ".gpe-hand-wrap, .gpe-emote-overlay, #gpe-odds-hud, #gpe-local-hand, #gpe-picker-btn, #gpe-picker-panel, .gpe-toggle, .gpe-bet-col"
    ).forEach((el) => el.remove());

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
        EXT_STORE.get(["gpe_settings", CARD_STORE_KEY], (res) => {
            if (res.gpe_settings) applySettings(res.gpe_settings);
            else { // one-time migration from the old localStorage toggles
                const legacy = legacyLocalStorageSettings();
                applySettings(legacy);
                EXT_STORE.set({ gpe_settings: legacy });
            }
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

    // Crude preflop range model from this hand's log: raisers play ~top 18% of
    // hands, callers ~top 35%, blinds/unacted players are random (1.0).
    // A player's tightest preflop action wins.
    const RANGE_RAISE = 0.18, RANGE_CALL = 0.35;
    function parseOppRanges(names) {
        const acted = {};
        for (const line of currentHandScope()) {
            if (/^Dealing (?:flop|turn|river)/i.test(line)) break; // preflop actions only
            let m = line.match(/^(.+?) raises\b/i);
            if (m) { const n = m[1].trim(); acted[n] = Math.min(acted[n] || 1, RANGE_RAISE); continue; }
            m = line.match(/^(.+?) calls\b/i);
            if (m) { const n = m[1].trim(); acted[n] = Math.min(acted[n] || 1, RANGE_CALL); }
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

    // Float over the top bar, just left of the (visible) Sit Out button —
    // fixed positioning so it never expands the bar's layout.
    function placeOddsHud(hud) {
        if (hud.style.display === "none") return;
        const sitOut = Array.from(document.querySelectorAll(".iogc-GameWindow-sitOutButton"))
            .find((b) => b.getBoundingClientRect().width > 0);
        const anchor = sitOut || document.querySelector(".iogc-HeaderPanelRight");
        if (!anchor) { hud.style.left = "12px"; hud.style.top = "60px"; return; }
        const r = anchor.getBoundingClientRect();
        // Top-align with the blue game-window container so the HUD stays out of the play area.
        const container = document.querySelector(".iogc-GameWindow-container");
        const top = container ? container.getBoundingClientRect().top + 2 : r.top;
        hud.style.left = Math.max(0, r.left - 8 - hud.offsetWidth) + "px";
        hud.style.top = top + "px";
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
            ' <span class="gpe-odds-street">(' + streets[board.length] + ")</span></div>";
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
        if (!nameEl) return;
        const name = nameEl.textContent.trim();
        const text = node.textContent.slice(nameEl.textContent.length).replace(/^\s*:\s*/, "");

        const cards = decodeHand(text);
        if (cards) { showHandForName(name, cards); return; }

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

    // ---------- end-of-hand watcher (auto-share, once per hand) ----------
    let sharedThisHand = false;
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

    // Inline "odds" box mirrors the persistent setting (same one as the popup).
    function syncOddsToggleUI() {
        const box = document.getElementById("gpe-show-odds");
        if (box) box.checked = SHOW_ODDS;
    }

    function pollHandState() {
        learnMyCards();
        learnBoardCards();
        learnShowdownCards();
        updateOddsHud();
        addBetSizeButtons();

        const ended = handHasEnded();
        if (!ended && lastEnded) sharedThisHand = false; // new hand began -> reset guard
        lastEnded = ended;

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

        // Inline "odds" HUD toggle — same persistent setting as the popup's
        // checkbox; either one updates the other through chrome.storage.
        const oddsToggle = document.createElement("label");
        oddsToggle.className = "gpe-toggle";
        const oddsBox = document.createElement("input");
        oddsBox.type = "checkbox";
        oddsBox.id = "gpe-show-odds";
        oddsBox.addEventListener("change", () => {
            SHOW_ODDS = oddsBox.checked;
            saveSetting("showOdds", oddsBox.checked);
            updateOddsHud();
        });
        oddsToggle.appendChild(oddsBox);
        oddsToggle.appendChild(document.createTextNode(" odds"));

        input.insertAdjacentElement("afterend", btn);
        btn.insertAdjacentElement("afterend", shareToggle);
        shareToggle.insertAdjacentElement("afterend", oddsToggle);
        syncShareToggleUI();
        syncOddsToggleUI();
        document.body.appendChild(panel);
    }

    // ---------- boot ----------
    const boot = setInterval(() => {
        const ready = watchChat();
        addPicker();
        if (ready) {
            clearInterval(boot);
            setInterval(() => { watchChat(); addPicker(); pollHandState(); }, 1500);
        }
    }, 800);
})();