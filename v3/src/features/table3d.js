/* The 3D table: the classic add-on's WebGL felt, rail, floor and chairs
 * (3d/table3d.js), drawn under ui2's table.
 *
 * table3d frames itself by an element the size of the classic table art
 * (790x451, felt centred at 395,190). ui2's felt has the same proportions, so
 * that frame is built around it (lib/legacy3d classicFrame) as an empty host
 * element and handed to table3d. The host lives in a clipped layer at the back
 * of ui2's table area, under the seats and under pixi's canvas; pixi's own
 * felt is hidden while ours is up, and since pixi draws on a transparent
 * background, its cards and chips sit on our felt.
 *
 * Turning it off disposes the scene and gives pixi its felt back. */

import { ensureCoin, classicFrame } from "../lib/legacy3d.js";
import { findPixiApp, findFelt } from "../lib/pixi.js";
import { startChips3d } from "./chips3d.js";
import { startCards3d } from "./cards3d.js";

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(url));
        document.head.appendChild(s);
    });
}

const FIT = 1.045;

export function startTable3d(ctx, look, backStyle) {
    let stopped = false;
    let area = null;          // ui2's table area; the clip layer lives at its back
    let areaSaved = null;
    let felt = null;          // pixi's felt sprite, hidden while we draw
    let raf = 0;

    const clip = document.createElement("div");
    clip.className = "gpt-table3d-clip";
    const host = document.createElement("div");
    host.className = "gpt-table3d-host";
    clip.append(host);

    const findArea = () => document.querySelector("#GGame .iogc-TableLayout");
    const shapeRect = () => {
        const shape = document.querySelector("#GGame [data-table-shape]");
        return shape ? shape.getBoundingClientRect() : null;
    };

    // Keep the clip in the table area and the host on the classic frame.
    const place = () => {
        raf = requestAnimationFrame(place);
        const a = findArea();
        if (!a) return;
        if (a !== area) {
            if (area) restoreArea();
            area = a;
            areaSaved = { position: a.style.position, isolation: a.style.isolation };
            if (getComputedStyle(a).position === "static") a.style.position = "relative";
            a.style.isolation = "isolate";   // so the clip's z-index:-1 stays inside it
            a.insertBefore(clip, a.firstChild);
        } else if (clip.parentElement !== a) a.insertBefore(clip, a.firstChild);
        const f0 = classicFrame(shapeRect());
        if (!f0) return;
        // table3d's felt reads a little narrower than its frame's 290 art px
        // (the cushion and vignette eat into it), so the frame is grown about
        // the felt centre until the 3D felt covers ui2's. Measured off the
        // rendered canvas against ui2's felt.
        const sc = f0.width / 790, cx = f0.left + 395 * sc, cy = f0.top + 190 * sc;
        const f = { left: cx - 395 * sc * FIT, top: cy - 190 * sc * FIT, width: f0.width * FIT, height: f0.height * FIT };
        const ar = a.getBoundingClientRect();
        host.style.left = f.left - ar.left + "px";
        host.style.top = f.top - ar.top + "px";
        host.style.width = f.width + "px";
        host.style.height = f.height + "px";
        hideFelt();
    };

    function restoreArea() {
        if (!area || !areaSaved) return;
        area.style.position = areaSaved.position;
        area.style.isolation = areaSaved.isolation;
    }

    // pixi rebuilds its scene now and then (a table change, a resize); find
    // the felt again whenever it is not the one we hid.
    function hideFelt() {
        if (felt && felt.parent && felt.visible === false) return;
        const app = findPixiApp();
        const sprite = findFelt(app);
        if (!sprite) return;
        felt = sprite;
        felt.visible = false;
    }

    const T3D = () => window.GPE_TABLE3D;
    ensureCoin(ctx)
        .then((ok) => (ok && !window.GPE_TABLE3D ? loadScript(ctx.assets.url("3d/table3d.js")) : null))
        .then(() => {
            if (stopped || !T3D()) return;
            place();
            T3D().setHost(host);
            // The surround defaults to ui2's own table-area colour (see look),
            // so the scene carries on from the site's background.
            look.apply();
            if (!T3D().enable()) { ctx.log("3D table did not start"); return; }
            look.apply();
            stopChips = startChips3d(ctx, look);
            stopCards = startCards3d(ctx, look, backStyle);
        })
        .catch((e) => ctx.log("3D table unavailable:", e.message));

    let stopChips = null;
    let stopCards = null;
    return () => {
        stopped = true;
        if (stopChips) stopChips();
        if (stopCards) stopCards();
        cancelAnimationFrame(raf);
        if (T3D()) { T3D().disable(); T3D().setHost(null); }
        if (felt) felt.visible = true;
        clip.remove();
        restoreArea();
    };
}
