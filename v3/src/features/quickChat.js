/* One-tap chat lines in the chat toolbar, with two tokens filled in at send
 * time: [playername], the last player at this table to bust (stand up with no
 * chips, or finish the tournament), and [lastwinner], who took the main pot of
 * the last hand. Neither ever names me. A token nobody fills drops out, so
 * "gg [playername]" with nobody busted sends "gg"; the button's tooltip says
 * what would go out right now. */

import { slot } from "../slot.js";
import { openListEditor } from "../lib/listEditor.js";

export const DEFAULT_CHAT_BUTTONS = [
    { name: "gg*", text: "gg [playername]" },
    { name: "nh*", text: "nh [lastwinner]" },
    { name: "ty", text: "ty" },
    { name: "wp", text: "wp" },
];

/* A list from storage: strings are tolerated, blank messages dropped, and
 * nothing ever saved means the defaults (an emptied list stays empty). */
export function sanitizeChatButtons(list) {
    if (!Array.isArray(list)) return DEFAULT_CHAT_BUTTONS.map((b) => ({ ...b }));
    return list
        .map((b) => (typeof b === "string" ? { name: "", text: b } : b || {}))
        .map((b) => ({ name: String(b.name || "").trim(), text: String(b.text || "").trim() }))
        .filter((b) => b.text)
        .slice(0, 40);
}

const TOKENS = [
    { re: /\[playername\]/gi, label: "[playername]", key: "departed" },
    { re: /\[lastwinner\]/gi, label: "[lastwinner]", key: "winner" },
];

/* call: how to address a player, their nickname if they have one (the
 * classic add-on's displayName), the handle otherwise. */
export function fillTokens(text, names, call = (n) => n) {
    let out = text;
    for (const t of TOKENS) out = out.replace(t.re, names[t.key] ? call(names[t.key]) || names[t.key] : "");
    return out.replace(/\s+/g, " ").trim();
}

function tipFor(b, names, call) {
    const used = TOKENS.filter((t) => { t.re.lastIndex = 0; return t.re.test(b.text); });
    if (!used.length) return b.name && b.name !== b.text ? "sends: " + b.text : "";
    const unknown = used.filter((t) => !names[t.key]).map((t) => t.label);
    const msg = fillTokens(b.text, names, call);
    if (!msg) return "nothing to send yet — " + unknown.join(" and ") + " unknown";
    return "sends: " + msg + (unknown.length ? `  (${unknown.join(" and ")} unknown)` : "");
}

export function startQuickChat(ctx, tracker, prefs, editors, people) {
    const names = { departed: "", winner: "" };
    let departedAge = 0;
    const offs = [];
    const myName = () => (ctx.state.get().user || {}).name;
    // Nicknames only while Player notes is on: switched off, it is all off.
    const call = (n) => (people && ctx.settings.get("playerNotes") !== false && people.nick(n)) || n;

    // [lastwinner]: the main pot of the hand just played, never me.
    offs.push(tracker.subscribe((hand) => {
        if (!hand || !hand.ended) return;
        const main = hand.winners.find((w) => !w.side);
        if (main && main.name !== myName()) names.winner = main.name;
    }));

    // [playername]: a bust at this table. A one-hand grace, then it expires so
    // gg never names someone long gone.
    offs.push(ctx.events.before("StandUpEvent", ({ event, before }) => {
        const p = before.gameInfo && before.gameInfo.playerInfo && before.gameInfo.playerInfo[event.seat];
        if (p && p.user && p.score === 0 && p.user.name !== myName()) {
            names.departed = p.user.name;
            departedAge = 0;
        }
    }));
    offs.push(ctx.events.on("StartHandEvent", () => {
        if (names.departed && ++departedAge > 1) names.departed = "";
        // Tournament finishes are announced in the log; take one only for a
        // player seated here in the last hand.
        const seated = new Set(Object.values((tracker.get() || {}).seats || {}).map((s) => s.name));
        for (const e of ctx.state.log().slice(-60).reverse()) {
            const m = String(e.html || "").replace(/<[^>]+>/g, "").match(/^\s*(.+?) finishes the tournament \d+(?:st|nd|rd|th)\s*$/i);
            if (m && m[1] !== myName() && seated.has(m[1])) { names.departed = m[1]; departedAge = 0; break; }
        }
    }));

    const buttons = () => sanitizeChatButtons(prefs.get("chatButtons"));
    const views = new Set();

    const draw = (el, props) => {
        el.textContent = "";
        for (const b of buttons()) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "gpt-chat-btn";
            btn.textContent = b.name || b.text;
            btn.addEventListener("mouseenter", () => { btn.title = tipFor(b, names, call); });
            btn.addEventListener("click", () => {
                const msg = fillTokens(b.text, names, call);
                if (msg) props.send(msg);
            });
            el.append(btn);
        }
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "gpt-chat-btn gpt-chat-edit";
        edit.textContent = "✎";
        edit.title = "edit chat buttons";
        edit.addEventListener("click", openEditor);
        el.append(edit);
    };

    function openEditor() {
        openListEditor({
            title: "Chat buttons",
            addLabel: "+ Add button",
            hint: "Name is the button label (defaults to the message). The message is what gets posted — " +
                "use [playername] (the last player here to bust) or [lastwinner] (winner of the last hand). " +
                "Add, rename, remove, or drag ⠿ to reorder.",
            items: buttons(),
            blank: () => ({ name: "", text: "" }),
            renderRow(row, b, { onChange }) {
                const name = document.createElement("input");
                name.type = "text";
                name.className = "gpt-chat-name";
                name.value = b.name;
                name.placeholder = "name";
                name.title = "button label (defaults to the message)";
                const txt = document.createElement("input");
                txt.type = "text";
                txt.className = "gpt-chat-text";
                txt.value = b.text;
                txt.placeholder = "message (use [playername])";
                name.addEventListener("input", () => { b.name = name.value; });
                txt.addEventListener("input", () => { b.text = txt.value; });
                name.addEventListener("change", onChange);
                txt.addEventListener("change", onChange);
                row.append(name, txt);
            },
            save: (list) => prefs.set("chatButtons", sanitizeChatButtons(list)),
        });
    }

    offs.push(prefs.onChange((k) => { if (k === "chatButtons") for (const v of views) draw(v.el, v.props); }));
    if (editors) offs.push(editors.set("quickChat", [{ label: "edit", open: openEditor }]));
    prefs.ready.then(() => { for (const v of views) draw(v.el, v.props); });

    offs.push(ctx.ui.register("chat.toolbar", slot(ctx, (el, props) => {
        el.classList.add("gpt-root", "gpt-chat-btns");
        const v = { el, props };
        views.add(v);
        draw(el, props);
        return {
            update(p) { v.props = p; },
            destroy() { views.delete(v); },
        };
    })));

    return () => { offs.forEach((o) => o && o()); views.clear(); };
}
