/* A modal editor for an ordered list of buttons: drag ⠿ to reorder, ✕ to
 * remove, "+ Add" for a new row. The chat-button and bet-button editors share
 * it and differ only in the inputs each row carries. Changes are handed back
 * through save() as they happen, the way the classic editors worked. */

export function openListEditor({ title, hint, addLabel, items, renderRow, blank, save }) {
    const list = items.map((x) => ({ ...x }));
    let drag = null;

    const backdrop = document.createElement("div");
    backdrop.className = "gpt-root gpt-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "gpt-modal";
    backdrop.append(modal);

    const head = document.createElement("div");
    head.className = "gpt-modal-head";
    head.append(title);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "close";
    head.append(close);

    const rows = document.createElement("div");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "gpt-modal-add";
    add.textContent = addLabel;
    const tip = document.createElement("div");
    tip.className = "gpt-modal-hint";
    tip.textContent = hint;
    modal.append(head, rows, add, tip);

    const commit = () => { save(list.map((x) => ({ ...x }))); draw(); };

    function draw() {
        rows.textContent = "";
        list.forEach((item, i) => {
            const row = document.createElement("div");
            row.className = "gpt-erow";
            const handle = document.createElement("span");
            handle.className = "gpt-drag";
            handle.textContent = "⠿";
            handle.title = "drag to reorder";
            handle.addEventListener("mousedown", () => { row.draggable = true; });
            row.addEventListener("dragstart", (e) => { drag = i; row.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; });
            row.addEventListener("dragend", () => { row.draggable = false; row.classList.remove("is-dragging"); drag = null; });
            row.addEventListener("dragover", (e) => { e.preventDefault(); if (drag !== null && drag !== i) row.classList.add("is-dragover"); });
            row.addEventListener("dragleave", () => row.classList.remove("is-dragover"));
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("is-dragover");
                if (drag === null || drag === i) return;
                list.splice(i, 0, list.splice(drag, 1)[0]);
                drag = null;
                commit();
            });
            row.append(handle);
            // Inputs edit the item in place; onChange persists without a redraw
            // so typing keeps focus, onCommit redraws for structural changes.
            renderRow(row, item, { onChange: () => save(list.map((x) => ({ ...x }))), onCommit: commit });
            const del = document.createElement("button");
            del.type = "button";
            del.className = "gpt-del";
            del.textContent = "✕";
            del.title = "remove";
            del.addEventListener("click", () => { list.splice(i, 1); commit(); });
            row.append(del);
            rows.append(row);
        });
    }

    const shut = () => { backdrop.remove(); removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") shut(); };
    close.addEventListener("click", shut);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) shut(); });
    add.addEventListener("click", () => { list.push(blank()); commit(); });
    addEventListener("keydown", onKey, true);

    draw();
    document.body.append(backdrop);
    return shut;
}
