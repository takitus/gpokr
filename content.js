(function () {
    "use strict";

    const EMOTES = ["🙂","🙁","😀","😉","😡","😭","😎","😍","🤔","🫡","🔥","💩","👏","💀","🤑","🤫"];

    const DISPLAY_MS = 2500;
    const HAND_MS = 6000;

    // Settings (persisted)
    let LOCAL_TEST = false;
    let SHARE_HAND = false;
    try { LOCAL_TEST = localStorage.getItem("gpe_local_test") === "1"; } catch (e) {}
    try { SHARE_HAND = localStorage.getItem("gpe_share_hand") === "1"; } catch (e) {}

    // ---------- helpers: name -> avatar ----------
    function getSeatName(panel) {
        const link = panel.querySelector('a[href*="/profile/"]');
        if (link && link.textContent.trim()) return link.textContent.trim();
        const bold = panel.querySelector("b, strong");
        if (bold && bold.textContent.trim()) return bold.textContent.trim();
        return null;
    }

    function findAvatarByName(name) {
        const panels = document.querySelectorAll('table[class*="iogc-PlayerPanel"]');
        for (const p of panels) {
            if (getSeatName(p) === name) return p.querySelector("img.iogc-PlayerPanel-avatar");
        }
        return null;
    }

    // Position a fixed overlay over an avatar; never modifies the avatar's DOM.
    function anchorToAvatar(overlay, avatar, lifetimeMs) {
        function place() {
            const r = avatar.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) { overlay.style.display = "none"; return; }
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
    function showEmoteOnAvatar(avatar, glyph) {
        if (!avatar) return;
        let overlay = avatar._gpeEmote;
        if (!overlay || !overlay.isConnected) {
            overlay = document.createElement("div");
            overlay.className = "gpe-emote-overlay";
            overlay.style.position = "fixed";
            overlay.style.transform = "translate(-50%, -50%) scale(0.3)";
            document.body.appendChild(overlay);
            avatar._gpeEmote = overlay;
        }
        overlay.textContent = glyph;
        anchorToAvatar(overlay, avatar, DISPLAY_MS);
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
    const CARD_STORE_KEY = "gpe_card_images";
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

    function learnMyCards() {
        const hand = readMyHand();
        if (!hand) return;
        const c0 = document.querySelector(".gpokr-Card0 img");
        const c1 = document.querySelector(".gpokr-Card1 img");
        if (!c0 || !c1) return;
        const store = loadCardStore();
        let changed = false;
        if (c0.src.startsWith("data:") && c0.src.length > 1400 && !store[hand[0]]) { store[hand[0]] = c0.src; changed = true; }
        if (c1.src.startsWith("data:") && c1.src.length > 1400 && !store[hand[1]]) { store[hand[1]] = c1.src; changed = true; }
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

    function showHandOnAvatar(avatar, cards) {
        if (!avatar || !cards || !cards.length) return;
        let wrap = avatar._gpeHand;
        if (wrap && wrap.isConnected) wrap.remove();
        wrap = document.createElement("div");
        wrap.className = "gpe-hand-wrap";
        wrap.style.position = "fixed";
        wrap.style.transform = "translate(-50%, -50%)";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
        document.body.appendChild(wrap);
        avatar._gpeHand = wrap;

        anchorToAvatar(wrap, avatar, HAND_MS);
        void wrap.offsetWidth;
        wrap.classList.add("gpe-show");
        clearTimeout(wrap._gpeTimer);
        wrap._gpeTimer = setTimeout(() => {
            wrap.classList.remove("gpe-show");
            setTimeout(() => wrap.remove(), 250);
        }, HAND_MS);
    }

    // Find my two visible face-up hole cards (differ from each other; backs are identical).
    function findMyVisibleCards() {
        const panels = Array.from(document.querySelectorAll(".iogc-PlayerPanel"));
        for (const panel of panels) {
            const c0 = panel.querySelector(".gpokr-Card0 img");
            const c1 = panel.querySelector(".gpokr-Card1 img");
            if (!c0 || !c1) continue;
            const faceUp = (im) => im.src.startsWith("data:") && im.src.length > 1400;
            if (faceUp(c0) && faceUp(c1) && c0.src !== c1.src) return [c0, c1];
        }
        return null;
    }

    // Render my hand locally only (no chat).
    function showHandLocal(cards) {
        if (!cards || !cards.length) return;
        let wrap = document.getElementById("gpe-local-hand");
        if (wrap) wrap.remove();
        wrap = document.createElement("div");
        wrap.id = "gpe-local-hand";
        wrap.className = "gpe-hand-wrap";
        wrap.style.position = "fixed";
        wrap.style.transform = "translate(-50%, -50%)";
        cards.forEach((c) => wrap.appendChild(makeCardEl(c)));
        document.body.appendChild(wrap);

        const anchor = findMyVisibleCards();
        function place() {
            if (anchor && anchor[0].getBoundingClientRect().width > 0) {
                const r = anchor[0].getBoundingClientRect();
                wrap.style.left = r.left + r.width + 30 + "px";
                wrap.style.top = r.top + r.height / 2 + "px";
            } else {
                wrap.style.left = "80px";
                wrap.style.top = "120px";
            }
        }
        place();
        clearInterval(wrap._gpeReposition);
        wrap._gpeReposition = setInterval(place, 200);
        void wrap.offsetWidth;
        wrap.classList.add("gpe-show");
        clearTimeout(wrap._gpeTimer);
        wrap._gpeTimer = setTimeout(() => {
            wrap.classList.remove("gpe-show");
            clearInterval(wrap._gpeReposition);
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
        if (cards) { showHandOnAvatar(findAvatarByName(name), cards); return; }

        const glyph = firstEmoteIn(text);
        if (glyph) showEmoteOnAvatar(findAvatarByName(name), glyph);
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

        input.insertAdjacentElement("afterend", btn);
        btn.insertAdjacentElement("afterend", shareToggle);
        shareToggle.insertAdjacentElement("afterend", testToggle);
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