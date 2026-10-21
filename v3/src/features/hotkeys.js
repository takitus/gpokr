/* Keyboard shortcuts at the table, as the classic add-on had them:
 *   F          fold
 *   C          check / call
 *   Shift+1–9  the custom bet buttons, in their order (ui2 keeps 1, 2 and 3
 *              for its own fold / check-call / bet, so ours move to Shift)
 *   ↑ / ↓      the bet up or down one big blind; so does the scroll wheel
 *              over the Bet/Raise button
 * Nothing fires while typing, and nothing fires off turn: F and C press ui2's
 * own Fold and Check/Call buttons, exactly as a click would, and the bet keys
 * only set the amount — the bet itself is still the player's click. */

import { sanitizeBetButtons, amountFor } from "./betButtons.js";

const isTyping = (t) => t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
const btn = (cls) => {
    const b = document.querySelector("#GGame .gbetting-controls " + cls);
    return b && !b.disabled && b.getBoundingClientRect().width ? b : null;
};
const shownBet = () => {
    const b = btn(".gbetting-betraise");
    return b ? parseInt(b.textContent.replace(/[^\d]/g, ""), 10) || 0 : 0;
};

export function startHotkeys(ctx, prefs) {
    const nudge = (steps) => {
        const cur = shownBet();
        if (!cur) return false;
        const bb = (ctx.state.get().gameInfo || {}).bigBlind || 0;
        if (!bb) return false;
        ctx.actions.setBetAmount(Math.max(0, cur + steps * bb));
        return true;
    };

    const onKey = (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const k = e.key.toLowerCase();
        if (!e.shiftKey && k === "f") { const b = btn(".gbetting-fold"); if (b) { b.click(); e.preventDefault(); } return; }
        if (!e.shiftKey && k === "c") { const b = btn(".gbetting-checkcall"); if (b) { b.click(); e.preventDefault(); } return; }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            if (nudge(e.key === "ArrowUp" ? 1 : -1)) e.preventDefault();
            return;
        }
        // Shift+digit, by physical key so the layout's shifted symbol doesn't matter.
        const m = e.shiftKey && /^Digit([1-9])$/.exec(e.code);
        if (m && btn(".gbetting-betraise")) {
            const list = sanitizeBetButtons(prefs.get("betButtons"));
            const c = list[parseInt(m[1], 10) - 1];
            if (!c) return;
            const n = amountFor(c, ctx.state.get());
            if (n > 0) { ctx.actions.setBetAmount(n); e.preventDefault(); }
        }
    };
    // The wheel over the Bet/Raise button nudges by a big blind per notch.
    const onWheel = (e) => {
        if (!e.target.closest || !e.target.closest("#GGame .gbetting-betraise")) return;
        if (nudge(e.deltaY < 0 ? 1 : -1)) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    addEventListener("wheel", onWheel, { passive: false });
    return () => {
        removeEventListener("keydown", onKey);
        removeEventListener("wheel", onWheel);
    };
}
