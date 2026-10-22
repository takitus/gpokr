/* Nicknames and notes on the other players, as the classic add-on had them.
 * Hovering a seat raises a tab above its player card: the nickname (or "no
 * nickname"), a 📝 when there is a note (the note on hover), and ✎ to edit.
 * The editor takes a nickname, which the quick-chat buttons use in place of
 * the handle, and free-text notes. A nickname also replaces the handle in the
 * player card's name row (the handle on hover).
 *
 * The name row is ui2's React text, so it is never rewritten: it is tagged
 * (data-gpt-nick) and style.css hides its text and draws the nickname over
 * it, keeping the row's size and React's hold on it. */

import { slot } from "../slot.js";

let editor = null;   // the one open editor: { el, name, close }

function closeEditor() { if (editor) editor.close(); }

function openEditor(people, name, anchor) {
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
    nick.value = people.nick(name);
    const box = document.createElement("textarea");
    box.placeholder = "notes on " + name + "…";
    box.value = people.note(name);
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
        btn("Save", () => { people.save(name, nick.value, box.value); closeEditor(); }),
        btn("Delete", () => { people.save(name, "", ""); closeEditor(); }),
    );
    el.append(head, nick, box, row);
    // Keys typed here are not the table's: no hotkeys, no chat focus steal.
    el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") closeEditor();
        if (e.key === "Enter" && e.target === nick) { people.save(name, nick.value, box.value); closeEditor(); }
    });
    const outside = (e) => { if (!el.contains(e.target) && !(e.target.closest && e.target.closest(".gpt-nick-tab"))) closeEditor(); };
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
    const views = new Set();
    const paint = (v) => {
        const name = v.name;
        v.tab.hidden = !name;
        if (!name) return;
        const nick = people.nick(name), note = people.note(name);
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
    const timer = setInterval(() => views.forEach((v) => tagCard(v, v.name ? people.nick(v.name) : "")), 1500);
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
        const v = { tab, nick, note, edit, name: null, col: el.parentElement, row: null };
        const take = (p) => { v.name = p && !p.isMe && p.user ? p.user.name : null; paint(v); };
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
        edit.addEventListener("click", (e) => { e.stopPropagation(); if (v.name) openEditor(people, v.name, tab); });
        take(props);
        views.add(v);
        return { update: take, destroy() { views.delete(v); if (v.row) untag(v.row); if (seat) seat.removeEventListener("pointerenter", place); } };
    }));

    return () => { off(); clearInterval(timer); unreg && unreg(); views.clear(); [...tagged].forEach(untag); closeEditor(); };
}
