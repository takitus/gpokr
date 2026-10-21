/* A GPokr Tools button at the bottom of ui2's site rail, opening a panel with
 * a switch for every feature. Built from ui2's own rail classes (ui2s-item,
 * ui2s-panel, ...), so it looks and moves like the site's buttons: hover
 * accent, the indicator pill, the slide-in glass panel.
 *
 * Shim only. Under ui2's own extension host the same switches are in
 * Settings > Extensions, drawn from the same manifest. A flip here is saved by
 * the extension (content-v3.js), so the popup and every open tab follow it. */

const LOG = (...a) => console.log("[gpokr-tools shim]", ...a);

// ionicons "options-outline", in the inline-mask form ui2 uses for its icons.
const ICON = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512' fill='none' stroke='black' " +
    "stroke-linecap='round' stroke-linejoin='round' stroke-width='32'>" +
    "<path d='M368 128h80M64 128h240M368 384h80M64 384h240M208 256h240M64 256h80'/>" +
    "<circle cx='336' cy='128' r='32'/><circle cx='176' cy='256' r='32'/><circle cx='336' cy='384' r='32'/></svg>");
const CLOSE = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512' fill='none' stroke='black' " +
    "stroke-linecap='round' stroke-linejoin='round' stroke-width='32'><path d='M368 368L144 144M368 144L144 368'/></svg>");

function icon(url, size) {
    const s = document.createElement("span");
    s.className = "ui2s-ico";
    s.setAttribute("aria-hidden", "true");
    s.style.cssText = `width:${size}px;height:${size}px;mask-image:url("${url}");-webkit-mask-image:url("${url}")`;
    return s;
}

export function startSettingsRail(manifest, settings, onSet) {
    const switches = (manifest.settings || []).filter((s) => s.type === "switch");

    const sep = document.createElement("div");
    sep.className = "ui2s-sep gpt-rail-sep";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui2s-item gpt-rail-btn";
    btn.dataset.tip = "GPokr Tools";
    btn.setAttribute("aria-label", "GPokr Tools");
    btn.setAttribute("aria-expanded", "false");
    btn.append(icon(ICON, 22));

    const panel = document.createElement("div");
    panel.className = "ui2s-panel is-wide gpt-rail-panel-sheet";
    const hd = document.createElement("div");
    hd.className = "ui2s-panel-hd";
    const title = document.createElement("span");
    title.className = "ui2s-panel-title";
    title.textContent = "GPokr Tools";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "ui2s-panel-act";
    x.setAttribute("aria-label", "Close");
    x.append(icon(CLOSE, 20));
    hd.append(title, x);
    const body = document.createElement("div");
    body.className = "gpt-rail-body";
    const ver = document.createElement("div");
    ver.className = "gpt-rail-ver";
    ver.textContent = `v${manifest.version}`;
    panel.append(hd, body, ver);

    const rows = new Map();
    const edits = new Map();   // setting key -> the row's editor-button holder
    for (const s of switches) {
        const row = document.createElement("label");
        row.className = "gpt-rail-row";
        const text = document.createElement("span");
        text.className = "gpt-rail-text";
        const name = document.createElement("span");
        name.className = "gpt-rail-label";
        name.textContent = s.label;
        text.append(name);
        if (s.hint) {
            const hint = document.createElement("span");
            hint.className = "gpt-rail-hint";
            hint.textContent = s.hint;
            text.append(hint);
        }
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "gpt-rail-switch";
        box.addEventListener("change", () => onSet(s.key, box.checked));
        const holder = document.createElement("span");
        holder.className = "gpt-rail-edits";
        edits.set(s.key, holder);
        row.append(text, holder, box);
        body.append(row);
        rows.set(s.key, box);
    }
    const paint = () => {
        for (const [key, box] of rows) box.checked = settings.values[key] !== false;
    };
    paint();
    const offSettings = settings.subscribe(paint);

    let open = false;
    const setOpen = (v) => {
        open = v;
        panel.classList.toggle("is-open", v);
        btn.classList.toggle("is-active", v);
        btn.setAttribute("aria-expanded", String(v));
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!open); });
    x.addEventListener("click", () => setOpen(false));
    // ui2's own rail buttons open their panels; ours steps aside for them.
    const onRail = (e) => {
        const item = e.target.closest && e.target.closest(".ui2s-rail .ui2s-item, .ui2s-rail .ui2s-home, .ui2s-rail .ui2s-avatar");
        if (item && item !== btn) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape" && open) setOpen(false); };
    document.addEventListener("click", onRail, true);
    document.addEventListener("keydown", onKey);

    // The shell renders late and React may rebuild the rail; keep ours in it,
    // at the bottom of the button list (above the spacer and the avatar).
    const place = () => {
        const rail = document.querySelector("#ui2-shell nav.ui2s-rail");
        const panels = document.querySelector("#ui2-shell .ui2s-panels");
        if (!rail || !panels) return;
        const grow = rail.querySelector(":scope > .ui2s-grow");
        if (btn.parentElement !== rail || btn.nextElementSibling !== grow) {
            rail.insertBefore(sep, grow);
            rail.insertBefore(btn, grow);
        }
        if (panel.parentElement !== panels) panels.append(panel);
    };
    place();
    const timer = setInterval(place, 1000);
    LOG("settings button in the rail");

    // Each feature's editors ("edit", "creator", ...) as buttons on its row,
    // from the list the extension keeps (v3/src/lib/editors.js).
    let registry = null;
    let offRegistry = null;
    const drawEditors = () => {
        for (const holder of edits.values()) holder.textContent = "";
        if (!registry) return;
        for (const [key, list] of registry.all()) {
            const holder = edits.get(key);
            if (!holder) continue;
            for (const e of list) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "gpt-rail-edit";
                b.textContent = e.label;
                b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); e.open(); });
                holder.append(b);
            }
        }
    };
    const api = {
        get editors() { return registry; },
        setEditors(r) {
            if (offRegistry) offRegistry();
            registry = r;
            offRegistry = r ? r.subscribe(drawEditors) : null;
            drawEditors();
        },
    };
    if (window.__gptShim) window.__gptShim.rail = api;

    return () => {
        if (offRegistry) offRegistry();
        if (window.__gptShim && window.__gptShim.rail === api) delete window.__gptShim.rail;
        clearInterval(timer);
        offSettings();
        document.removeEventListener("click", onRail, true);
        document.removeEventListener("keydown", onKey);
        sep.remove(); btn.remove(); panel.remove();
    };
}
