/*
 * ws-monitor.js — a read-only tap on the site's own WebSocket.
 *
 * The GWT client receives every table event over one socket
 * (ClientSessionWebSocket in gpokr2/*.cache.js: `c.w = new WebSocket(b);
 * c.w.onmessage = function(a){c.tg(a.data)}`) and dispatches the frames by
 * string name through a registry — `G1(e.typeName,'ChatEvent')`. An event type
 * the registry doesn't know is dropped on the floor and never reaches the DOM,
 * which is the case for InteractionEvent. Since every other feature here works
 * by observing the DOM, that means a new event type is invisible to us unless we
 * read the socket ourselves.
 *
 * So: wrap the WebSocket constructor and add our OWN message listener to each
 * new socket. Additive — addEventListener doesn't disturb the client's
 * `onmessage =` assignment, and we never send, never modify a frame, and never
 * touch the client's copy of the data.
 *
 * This file runs in the PAGE world (that's the point — the isolated content
 * script world has its own WebSocket that the site never uses), so it has no
 * access to extension APIs and talks to content.js by postMessage.
 *
 * TWO THINGS TO KEEP IN MIND, both because the page world is shared with the
 * site and with third-party ad scripts:
 *   1. Anything posted to window is readable by any script on the page. So the
 *      allowlist below must never carry private game state — hole cards must
 *      not leave this file. Cosmetic broadcast-to-the-whole-table events only.
 *   2. Anything on window is readable the same way, so the tally we keep for
 *      debugging holds counts by default and event bodies only when a human
 *      explicitly turns that on.
 *
 * Loaded three ways, same file each time:
 *   - extension:   a content script with "world": "MAIN", "all_frames": true,
 *                  "match_about_blank": true, "run_at": "document_start"
 *   - site build:  content.js loadScript()s it (see the caveat at HOOK below)
 *   - by hand:     paste it in a console to inspect a live table
 */
