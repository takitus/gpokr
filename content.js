(function () {
    "use strict";

    const EMOTES = ["🙂","🙁","😀","😉","😡","😭","😎","😍","🤔","🫡","🔥","💩","👏","💀","🤑","🤫"];

    const DISPLAY_MS = 2500;
    const HAND_MS = 6000;

    // Settings (persisted)
    let LOCAL_TEST = false;
    let SHARE_HAND = false;
    let SHOW_ODDS = false;
    try { LOCAL_TEST = localStorage.getItem("gpe_local_test") === "1"; } catch (e) {}
    try { SHARE_HAND = localStorage.getItem("gpe_share_hand") === "1"; } catch (e) {}
    try { SHOW_ODDS = localStorage.getItem("gpe_show_odds") === "1"; } catch (e) {}

    // Remove artifacts orphaned by a previous extension context: after an extension
    // reload the old context's timers die, leaving overlays frozen on screen and
    // buttons with dead listeners. They are re-created by this context as needed.
    document.querySelectorAll(
        ".gpe-hand-wrap, .gpe-emote-overlay, #gpe-odds-hud, #gpe-local-hand, #gpe-picker-btn, #gpe-picker-panel, .gpe-toggle"
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
    const CARD_STORE_KEY = "gpe_card_images_v2";
    const SUIT_GLYPH = { c: "♣", d: "♦", h: "♥", s: "♠" };
    const RANK_LABEL = { T: "10" };

    function loadCardStore() {
        try { return JSON.parse(localStorage.getItem(CARD_STORE_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function saveCardStore(store) {
        try { localStorage.setItem(CARD_STORE_KEY, JSON.stringify(store)); } catch (e) {}
    }

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
    function countActiveOpponents() {
        const names = new Set(
            Array.from(document.querySelectorAll(".iogc-PlayerPanel-name"))
                .filter((n) => n.textContent.trim() && n.getBoundingClientRect().width > 0)
                .map((n) => n.textContent.trim())
        );
        for (const line of currentHandScope()) {
            const m = line.match(/^(.+?) folds$/i);
            if (m) names.delete(m[1].trim());
        }
        return Math.max(1, Math.min(8, names.size - 1)); // -1 = me
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
        const nOpp = countActiveOpponents();
        const { pot, toCall } = parsePotAndToCall();

        // Recompute equity only when hand/board/opponent-count change.
        const key = hand.join("") + "|" + board.join("") + "|" + nOpp;
        if (key !== oddsKey) {
            oddsResult = window.GPE_ODDS.monteCarloEquity(hand, board, nOpp, 5000);
            // Attribute each board card: equity with it vs without it (fewer iters — color only).
            boardDeltas = board.map((c, i) => {
                const without = board.slice(0, i).concat(board.slice(i + 1));
                return oddsResult.equity - window.GPE_ODDS.monteCarloEquity(hand, without, nOpp, 2000).equity;
            });
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
        let html =
            '<div class="gpe-odds-row gpe-odds-title">' + handHtml +
            (board.length ? " | " + boardHtml : "") +
            ' <span class="gpe-odds-street">(' + streets[board.length] + ")</span></div>" +
            '<div class="gpe-odds-row">equity <b>' + pct(eq) + "</b> vs " + nOpp +
            (nOpp === 1 ? " opp" : " opps") + "</div>";
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

    function pollHandState() {
        learnMyCards();
        learnBoardCards();
        learnShowdownCards();
        updateOddsHud();

        const ended = handHasEnded();
        if (!ended && lastEnded) sharedThisHand = false; // new hand began -> reset guard
        lastEnded = ended;

        if (ended && !sharedThisHand && (SHARE_HAND || LOCAL_TEST)) {
            const hand = readMyHand();
            if (hand) {
                const cards = hand.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
                sharedThisHand = true; // one share per hand; mid-hand sharing is impossible
                if (LOCAL_TEST) showHandLocal(cards);
                else if (SHARE_HAND) sendMessage(encodeHand(cards));
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

    // ---------- UI: emote picker + checkboxes ----------
    function makeToggle(id, labelText, initial, onChange) {
        const label = document.createElement("label");
        label.className = "gpe-toggle";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = id;
        box.checked = initial;
        box.addEventListener("change", () => onChange(box.checked));
        label.appendChild(box);
        label.appendChild(document.createTextNode(" " + labelText));
        return label;
    }

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

        const shareToggle = makeToggle("gpe-share-hand", "share hand", SHARE_HAND, (v) => {
            SHARE_HAND = v;
            try { localStorage.setItem("gpe_share_hand", v ? "1" : "0"); } catch (e) {}
        });

        const testToggle = makeToggle("gpe-local-test", "local test", LOCAL_TEST, (v) => {
            LOCAL_TEST = v;
            try { localStorage.setItem("gpe_local_test", v ? "1" : "0"); } catch (e) {}
        });

        const oddsToggle = makeToggle("gpe-show-odds", "odds", SHOW_ODDS, (v) => {
            SHOW_ODDS = v;
            try { localStorage.setItem("gpe_show_odds", v ? "1" : "0"); } catch (e) {}
            updateOddsHud();
        });

        input.insertAdjacentElement("afterend", btn);
        btn.insertAdjacentElement("afterend", shareToggle);
        shareToggle.insertAdjacentElement("afterend", testToggle);
        testToggle.insertAdjacentElement("afterend", oddsToggle);
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