/* Custom bet sizing: the player's own buttons, each a multiple of the big
 * blind, a fraction of the pot, or all in. A click only sets the amount on
 * ui2's Bet/Raise button; it never bets. The host clamps it to what the table
 * allows.
 *
 * Amounts come from the table state, not the screen: the big blind from the
 * hand, the pot and the price to call from the bets so far, my stack from my
 * seat. An amount is chips put in now, which is what ui2's button shows.
 *
 * They look and sit as they did on the classic table: two columns flush with
 * the bet control, matching its width, "above" buttons stacked over it and
 * "below" ones under it. ui2's desktop controls have no amount box, so the
 * control is the Bet/Raise button, which shows the amount. ui2 has no
 * bet.helpers slot yet, so the columns place themselves. The classic tools
 * tab that opened the editor is gone; right-click any of the buttons. */

import { openListEditor } from "../lib/listEditor.js";

export const DEFAULT_BET_BUTTONS = [
    { mult: 1, base: "allin", pos: "top" },
    { mult: 3, base: "blind", pos: "top" },
    { mult: 2, base: "blind", pos: "top" },
    { mult: 0.5, base: "pot", pos: "bottom" },
    { mult: 0.67, base: "pot", pos: "bottom" },
    { mult: 1, base: "pot", pos: "bottom" },
];

/* Nothing saved means the defaults; an emptied list stays empty. "allin"
 * ignores mult but keeps one so the editor can switch the base back. */
export function sanitizeBetButtons(list) {
    if (!Array.isArray(list)) return DEFAULT_BET_BUTTONS.map((b) => ({ ...b }));
    const ok = (m) => typeof m === "number" && isFinite(m) && m > 0;
    return list
        .filter((c) => c && (c.base === "allin" || c.base === "blind" || c.base === "pot"))
        .filter((c) => c.base === "allin" || ok(c.mult))
        .map((c) => ({
            mult: ok(c.mult) ? c.mult : 1,
            base: c.base,
            pos: c.pos === "top" || c.pos === "bottom" ? c.pos : (c.base === "pot" ? "bottom" : "top"),
        }));
}

const fmtMult = (m) => String(parseFloat(m.toFixed(4)));

export function labelFor(c) {
    if (c.base === "allin") return "all in";
    if (c.base === "blind") return fmtMult(c.mult) + "x blind";
    return c.mult === 1 ? "pot" : fmtMult(c.mult) + "x pot";
}

/* The amount a button puts in the input, from the state as it is now. A pot
 * bet is the call plus that share of the pot once the call is in. */
export function amountFor(c, state) {
    const gi = state.gameInfo;
    const me = gi && gi.playerInfo ? gi.playerInfo[state.mySeat] : null;
    if (!gi || !me) return 0;
    if (c.base === "allin") return me.score;
    if (c.base === "blind") return Math.round(c.mult * (gi.bigBlind || 0));
    const toCall = Math.max(0, Math.min((gi.highBet || 0) - (me.callAmount || 0), me.score));
    return toCall + Math.round(((gi.pot || 0) + toCall) * c.mult);
}

/* ui2's Bet/Raise button, while it is on screen. */
function findBetControl() {
    const b = document.querySelector("#GGame .gbetting-betraise");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return r.width ? r : null;
}

export function startBetButtons(ctx, prefs, editors) {
    const buttons = () => sanitizeBetButtons(prefs.get("betButtons"));
    const cols = { top: document.createElement("div"), bottom: document.createElement("div") };
    for (const [pos, col] of Object.entries(cols)) {
        col.className = `gpt-root gpt-bet-col gpt-bet-col-${pos}`;
        col.hidden = true;
        col.addEventListener("contextmenu", (e) => { e.preventDefault(); openEditor(); });
        document.body.append(col);
    }

    const draw = () => {
        for (const col of Object.values(cols)) col.textContent = "";
        for (const c of buttons()) {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = labelFor(c);
            b.addEventListener("click", () => {
                const n = amountFor(c, ctx.state.get());
                if (n > 0) ctx.actions.setBetAmount(n);
            });
            cols[c.pos].append(b);
        }
        // With every button removed there would be nothing to right-click.
        if (!cols.top.childElementCount && !cols.bottom.childElementCount) {
            const add = document.createElement("button");
            add.type = "button";
            add.textContent = "+ bet buttons";
            add.addEventListener("click", openEditor);
            cols.bottom.append(add);
        }
    };

    // Shown, sized and placed only while the Bet/Raise button is up.
    let raf = 0;
    const place = () => {
        raf = requestAnimationFrame(place);
        const r = findBetControl();
        for (const [pos, col] of Object.entries(cols)) {
            const show = !!r && col.childElementCount > 0;
            if (col.hidden === show) col.hidden = !show;
            if (!show) continue;
            col.style.left = r.left + "px";
            col.style.width = r.width + "px";
            col.style.top = (pos === "top" ? r.top - col.offsetHeight : r.bottom) + "px";
        }
    };

    function openEditor() {
        openListEditor({
            title: "Bet buttons",
            addLabel: "+ Add button",
            hint: "Right-click a bet button to get back here. Each button sets the bet amount; it never bets for you. Blind = that many big blinds, " +
                "pot = call plus that share of the pot, all in = your stack. Above/below puts it over or under " +
                "the bet box. Drag ⠿ to reorder.",
            items: buttons(),
            blank: () => ({ mult: 2, base: "blind", pos: "top" }),
            renderRow(row, c, { onChange, onCommit }) {
                const mult = document.createElement("input");
                mult.type = "number";
                mult.min = "0.05";
                mult.step = "0.05";
                mult.value = c.mult;
                mult.disabled = c.base === "allin";
                mult.addEventListener("change", () => { const v = parseFloat(mult.value); if (v > 0) { c.mult = v; onChange(); } });
                const base = document.createElement("select");
                for (const [v, t] of [["blind", "× big blind"], ["pot", "× pot"], ["allin", "all in"]]) base.append(new Option(t, v, false, c.base === v));
                base.addEventListener("change", () => { c.base = base.value; onCommit(); });
                const pos = document.createElement("select");
                for (const [v, t] of [["top", "above"], ["bottom", "below"]]) pos.append(new Option(t, v, false, c.pos === v));
                pos.addEventListener("change", () => { c.pos = pos.value; onChange(); });
                row.append(mult, base, pos);
            },
            save: (list) => prefs.set("betButtons", sanitizeBetButtons(list)),
        });
    }

    const offPrefs = prefs.onChange((k) => { if (k === "betButtons") draw(); });
    const offEditor = editors ? editors.set("betButtons", [{ label: "edit", open: openEditor }]) : () => {};
    prefs.ready.then(draw);
    draw();
    place();

    return () => {
        cancelAnimationFrame(raf);
        offPrefs();
        offEditor();
        for (const col of Object.values(cols)) col.remove();
    };
}
