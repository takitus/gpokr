# Store listing / reviewer text

Copy into the Chrome Web Store dashboard fields and AMO's "Notes for reviewer".
Keep it accurate if the code changes — the point of it is that a reviewer can
check every claim against the source in a couple of minutes.

## Single purpose (CWS)

GPokr Tools improves the poker table on gpokr.com for the signed-in player: a
dark theme, a four-color deck and replacement card backs, an odds readout,
per-player notes and statistics, bet-sizing buttons, chat conveniences, and
cosmetic table interactions. It runs only on gpokr.com and does nothing on any
other site.

## Permission justification — `storage`

Stores the user's own settings and locally-derived data: theme choice, bet-button
layout, per-player notes and nicknames, hand statistics computed from the table's
own game log, and session history. All of it stays in `chrome.storage.local` on
the user's machine. The extension has no backend and transmits none of it.

## Site access justification

Every feature is rendered into gpokr.com's own table UI, so access is requested
for `https://gpokr.com/*` and `https://www.gpokr.com/*` and nothing else. No
other host is requested and no code runs anywhere else.

## Remote code

No remote code. With the vector-deck option on, the extension fetches card
artwork (`https://web.gpokr.com/card-symbols/faces/*.svg`) from the site's own
server — the same files gpokr's new UI uses. Those are images: the markup is
placed in an `<img src="data:image/svg+xml,...">`, never inserted into the page's
DOM and never evaluated. No script is fetched or run.

Every executable file ships in the package, including
`vendor/three.iife.js` (an unmodified three.js build used for the 3D table and
throw animations). Nothing is fetched and executed at runtime.

Note for the reviewer, because the source shows loader calls that look like
remote code: the same `content.js` also powers the website's own embedded build,
where it fetches its renderer files from tools.gpokr.com. Those paths are gated
on `SELF_SRC` (`document.currentScript.src`), which is empty for a content
script, so in the extension they are unreachable and every file comes from the
package. See `ensureCoin3d`, `ensureProps3d`, `ensurePropsCatalog` and
`ensureWsMonitor` in `content.js` — each returns early when `SELF_SRC` is empty.

## Why the extension observes the page's WebSocket

gpokr's own game client dispatches server events by name and has no handler for
two of them: `InteractionEvent` (the cosmetic table interactions this extension
renders) and the reaction form of `ChatEvent`. The client drops them, so they
never reach the DOM and cannot be observed any other way.

`bridge/ws-monitor.js` adds a passive `message` listener to the socket the page
already opens. It does not open a socket of its own, does not modify, block, or
retransmit traffic, and leaves the client's own `onmessage` assignment untouched.
An allowlist (`WANTED`, near the top of the file) means only those two event
types are forwarded to the extension; every other frame is ignored. Nothing from
the socket is stored or sent anywhere.

## About the `IOGC-Client-ID` header

gpokr's server requires this header on the two endpoints that publish a cosmetic
interaction or a chat reaction (`POST /api/gpokr/table/interact` and
`/api/gpokr/table/react`). The site delivers the value on the session frame of
that same WebSocket, which is exactly where the site's own client reads it.

The extension keeps it in a closure variable in page memory, attaches it only to
those two same-origin POSTs, and never stores, logs, or transmits it anywhere.
It is not written to storage and is gone when the tab closes.

## Data handling

No data is collected. The extension has no server, no analytics, no telemetry and
no ads. Its only network activity is:

1. Same-origin requests to gpokr.com's own API, using the session the user is
   already signed in with: the table list, a player's public profile/following
   data, and — only on a user action — sending a chat message, an emoji reaction,
   or a cosmetic interaction.
2. Loading playing-card images from `img.iogc.org`, gpokr's own image host, which
   the page itself already loads.
3. With the vector-deck option on, loading the twelve court-card SVGs from
   `web.gpokr.com` — the site's own server, and the same files its new UI
   fetches. Nothing is sent with them (`credentials: "omit"`), and they are
   cached by the browser for a day.

## Where to look (AMO notes for reviewer)

- `bridge/ws-monitor.js` — the tap. `WANTED` allowlist near the top; `clientId`
  handling and the two POST helpers below it.
- `content.js` — `playInteraction` / `parseInteractionPayload`: everything
  arriving from the socket is treated as untrusted and clamped (bounded sequence
  length, bounded pauses, unknown item names skipped) before anything renders.
- `BUILD.md` — how to reproduce the minified files in the package from the
  source archive.
