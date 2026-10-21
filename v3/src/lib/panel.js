/* Floating editor panels and the controls inside them, shared by every
 * editor (3D table, cards/chips/light, the interaction creator).
 *
 * A panel is not a dimming modal: the table has to stay visible while a
 * slider is dragged against it. It is dragged by its header, remembers where
 * it was left (per panel, in this browser), and closes with ✕ or Esc.
 *
 * Controls follow one contract: live on input (the scene updates as the
 * slider moves), saved on release (storage is written once, not per frame). */

const open = new Map();   // id -> panel element

function loadPos(ctx, id) { return ctx.storage.local.get("pos." + id); }
function savePos(ctx, id, p) { ctx.storage.local.set("pos." + id, p); }

export function openPanel(ctx, { id, title, build, width }) {
    if (open.has(id)) { closePanel(id); return null; }   // the button toggles it
    const panel = document.createElement("div");
    panel.className = "gpt-root gpt-panel";
    panel.dataset.id = id;
    if (width) panel.style.width = width + "px";

    const head = document.createElement("div");
    head.className = "gpt-panel-head";
    const name = document.createElement("span");
    name.textContent = title;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.title = "close";
    x.addEventListener("click", () => closePanel(id));
    head.append(name, x);
    const body = document.createElement("div");
    body.className = "gpt-panel-body";
    panel.append(head, body);
    document.body.append(panel);

    const pos = loadPos(ctx, id);
    const place = (l, t) => {
        const w = panel.offsetWidth, h = panel.offsetHeight;
        panel.style.left = Math.max(4, Math.min(innerWidth - w - 4, l)) + "px";
        panel.style.top = Math.max(4, Math.min(innerHeight - Math.min(h, innerHeight - 8) - 4, t)) + "px";
    };

    // Drag by the header, not its buttons.
    let drag = null;
    head.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.preventDefault();
    });
    const onMove = (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); };
    const onUp = () => {
        if (!drag) return;
        drag = null;
        savePos(ctx, id, { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) });
    };
    const onKey = (e) => { if (e.key === "Escape") closePanel(id); };
    addEventListener("mousemove", onMove);
    addEventListener("mouseup", onUp);
    addEventListener("keydown", onKey);
    panel._cleanup = () => {
        removeEventListener("mousemove", onMove);
        removeEventListener("mouseup", onUp);
        removeEventListener("keydown", onKey);
        if (panel._onClose) panel._onClose();
    };
    open.set(id, panel);

    const refreshers = [];
    build(body, { refresh: (fn) => refreshers.push(fn) });
    panel._refresh = () => refreshers.forEach((fn) => { try { fn(); } catch (e) { /* control gone */ } });
    if (pos) place(pos.left, pos.top);
    else place(innerWidth - panel.offsetWidth - 24, 90);
    return panel;
}

export function closePanel(id) {
    const p = open.get(id);
    if (!p) return;
    open.delete(id);
    p._cleanup();
    p.remove();
}

export function refreshPanels() { for (const p of open.values()) p._refresh(); }
export const isOpen = (id) => open.has(id);

/* ---------- controls ---------- */

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

/* o: { min, max, step, fmt, hint, get(), set(n) live, save(n) on release } */
export function sliderRow(label, o, reg) {
    const row = el("div", "gpt-row");
    const lab = el("span", "gpt-row-label", label);
    if (o.hint) lab.title = o.hint;
    const sl = el("input");
    sl.type = "range";
    sl.min = o.min; sl.max = o.max; sl.step = o.step;
    const fmt = o.fmt || ((n) => n.toFixed(1));
    const val = el("span", "gpt-row-val");
    const show = (n) => { sl.value = String(n); val.textContent = fmt(n); };
    show(o.get());
    sl.addEventListener("input", () => { const n = parseFloat(sl.value); val.textContent = fmt(n); o.set(n); });
    sl.addEventListener("change", () => o.save(parseFloat(sl.value)));
    if (reg) reg.refresh(() => { if (document.activeElement !== sl) show(o.get()); });
    row.append(lab, sl, val);
    return row;
}

/* A colour swatch; with o.auto, an "auto" button stands for "no colour set". */
export function colorRow(label, o, reg) {
    const row = el("div", "gpt-row");
    const inp = el("input", "gpt-color");
    inp.type = "color";
    const auto = o.auto ? el("button", "gpt-chip-btn", "auto") : null;
    const show = () => {
        const v = o.get();
        inp.value = v || o.fallback || "#000000";
        if (auto) auto.classList.toggle("is-on", !v);
    };
    show();
    inp.addEventListener("input", () => { o.set(inp.value); if (auto) auto.classList.remove("is-on"); });
    inp.addEventListener("change", () => o.save(inp.value));
    if (auto) {
        auto.type = "button";
        auto.title = o.autoHint || "";
        auto.addEventListener("click", () => { o.set(""); o.save(""); show(); });
    }
    if (reg) reg.refresh(show);
    row.append(el("span", "gpt-row-label", label), inp);
    if (auto) row.append(auto);
    return row;
}

/* A row of buttons, one of which is on. options: [[value, text], ...] */
export function choiceRow(label, options, o, reg) {
    const row = el("div", "gpt-row");
    const group = el("div", "gpt-chip-group");
    const btns = options.map(([value, text]) => {
        const b = el("button", "gpt-chip-btn", text);
        b.type = "button";
        b.addEventListener("click", () => { o.set(value); show(); });
        group.append(b);
        return [value, b];
    });
    const show = () => { const v = o.get(); for (const [value, b] of btns) b.classList.toggle("is-on", value === v); };
    show();
    if (reg) reg.refresh(show);
    row.append(el("span", "gpt-row-label", label), group);
    return row;
}

export function checkRow(label, o, reg) {
    const row = el("label", "gpt-row gpt-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!o.get();
    box.addEventListener("change", () => o.set(box.checked));
    if (o.hint) row.title = o.hint;
    if (reg) reg.refresh(() => { box.checked = !!o.get(); });
    row.append(box, el("span", null, label));
    return row;
}

/* A section heading that folds its rows away; with onReset, a "reset" link. */
export function section(parent, text, onReset) {
    const head = el("div", "gpt-section", "");
    const caret = el("span", "gpt-caret", "▾");
    head.append(caret, el("span", null, text));
    const body = el("div", "gpt-section-body");
    if (onReset) {
        const r = el("button", "gpt-section-reset", "reset");
        r.type = "button";
        r.title = "back to the defaults";
        r.addEventListener("click", (e) => { e.stopPropagation(); onReset(); });
        head.append(r);
    }
    head.addEventListener("click", () => {
        const shut = body.hidden = !body.hidden;
        caret.textContent = shut ? "▸" : "▾";
    });
    parent.append(head, body);
    return body;
}

export function hint(text) { return el("div", "gpt-panel-hint", text); }

export function button(text, onClick, cls) {
    const b = el("button", cls || "gpt-chip-btn", text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
}
