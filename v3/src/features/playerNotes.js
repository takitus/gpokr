/* Nicknames and notes on the other players, as the classic add-on had them.
 * Hovering a seat raises a tab above its player card: the nickname (or "no
 * nickname"), a 📝 when there is a note (the note on hover), and ✎ to edit.
 * The editor takes a nickname, which the quick-chat buttons use in place of
 * the handle, and free-text notes. A nickname also replaces the handle in the
 * player card's name row (the handle on hover).
 *
 * The name row is ui2's React text, so it is never rewritten: it is tagged
 * (data-gpt-nick) and style.css hides its text and draws the nickname over
 * it, keeping the row's size and React's hold on it.
 *
 * Kept by user id in the Takitus Tools document (lib/people.js). Under ui2's
 * own extension host the hover card is its seat.hover slot, drawn as ui2's
 * bundled 3.0.0 drew it (the takitusTools-hover styles are ui2's); under the
 * Chrome shim, which has no hover slot, it is the classic tab. */

import { slot } from "../slot.js";

let editor = null;   // the one open editor: { el, name, close }

function closeEditor() { if (editor) editor.close(); }

function openEditor(people, who, anchor) {
    const { name, id } = who;
    const same = editor && editor.name === name;
    closeEditor();
    if (same) return;   // ✎ on the same seat again closes it
    const el = document.createElement("div");
    el.className = "gpt-root gpt-note-editor";
    const head = document.createElement("div");
    head.className = "gpt-note-head";
    head.textContent = name;
    const nick = document.createElement("input");
    nick.type = "text";
    nick.maxLength = 40;
    nick.className = "gpt-note-nick";
    nick.placeholder = "nickname (used in chat)";
    nick.title = "how the * chat buttons (gg*, nh*) address this player";
    nick.value = people.nick(name, id);
    const box = document.createElement("textarea");
    box.placeholder = "notes on " + name + "…";
    box.maxLength = 1000;
    box.value = people.note(name, id);
    const row = document.createElement("div");
    row.className = "gpt-note-row";
    const btn = (text, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gpt-chip-btn";
        b.textContent = text;
        b.addEventListener("click", fn);
        return b;
    };
    row.append(
        btn("Save", () => { people.save(name, id, nick.value, box.value); closeEditor(); }),
        btn("Delete", () => { people.save(name, id, "", ""); closeEditor(); }),
    );
    el.append(head, nick, box, row);
    // Keys typed here are not the table's: no hotkeys, no chat focus steal.
    el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") closeEditor();
        if (e.key === "Enter" && e.target === nick) { people.save(name, id, nick.value, box.value); closeEditor(); }
    });
    const outside = (e) => { if (!el.contains(e.target) && !(e.target.closest && e.target.closest(".gpt-nick-tab, .takitusTools-hover"))) closeEditor(); };
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 8) + "px";
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    editor = {
        el, name,
        close() {
            document.removeEventListener("pointerdown", outside, true);
            el.remove();
            if (editor && editor.el === el) editor = null;
        },
    };
    (nick.value ? box : nick).focus();
}

