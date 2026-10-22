/* GPokr Tools v3: an extension for ui2's extension host (API 1). The same
 * module runs under the Chrome shim (shim/host.js) until the site's registry
 * lists it. Every feature sits behind its own manifest switch; what a feature
 * lets you customise is reached from the editors it lists (lib/editors.js). */

import { toggled, slot } from "./slot.js";
import { createHandTracker } from "./hand.js";
import { startHandSummary } from "./features/handSummary.js";
import { startBetReadout } from "./features/betReadout.js";
import { startQuickChat } from "./features/quickChat.js";
import { startBetButtons } from "./features/betButtons.js";
import { startShareHand } from "./features/shareHand.js";
import { startInteractions } from "./features/interactions.js";
import { startTable3d } from "./features/table3d.js";
import { startHotkeys } from "./features/hotkeys.js";
import { startCardStyle, cardBackStyle } from "./features/cardStyle.js";
import { startSeatStyle } from "./features/seatStyle.js";
import { startPlayerNotes } from "./features/playerNotes.js";
import { createPeople } from "./lib/people.js";
import { openTable3dEditor, openLookEditor } from "./editors.js";
import { createPrefs } from "./lib/prefs.js";
import { createLook } from "./lib/look.js";
import { createEditors } from "./lib/editors.js";

function addStyles(ctx) {
    const id = "gpt-styles";
    if (document.getElementById(id)) return () => {};
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = ctx.assets.url("v3/style.css");
    document.head.appendChild(link);
    return () => link.remove();
}

/* The editors as a side panel of buttons, for ui2's own host (the Chrome
 * shim puts them on its settings rows instead and never mounts this). */
function editorsPanel(ctx, editors) {
    const labels = Object.fromEntries((ctx.manifest.settings || []).map((s) => [s.key, s.label]));
    return slot(ctx, (el) => {
        el.classList.add("gpt-root", "gpt-editors");
        const draw = () => {
            el.textContent = "";
            for (const [key, list] of editors.all()) {
                const row = document.createElement("div");
                row.className = "gpt-row";
                row.append(Object.assign(document.createElement("span"), { className: "gpt-row-label", textContent: labels[key] || key }));
                for (const e of list) {
                    const b = document.createElement("button");
                    b.type = "button";
                    b.className = "gpt-chip-btn";
                    b.textContent = e.label;
                    b.addEventListener("click", e.open);
                    row.append(b);
                }
                el.append(row);
            }
        };
        draw();
        const off = editors.subscribe(draw);
        return { destroy: off };
    });
}

export default {
    activate(ctx) {
        const offs = [addStyles(ctx)];
        const tracker = createHandTracker(ctx);
        offs.push(() => tracker.dispose());
        const prefs = createPrefs(ctx);
        const look = createLook(prefs);
        const editors = createEditors();
        const people = createPeople(prefs);

        offs.push(toggled(ctx, "handSummary", (c) => startHandSummary(c, tracker)));
        offs.push(toggled(ctx, "betReadout", (c) => startBetReadout(c, tracker, prefs, editors)));
        // Share first: it sits ahead of the quick-chat buttons in the chat bar.
        offs.push(toggled(ctx, "shareHand", (c) => startShareHand(c, tracker)));
        offs.push(toggled(ctx, "quickChat", (c) => startQuickChat(c, tracker, prefs, editors, people)));
        offs.push(toggled(ctx, "playerNotes", (c) => startPlayerNotes(c, people)));
        offs.push(toggled(ctx, "betButtons", (c) => startBetButtons(c, prefs, editors)));
        // Celebrations ride the same wire as throws, so they live under its switch.
        offs.push(toggled(ctx, "interactions", (c) => startInteractions(c, tracker, editors)));
        offs.push(toggled(ctx, "hotkeys", (c) => startHotkeys(c, prefs)));
        offs.push(toggled(ctx, "cardStyle", (c) => startCardStyle(c, prefs, editors)));
        offs.push(toggled(ctx, "seatStyle", () => startSeatStyle()));
        // The 3D cards wear the chosen back when Card style is on.
        const backStyle = () => (ctx.settings.get("cardStyle") !== false ? cardBackStyle(prefs) : "");
        offs.push(toggled(ctx, "table3d", (c) => startTable3d(c, look, backStyle)));
        // The 3D editors work with the table off too, as they always did: set
        // it up, then switch it on.
        offs.push(editors.set("table3d", [
            { label: "table", open: () => openTable3dEditor(ctx, look) },
            { label: "chips & light", open: () => openLookEditor(ctx, look) },
        ]));
        offs.push(ctx.ui.register("rail.panel", editorsPanel(ctx, editors), { title: "GPokr Tools", editors }));

        ctx.log("active", ctx.manifest.version, "on", ctx.platform);
        return () => { for (let i = offs.length - 1; i >= 0; i--) offs[i](); };
    },
};