(function () {
    "use strict";

    // Idempotent: double-injection (extension + site build, or a re-injected
    // content script) must not stack wrappers on the constructor.
    if (window.__gpeWs) return;

    var MARK = "gpe-ws";        // postMessage discriminator, checked on the other side
    var MAX_FRAME = 262144;     // don't parse absurd frames; the real ones are small

    // Event typeNames we forward to content.js. Deliberately tiny — see note 1
    // above. Everything else is counted and discarded.
    var WANTED = { InteractionEvent: true };

    var api = {
        // typeName -> how many have arrived. Counts only: safe to leave exposed.
        seen: Object.create(null),
        // typeName -> the last event body, ONLY while debug is on. Never
        // populated otherwise, so game events don't sit on window for the page
        // (and its ad scripts) to read.
        last: Object.create(null),
        // A prefix of a frame we couldn't parse as JSON, so the wire format can
        // be identified if it ever isn't JSON. Debug only.
        rawSample: null,
        debug: false,
        sockets: 0,   // sockets constructed through the wrapper
        adopted: 0,   // already-open sockets picked up via the send() patch
        hooked: 0,    // realms patched (top window + same-origin frames)
        t0: (function () { try { return Math.round(performance.now()); } catch (e) { return -1; } })(),
        frames: [],   // {id, at, preexisting} per frame hooked — is the tap early enough?
        // Widen the allowlist at runtime while debugging (chat reactions, etc.).
        want: function (name) { if (typeof name === "string" && name) WANTED[name] = true; },
        // Whether a client id has been seen — never the value itself.
        hasClientId: function () { return !!clientId; },
    };
    window.__gpeWs = api;

    // content.js listens on the TOP window, but this file usually runs inside the
    // module iframe (see HOOK), so a plain window.postMessage would talk to the
    // iframe and nobody would hear it. Post to the top window, and to our own
    // when we already are it.
    var target = null, targetOrigin = "*";
    try {
        target = window.top || window;
        // about:blank inherits the parent's origin, but read it off the top
        // window rather than location, which can be "null" in an inherited doc.
        targetOrigin = (target.location && target.location.origin) || location.origin || "*";
    } catch (e) {
        target = window;
        targetOrigin = location.origin || "*";
    }

    function post(msg) {
        try {
            target.postMessage(msg, targetOrigin);
            if (target !== window) window.postMessage(msg, targetOrigin);
        } catch (e) {}
    }

    // Frames are JSON in an {events:[...]} envelope, one typeName per event —
    // e.g. {"events":[{"seat":2,"amount":50,"publisher":184881,
    // "typeName":"BetRaiseEvent"}]}. Single events and other envelopes have not
    // been observed but cost nothing to tolerate, so walk both shapes shallowly
    // and pick out anything carrying a typeName.
    function collect(value, out, depth) {
        if (!value || depth > 4 || out.length > 64) return;
        if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i++) collect(value[i], out, depth + 1);
            return;
        }
        if (typeof value !== "object") return;
        if (typeof value.typeName === "string") { out.push(value); return; }
        // Unknown envelope: look one level down through the usual suspects
        // rather than walking every key of every frame.
        var keys = ["events", "event", "list", "items", "data", "payload", "e"];
        for (var k = 0; k < keys.length; k++) {
            if (value[keys[k]]) collect(value[keys[k]], out, depth + 1);
        }
    }

    // ---------- the client id, and why it never leaves this closure ----------
    // Acting on a table over REST needs the session's IOGC-Client-ID header; without
    // it the server accepts the request and silently drops it (a 204 that does
    // nothing — which is exactly how this was found). The id arrives on this socket
    // as a top-level `clientId`, the same way the site's own client reads it.
    //
    // It is a capability, not a preference: combined with the cookies the browser
    // attaches to any same-origin request, it is what lets a call act on this
    // user's seat — fold, bet, leave. It is deliberately NOT in localStorage,
    // sessionStorage or a cookie (checked), so today no page script can reach it.
    //
    // Which is why it is not forwarded to content.js. Everything else here crosses
    // to the extension by window.postMessage, and that channel is readable by every
    // script on the page, ad frames included — publishing the id there would hand
    // any of them the ability to fold the user's hand. So the id stays in this
    // closure, and instead of exporting the credential we export one narrow,
    // cosmetic action (see the command listener below). Worst case, a page script
    // makes the user throw a chip; it can never make them bet.
    var clientId = null;

    function noteClientId(obj) {
        if (!obj || typeof obj.clientId !== "string" || !obj.clientId) return;
        var first = !clientId;
        clientId = obj.clientId;
        // Tell the extension it can send — the BOOLEAN, never the id. content.js
        // hides the interact UI until it hears this, so the feature is never
        // offered where it would silently do nothing (the site-hosted build loads
        // us long after the socket opened, so we never see a session frame there).
        if (first) post({ __gpe: "gpe-ready", canSend: true });
    }

    function onFrame(data) {
        if (typeof data !== "string" || !data || data.length > MAX_FRAME) return;
        var parsed;
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            // Not JSON — record a sample so the format can be identified, then
            // stop. Truncated hard: a frame body is not something to leave lying
            // around on window.
            if (api.debug && !api.rawSample) api.rawSample = data.slice(0, 200);
            return;
        }
        noteClientId(parsed);   // the session frame carries it at the top level
        var events = [];
        collect(parsed, events, 0);
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            noteClientId(ev);   // ...or on the event itself, depending on the frame
            var name = ev.typeName;
            api.seen[name] = (api.seen[name] || 0) + 1;
            if (api.debug) api.last[name] = ev;
            if (!WANTED[name]) continue;
            // Forward named fields only, never the raw event: this crosses into
            // a page-readable channel, so the shape is explicit and auditable
            // rather than "whatever the server sent".
            post({
                __gpe: MARK,
                ev: {
                    typeName: name,
                    type: ev.type,
                    payload: ev.payload,
                    fromUserId: ev.fromUserId,
                    toUserId: ev.toUserId,
                },
            });
        }
    }

    // ---------- command channel ----------
    // content.js cannot send an interaction itself: it lives in the isolated world
    // and the header value above is deliberately kept from it. So it asks us, and
    // we make exactly one call.
    //
    // This is a narrow capability on purpose. It is NOT a "fetch with my header"
    // proxy — the URL is fixed here, the method is fixed here, and the fields are
    // validated against the same limits the server documents. The most a hostile
    // caller (any page script can post to this) can achieve is a cosmetic throw
    // that the server already rate-limits to one per 2s.
    var INTERACT_URL = "/api/gpokr/table/interact";
    var MAX_TYPE = 32, MAX_PAYLOAD = 1024;

    function handleCommand(d) {
        if (!d) return;
        // "Can you send?" — answered only by a realm that actually can, for the
        // same reason as below.
        if (d.__gpe === "gpe-probe") {
            if (clientId) post({ __gpe: "gpe-ready", canSend: true });
            return;
        }
        if (d.__gpe !== "gpe-send" || d.kind !== "interact") return;
        var reply = { __gpe: "gpe-sent", id: d.id, ok: false, status: 0 };
        // FIRST, before anything can be replied to: this file runs in EVERY
        // same-origin frame (all_frames), and only the one that saw the socket has
        // an id. A realm that cannot send must stay completely silent, or its "no"
        // races the real sender's "yes" and the caller resolves on whichever lands
        // first — which is precisely what swallowed the first real interaction.
        // The caller times out on its own if nobody can send.
        if (!clientId) return;
        var type = d.type, toUserId = d.toUserId, payload = d.payload;
        if (typeof type !== "string" || !type || type.length > MAX_TYPE) { reply.why = "bad type"; return post(reply); }
        if (typeof payload !== "string" || payload.length > MAX_PAYLOAD) { reply.why = "bad payload"; return post(reply); }
        if (typeof toUserId !== "number" || !isFinite(toUserId) || toUserId < 0) { reply.why = "bad toUserId"; return post(reply); }
        try {
            fetch(INTERACT_URL, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json", "IOGC-Client-ID": clientId },
                body: JSON.stringify({ type: type, toUserId: Math.floor(toUserId), payload: payload }),
            }).then(function (r) {
                reply.ok = r.ok;
                reply.status = r.status;
                post(reply);
            }, function () {
                reply.why = "network";
                post(reply);
            });
        } catch (e) {
            reply.why = "threw";
            post(reply);
        }
    }

    function listenForCommands(w) {
        try {
            w.addEventListener("message", function (e) {
                // Same-origin only. A weak check by design — a page script can
                // satisfy it — which is why the capability above is deliberately
                // tiny.
                if (e.origin !== location.origin) return;
                try { handleCommand(e.data); } catch (err) {}
            });
        } catch (err) {}
    }
    listenForCommands(window);
    // A message posted to the top window is delivered to the top window's
    // listeners only, so being in a child frame means we must listen there too.
    // Two listeners on two different windows can't double-handle one event.
    if (target && target !== window) listenForCommands(target);

    // ---------- HOOK ----------
    // Measured facts that dictate everything here. GWT's classic linker runs the
    // compiled module inside a hidden same-origin iframe (<iframe id="gpokr2">,
    // the one holding $wnd / __gwtModuleFunction). The module reaches the page's
    // DOM through $wnd/$doc — which is why our DOM-observing features work from
    // the top document — but a *bare* global like `WebSocket` resolves against
    // the iframe's own window, a different object from the top window's. And the
    // socket opens EARLY: measured at t=55ms, in that iframe's realm.
    //
    // Two consequences, both learned the hard way:
    //   - Patching only the top window sees literally zero sockets. A getter
    //     trap on the top window's WebSocket confirmed the client never reads it.
    //   - Patching the iframe from outside loses the race. By the time the
    //     iframe element exists and a MutationObserver reports it (~307ms), the
    //     socket inside it is long since open.
    //
    // Hence the manifest entry: world MAIN + all_frames + match_about_blank +
    // document_start, so this file executes INSIDE the module iframe's realm
    // before any of its scripts. hook(window) below is then the path that
    // matters; the frame-walking after it is best-effort for the site-hosted
    // build, where we are loaded by the host page in the top realm and can only
    // reach the iframe from outside.
    //
    // A constructor wrapper only catches sockets opened after it lands — there
    // is no way to retrofit one already open — so in the site build a socket
    // that beat us is caught on its next reconnect. Nothing breaks; interactions
    // just don't arrive until then.

    // Build the wrapper per target realm, closing over THAT realm's native
    // constructor, so the socket object belongs to the window that asked for it
    // (its origin, its lifetime) instead of leaking ours into the iframe.
    function wrapFor(w) {
        var Native = w.WebSocket;
        if (typeof Native !== "function") return null;

        function GpeWebSocket(url, protocols) {
            var ws = (arguments.length > 1) ? new Native(url, protocols) : new Native(url);
            api.sockets++;
            try {
                // Passive listener: never preventDefault, never stopPropagation,
                // never modify the frame. The client's own `onmessage =`
                // assignment is untouched and fires as it always did.
                ws.addEventListener("message", function (e) {
                    try { onFrame(e.data); } catch (err) {}
                });
                // Claim it, so the send() patch's adopt() doesn't attach a SECOND
                // listener to a socket we already watch — that would dispatch every
                // frame twice and play each interaction twice over.
                ws.__gpeAdopted = true;
            } catch (e) {}
            return ws;
        }

        // Keep the surface identical: the client feature-tests with
        // `typeof WebSocket !== "undefined"` and reads the readyState constants.
        GpeWebSocket.prototype = Native.prototype;
        ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
            try { GpeWebSocket[k] = Native[k]; } catch (e) {}
        });
        return GpeWebSocket;
    }

    // ---------- adopting a socket that is already open ----------
    // A constructor wrapper only ever sees sockets opened after it lands, which
    // leaves the site-hosted build with nothing: gpokr's own client injects our
    // loader after it has booted, so its socket is long open by the time we run.
    //
    // But the prototype is patchable at any time, and it reaches EXISTING
    // instances. Inside a patched send(), `this` is the live socket — so the first
    // outgoing frame hands us the instance, and from there addEventListener gets
    // us incoming frames after all. The client pings with
    // {action:'ping', clientId:'...'} (see Isb() in the client bundle), so the same
    // frame also carries the id the REST call needs.
    //
    // Cost: nothing works until the client's next ping, rather than immediately.
    // Outgoing frames are read ONLY for that id and are never forwarded anywhere.
    function adopt(ws) {
        try {
            if (!ws || ws.__gpeAdopted) return;
            ws.__gpeAdopted = true;
            api.adopted++;
            ws.addEventListener("message", function (e) {
                try { onFrame(e.data); } catch (err) {}
            });
        } catch (e) {}
    }

    function readOutgoing(data) {
        // Cheap reject first: this runs on every frame the client sends.
        if (typeof data !== "string" || data.length > MAX_FRAME || data.indexOf("clientId") < 0) return;
        try { noteClientId(JSON.parse(data)); } catch (e) {}
    }

    function hookSend(w) {
        try {
            const proto = w.WebSocket && w.WebSocket.prototype;
            if (!proto || proto.__gpeSendHooked) return;
            const send = proto.send;
            if (typeof send !== "function") return;
            proto.send = function (data) {
                // Never let our bookkeeping break the client's own send.
                try { adopt(this); readOutgoing(data); } catch (e) {}
                return send.apply(this, arguments);
            };
            proto.__gpeSendHooked = true;
        } catch (e) {}
    }

    function hook(w) {
        try {
            if (!w || w.__gpeWsHooked) return false;
            var wrapped = wrapFor(w);
            if (!wrapped) return false;
            w.WebSocket = wrapped;
            w.__gpeWsHooked = true;
            hookSend(w);   // also reach any socket already open in this realm
            api.hooked++;
            return true;
        } catch (e) {
            return false; // cross-origin frame, or a locked-down global
        }
    }

    // Same-origin frames only — anything else throws on property access and is
    // none of our business (the ad iframes on the page are cross-origin).
    function hookFrame(frame, preexisting) {
        try {
            if (!frame) return;
            var w = frame.contentWindow;
            if (!w || !w.document) return; // cross-origin: skip silently
            if (hook(w)) {
                try {
                    api.frames.push({
                        id: frame.id || "(anon)",
                        at: Math.round(performance.now()),
                        preexisting: !!preexisting,
                    });
                } catch (e) {}
            }
            // about:blank starts with a throwaway global; a later navigation
            // replaces it and drops our wrapper, so re-hook when it settles.
            if (!frame.__gpeWsLoad) {
                frame.__gpeWsLoad = true;
                frame.addEventListener("load", function () {
                    try { if (frame.contentWindow) { frame.contentWindow.__gpeWsHooked = false; hook(frame.contentWindow); } } catch (e) {}
                });
            }
        } catch (e) {}
    }

    hook(window); // ui2 and any future non-GWT client live here

    // The GWT iframe doesn't exist yet at document_start — nocache.js creates it
    // during load — so catch it the moment it's inserted, before the module
    // script inside it runs.
    try {
        var mo = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var added = records[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    if (!n || n.nodeType !== 1) continue;
                    if (n.tagName === "IFRAME") hookFrame(n);
                    else if (n.getElementsByTagName) {
                        var nested = n.getElementsByTagName("iframe");
                        for (var k = 0; k < nested.length; k++) hookFrame(nested[k]);
                    }
                }
            }
        });
        mo.observe(document.documentElement || document, { childList: true, subtree: true });
        api._mo = mo;
    } catch (e) {}

    // Whatever already existed (a re-injection, a console paste, or the site
    // build loading us late).
    try {
        var frames = document.getElementsByTagName("iframe");
        // preexisting = it was already in the DOM when we ran, i.e. we may have
        // arrived after the module inside it started up.
        for (var i = 0; i < frames.length; i++) hookFrame(frames[i], true);
    } catch (e) {}

    if (!api.hooked) delete window.__gpeWs; // couldn't hook anything — don't claim we did
})();
