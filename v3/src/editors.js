/* The 3D editors: "3D table" (surfaces and surroundings) and "cards, chips
 * & light" (camera, chips, the light rig), as the classic tools tab had them.
 * Both edit the shared look (lib/look.js): sliders move the scene live and
 * save on release. Card faces and backs are not here any more: on ui2 the
 * table's team decides them. */

import { openPanel, sliderRow, colorRow, choiceRow, checkRow, section, hint, button } from "./lib/panel.js";
import { LOOK_DEFAULTS, BACKDROPS, SEAT_STYLES } from "./lib/look.js";

const pct = (n) => Math.round(n * 100) + "%";
const px = (n) => n.toFixed(1) + "px";
const times = (n) => n.toFixed(2) + "×";
const bright = (n) => (n <= 0.005 ? "off" : n.toFixed(2) + "×");

/* A slider over one look value. */
const lookSlider = (look, key, label, o, reg) => sliderRow(label, {
    ...o,
    get: () => look.get()[key],
    set: (n) => look.live({ [key]: n }),
    save: (n) => look.save({ [key]: n }),
}, reg);

export function openTable3dEditor(ctx, look) {
    return openPanel(ctx, {
        id: "table3d", title: "3D table", width: 330,
        build(body, reg) {
            const zoom = { min: 0.1, max: 10, step: 0.05, fmt: times };
            const depth = { min: 0, max: 3, step: 0.05, fmt: (n) => n.toFixed(2) };
            const color = (key, label, extra) => colorRow(label, {
                get: () => look.get()[key],
                set: (v) => look.live({ [key]: v }),
                save: (v) => look.save({ [key]: v }),
                ...(extra || {}),
            }, reg);
            body.append(
                color("feltColor", "felt colour"),
                lookSlider(look, "feltZoom", "felt zoom", zoom, reg),
                lookSlider(look, "feltDepth", "felt depth", depth, reg),
                color("leatherColor", "leather colour"),
                lookSlider(look, "leatherZoom", "leather zoom", zoom, reg),
                lookSlider(look, "leatherDepth", "leather depth", depth, reg),
                lookSlider(look, "logoOpacity", "logo opacity", { min: 0, max: 1, step: 0.05, fmt: pct }, reg),
                color("bgColor", "background", { auto: true, autoHint: "match ui2's table area", fallback: "#16303a" }),
                choiceRow("floor", [["", "none"]].concat(BACKDROPS.map((b) => [b, b])),
                    { get: () => look.get().backdrop, set: (v) => look.save({ backdrop: v }) }, reg),
                choiceRow("seats", [["", "none"], ...SEAT_STYLES.map((s) => [s, s + "s"])],
                    { get: () => look.get().seats, set: (v) => look.save({ seats: v }) }, reg),
                hint("Zoom = feature size. Depth = relief strength. Floor = a generated surface under the " +
                    "table, which also catches its shadow. Updates live; needs \"3D table and chips\" on."),
                button("Reset to defaults", () => {
                    look.reset(["feltColor", "feltZoom", "feltDepth", "leatherColor", "leatherZoom",
                        "leatherDepth", "logoOpacity", "bgColor", "backdrop", "seats"]);
                    body.closest(".gpt-panel")._refresh();
                }, "gpt-wide-btn"),
            );
        },
    });
}

export function openLookEditor(ctx, look) {
    return openPanel(ctx, {
        id: "look", title: "cards, chips & light", width: 330,
        build(body, reg) {
            const refreshAll = () => body.closest(".gpt-panel")._refresh();

            let s = section(body, "table", () => { look.reset(["elev"]); refreshAll(); });
            s.append(lookSlider(look, "elev", "view angle", {
                min: 25, max: 90, step: 1, fmt: (n) => n.toFixed(0) + "°",
                hint: "where the camera sits, in degrees above the felt; 90 is straight down. " +
                    "Moves the camera only. Rebuilds the table.",
            }, reg));

            s = section(body, "chips", () => {
                look.reset(["chips3d", "chipDrop", "chipDiam", "chipThick", "chipRound"]);
                refreshAll();
            });
            s.append(
                checkRow("3D bets and pot", {
                    get: () => look.get().chips3d, set: (v) => look.save({ chips3d: v }),
                    hint: "draw the table's own bet and pot chips as discs instead of ui2's flat sprites",
                }, reg),
                checkRow("chips fall in, with a clink", {
                    get: () => look.get().chipDrop, set: (v) => look.save({ chipDrop: v }),
                    hint: "a bet drops onto the felt a chip at a time, each one sounding as it lands",
                }, reg),
                lookSlider(look, "chipDiam", "diameter", { min: 8, max: 60, step: 1, fmt: px,
                    hint: "how wide a chip is: on the table, thrown at a seat, and from the celebrations" }, reg),
                lookSlider(look, "chipRound", "edge round", { min: 0, max: 1, step: 0.02,
                    fmt: (n) => (n <= 0.005 ? "square" : Math.round(n * 100) + "%"),
                    hint: "how far a chip's edge is rounded off" }, reg),
                lookSlider(look, "chipThick", "thickness", { min: 0.5, max: 20, step: 0.5, fmt: px,
                    hint: "the default is a real chip's ratio; past about 8px it is a hockey puck" }, reg),
            );

            const axis = (light, a, hintText) => sliderRow(a, {
                min: -40, max: 40, step: 0.5, fmt: (n) => n.toFixed(1), hint: hintText,
                get: () => look.get()[light][a],
                set: (n) => look.live({ [light]: { [a]: n } }),
                save: (n) => look.save({ [light]: { [a]: n } }),
            }, reg);
            const level = (key, label, hintText) => sliderRow(label, {
                min: 0, max: 3, step: 0.05, fmt: bright, hint: hintText,
                get: () => look.get().levels[key],
                set: (n) => look.live({ levels: { [key]: n } }),
                save: (n) => look.save({ levels: { [key]: n } }),
            }, reg);
            const resetLight = (light, levelKeys) => {
                look.save({ [light]: { ...LOOK_DEFAULTS[light] } });
                const lv = {};
                for (const k of levelKeys) lv[k] = LOOK_DEFAULTS.levels[k];
                look.save({ levels: lv });
                refreshAll();
            };

            const keyHint = "the lamp that throws the shadows: cards, chips and the table all take " +
                "their direction from it. Low and to the side gives long shadows.";
            s = section(body, "key light", () => resetLight("key", ["key"]));
            s.append(axis("key", "x", keyHint), axis("key", "y", keyHint), axis("key", "z", keyHint),
                level("key", "brightness", keyHint));

            const fillHint = "the second lamp, opposite the key: it opens up what the key leaves dark " +
                "and casts nothing of its own.";
            s = section(body, "fill light", () => resetLight("fill", ["fill"]));
            s.append(axis("fill", "x", fillHint), axis("fill", "y", fillHint), axis("fill", "z", fillHint),
                level("fill", "brightness", fillHint));

            s = section(body, "ambient & lamp", () => {
                look.save({ levels: { ambient: LOOK_DEFAULTS.levels.ambient, lamp: LOOK_DEFAULTS.levels.lamp } });
                refreshAll();
            });
            s.append(
                level("ambient", "ambient", "flat light from every direction; raise it to lift the shadows"),
                level("lamp", "table lamp", "the hanging lamp over the felt: its falloff gives the felt a bright centre"),
            );
        },
    });
}