export function startPlayerNotes(ctx, people) {
    const native = !!ctx.react;   // ui2's own host (the shim has no React)
    const views = new Set();
    const paint = (v) => {
        const name = v.name;
        v.tab.hidden = !name || native;
        if (!name) { tagCard(v, ""); return; }
        people.adopt(name, v.id);
        const nick = people.nick(name, v.id), note = people.note(name, v.id);
        v.nick.textContent = nick || "no nickname";
        v.nick.classList.toggle("is-empty", !nick);
        v.note.hidden = !note;
        v.note.title = note;
        v.edit.title = "nickname & notes for " + name;
        tagCard(v, nick);
    };
    // The card's name row, tagged with the nickname, or untagged without one.
    const tagged = new Set();
    function tagCard(v, nick) {
        const row = v.col && v.col.querySelector(".iogc-PlayerPanel-name-portrait");
        if (v.row && v.row !== row) untag(v.row);
        v.row = row;
        if (!row) return;
        if (nick && v.name) {
            if (row.dataset.gptNick !== nick) row.dataset.gptNick = nick;
            if (row.title !== v.name) row.title = v.name;
            tagged.add(row);
        } else untag(row);
    }
    function untag(row) {
        if (!tagged.has(row)) return;
        delete row.dataset.gptNick;
        row.removeAttribute("title");
        tagged.delete(row);
    }
    // ui2 may draw a fresh row (a re-render, a reseat); catch it up.
    const timer = setInterval(() => views.forEach((v) => tagCard(v, v.name ? people.nick(v.name, v.id) : "")), 1500);
    const off = people.onChange(() => views.forEach(paint));

    const unreg = ctx.ui.register("seat.badge", slot(ctx, (el, props) => {
        el.classList.add("gpt-nick-slot");
        const tab = document.createElement("div");
        tab.className = "gpt-root gpt-nick-tab";
        const nick = document.createElement("span");
        nick.className = "gpt-nick-name";
        const note = document.createElement("span");
        note.className = "gpt-nick-note";
        note.textContent = "📝";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "gpt-nick-edit";
        edit.textContent = "✎";
        tab.append(nick, note, edit);
        el.append(tab);
        const v = { tab, nick, note, edit, name: null, id: null, row: null,
            col: el.closest(".iogc-PlayerPanel-portrait-container") || el.parentElement };
        const take = (p) => {
            const u = p && !p.isMe && p.user ? p.user : null;
            v.name = u ? u.name : null;
            v.id = u && u.id != null ? u.id : null;
            paint(v);
        };
        // Above the card when there is room. The top row of seats sits on the
        // table area's top edge, which clips, so there it opens under the seat.
        const seat = el.closest(".iogc-PlayerPanel-portrait-container");
        const place = () => {
            const clip = el.closest(".iogc-TableLayout");
            const col = el.parentElement;
            if (!clip || !col) return;
            const room = col.getBoundingClientRect().top - clip.getBoundingClientRect().top;
            const below = room < tab.offsetHeight + 2;
            tab.classList.toggle("is-below", below);
            tab.style.top = below ? col.offsetHeight + "px" : "";
        };
        if (seat) seat.addEventListener("pointerenter", place);
        edit.addEventListener("click", (e) => { e.stopPropagation(); if (v.name) openEditor(people, { name: v.name, id: v.id }, tab); });
        take(props);
        views.add(v);
        return { update: take, destroy() { views.delete(v); if (v.row) untag(v.row); if (seat) seat.removeEventListener("pointerenter", place); } };
    }));

    // ui2's own host: the hover card, in its seat.hover slot, as 3.0.0 drew it.
    const hovers = new Set();
    const paintHover = (h) => {
        const u = h.user;
        h.el.hidden = !u;
        if (!u) return;
        const nick = people.nick(u.name, u.id), note = people.note(u.name, u.id);
        h.card.className = "takitusTools-hover" + (ctx.theme && ctx.theme.mode() === "dark" ? " is-dark" : "");
        h.nick.className = "takitusTools-hover-nickname" + (nick ? "" : " is-empty");
        h.nick.textContent = nick || "no nickname";
        h.note.hidden = !note;
        h.note.title = note;
        h.note.textContent = note ? "📝 " + note.split("\n")[0] : "";
    };
    const unregHover = native ? ctx.ui.register("seat.hover", slot(ctx, (el, props) => {
        const card = document.createElement("div");
        const nick = document.createElement("span");
        const note = document.createElement("span");
        note.className = "takitusTools-hover-note";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "takitusTools-hover-edit";
        edit.title = "edit nickname & notes";
        edit.setAttribute("aria-label", "Edit nickname and notes");
        edit.textContent = "✎";
        card.append(nick, note, edit);
        card.addEventListener("click", (e) => e.stopPropagation());
        el.append(card);
        const h = { el, card, nick, note, user: props && props.user };
        edit.addEventListener("click", () => { if (h.user) openEditor(people, { name: h.user.name, id: h.user.id }, card); });
        hovers.add(h);
        paintHover(h);
        return { update(p) { h.user = p && p.user; paintHover(h); }, destroy() { hovers.delete(h); } };
    })) : null;
    const offHover = people.onChange(() => hovers.forEach(paintHover));

    return () => {
        off(); offHover(); clearInterval(timer);
        unreg && unreg(); unregHover && unregHover();
        views.clear(); hovers.clear(); [...tagged].forEach(untag); closeEditor();
    };
}
