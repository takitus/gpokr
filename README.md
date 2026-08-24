# GPokr Tools

A Chrome extension (Manifest V3) that adds quality-of-life features to [gpokr.com](https://gpokr.com): an odds HUD, opponent stats, player notes, bet-sizing helpers, emotes, hand sharing, and a session tracker.

Everything is computed locally from information already visible to you (the game log and the DOM). The extension never acts for you — no auto-fold, auto-bet, or any automated play.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open gpokr.com and sit at a table. Settings live in the extension popup (toolbar icon).

## Features

### Odds HUD
A card floating centered over the table header, live-updated during your hand:

- **Your hand + board**, color-coded: hole cards green/amber/red by equity vs the break-even share for the field; each board card colored by how much it moved your equity when it arrived.
- **Made-hand label** — "two pair, aces and fours", "flush, ace high", etc.
- **Draw info** — flush/straight/boat outs and the odds of hitting by the river.
- **Pot odds + verdict** — when facing a bet: pot, amount to call, the equity you'd need, and a **CALL / MARGINAL / FOLD** read (CHECK when it's free).

Equity is Monte Carlo simulated (5000 deals) against the number of live opponents. Preflop actions tighten simulated ranges: raisers ~top 18%, callers ~top 35% — or, once a player has 20+ observed hands, *their actual measured* PFR/VPIP.

Toggle via the popup ("Odds HUD") or the inline **odds** checkbox next to the chat box — they stay in sync.

### Table interactions
Hover the button on another player's avatar to open a small menu of things to send them, and click as many times as you like while it's open:

- **🪙 chip** — a real 3D chip arcs from your seat, bounces off their avatar and settles on the felt.
- **🍺 beer** — slides across the table, stays upright, and sits on the rail in front of them for ten seconds.
- **🛟 life ring** — lobbed over a player who's going down with the ship: it drops over their avatar, passing behind the portrait and out the other side, then bobs there for five seconds as if they were treading water.

Unlike the older local-only chip toss, these **propagate**: everyone at the table running the extension sees the same throw, at the same time, because the animation plays from the event the server broadcasts back rather than from your click. A send the server refuses (you're watching, you're muted, or you're inside the cooldown) shows as nothing happening, which is the truth.

Cosmetic only — interactions never touch game state. Requires a seat, and everything is held to the server's own 2s cooldown; a few of the bigger ones wait longer than that. Turn the whole thing off with the "interactions" checkbox in the tools tab.

### Opponent stats (badges)
Every completed hand is parsed from the game log and per-player counters persist across sessions. With **Player stats on avatars** enabled, each seat gets a badge:

```
34/14 (79)   →   VPIP% / PFR% (hands observed)
```

Mouse over for the plain-English breakdown (looseness, preflop raise rate, postflop aggression, showdowns won). These same numbers feed the odds HUD's range model.

### Player notes
Click any stats badge to open a note editor for that player ("bluffs rivers", "only raises with nuts"...). Players with notes get a 📝 on their badge; the note shows in the hover tooltip. Notes persist in extension storage. Badges with notes stay visible even when stats are toggled off.

### Bet-sizing buttons
Two button columns float flush against the bet input (visible only when it's your turn to bet), in the top and bottom columns you configure. Clicking fills the bet input — you still press Bet/Raise yourself. Pot math is raise-to: call amount + fraction of the pot after calling. Columns are 75% opacity (solid on hover) so they don't hide turn-progress bars.

**Fully configurable** — in the popup *or* in-page via the **tools** tab's **edit** button. Each button is *multiplier × blind|pot* (decimals fine, `.5` = half), or an **all in** button (multiplier ignored); assign it to the top or bottom column, reorder by dragging the ⠿ handle, remove with ✕. All-in is a normal entry now, so it can be moved, removed, or re-added like any other. Toggle the whole feature with the **bet buttons** checkbox.

### Keyboard shortcuts *(off by default)*
- **F** — fold  **C** — check/call  **1–9** — fill the nth bet-size button's amount (top column first)  **↑ / ↓** — nudge the bet amount by one big blind (clamped to 0 and your stack)
- Never fires while you're typing (chat, bet input) or holding a modifier key. Enable in the popup; hover the ⓘ in the tools tab for the full list.

### Session tracker
Your stack is recorded after every hand. The popup's **Session** section shows net profit/loss, hands played, a sparkline of your stack over time, and a **Reset session** button.

### Emotes
A 😀 button next to the chat input opens an emoji picker. **Any** emoji in a chat message — whether sent from the picker or typed directly, and whether or not it's in the picker — animates over the sender's avatar for anyone running the extension.

### Clickable chat links
URLs posted in chat (`http(s)://…` or `www.…`) are auto-detected and turned into clickable links (opened in a new tab, http/https only). GPokr renders chat as plain text otherwise.

### Quick-chat buttons
A row of one-tap chat buttons sits under the chat input (right of *share hand*), for canned messages like `gg`, `nh`, `ty`, `wp`. Two template tokens are filled in on click:

- **`[playername]`** — the last player to finish the tournament (`NAME finishes the tournament Nth`)
- **`[lastwinner]`** — the winner of the last hand (`NAME wins main/side pot $N`)

So `gg [playername]` posts `gg Behr Necessities`, and `nh [lastwinner]` posts `nh musser` (either collapses to just `gg`/`nh` before one is known).

Edit them with the **✎** button: each has a short **name** (the label, defaults to the message) and a **message** (what's posted). Add, rename, drag ⠿ to reorder, or ✕ to remove your own; the pinned `gg [playername]` button 🔒 is always present. Buttons are stored in your settings.

### Hand sharing
Show your hole cards to other extension users after a hand ends. The extension posts a legible chat line — e.g. `shows cards: A♠, 7♣ [k4a2]` (your name comes from GPokr's own prefix) — rendered as card images over your avatar for anyone running the extension:

- Inline **share hand** checkbox = share at the end of *this* hand only (auto-unchecks)
- Popup **Always share hand at showdown** = every hand
- Popup **Local test mode** = render your own hand locally without sending chat

The trailing `[checksum]` binds the reveal to your name and the hand's unique id (from the hand's replay link), so a copied-and-pasted line won't render on someone else's avatar and an old reveal can't be replayed; each reveal shows at most once per hand. The older `[gh:…]` token is still understood for backward compatibility.

### End-of-hand summary
When a hand ends, a compact panel is dropped into the game log (replacing the hand-divider) with a header — `Name wins $X with <hand>` — and three card columns: **You** (your hole cards), **Board**, and the **🏆 winner**. A **more** arrow expands a per-player breakdown: each player's cards (if shown), a dealer-button badge, and their bet totals by street (Pre / Flop / Turn / River / Total) with a 🏳️ marking where they folded.

Betting is reconstructed from the log (which omits call amounts and blinds): calls are inferred as the amount-to-match, blinds are seeded to the SB/BB seats (the occupied seats clockwise of the button), and an uncalled bet is returned to its bettor — so the per-player totals sum to the pot. The full hand is accumulated across the log's rolling window, so long/multi-way hands aren't truncated. Local view only — nothing is sent to chat. Toggle it with **hand summary** in the tools tab.

### Four-color deck *(off by default)*
Recolors the cards so **diamonds are blue** and **clubs are green**, leaving hearts red and spades black — for players who can't reliably separate the two red suits from the two black ones. Applies everywhere cards are drawn: the board, hole cards, showdowns, shared hands and the end-of-hand summary. Toggle it in the popup or with **four-color deck** in the tools tab.

No new images are involved: the site's own art is recolored in place by two SVG filters, which works because the pips and rank are a single pure ink (`#ff0000` or `#000000`) on neutral paper. Diamonds move that red ink into the blue channel, which leaves every neutral pixel — paper, frame, black text — mathematically untouched. Clubs can't use `hue-rotate` at all (black has no hue to rotate), so the green is flooded through a mask keyed on darkness and thresholded, so the ink turns green and the pale card frame doesn't. Face-card illustrations contain the same ink and so pick up the tint too.

The work is in aiming the filters, not in the recoloring. Hearts are exactly as red as diamonds and spades exactly as black as clubs, so one blanket rule would give blue hearts and green spades and help nobody — every card has to be identified individually, and the site offers nothing to identify it with. GWT inlines all 52 faces into its bundle as data: URIs (no filename in the `src`), the bundle is minified (no identifier survives), and the `<img>`s are recycled between hands with their `src` swapped (so position is no anchor either). What *is* stable is the artwork, so each card is identified by hashing its `src` against a table of the 52 — exact, with nothing that could guess a suit wrong. If gpokr ever reships its deck the hashes stop matching and the feature turns itself off rather than mislabelling; `tools/deck_hashes.py` regenerates the table.

### Cards *(faces, backs, four colours, thickness)*
All of it lives behind **cards → edit** in the tools tab: face, back, four-colour deck, dealing animation and how thick a dealt card is. They were four rows scattered down that tab, which read as four unrelated options when they are really one decision about how a card looks. A floating panel rather than a dimming modal, so the cards stay visible while the thickness slider moves.

**Thickness** is a slider, 0 to 24px. A card lying flat under coin3d's orthographic camera shows *no* edge at all — its depth runs straight down the view axis — so a thick card is leaned toward you, and the lean grows with the thickness because the two are the same question: how much of the card's footprint is edge rather than face. The face is sized so the whole slab fills its slot including the edge, so fattening a card eats into its face instead of growing it out of its box. It rides on the group's Z scale, which is why the slider moves cards already on the table without rebuilding anything. It applies to cards *as they are dealt* — a card the site drew is a flat image with no edge to give it.

### Card faces *(vector deck)*
Draws every card as SVG instead of using the site's 53×69 images. Pick it with **card face** in the cards panel or in the popup; **classic (site)** leaves the cards exactly as they were.

gpokr's own new UI (`/?ui=new`) doesn't ship a deck of images — it composes each card at runtime from four suit paths, thirteen stroked rank glyphs, a per-rank pip layout and a card box, with only the twelve court cards as separate files. `deck-svg.js` holds those tables (about 3.7KB, lifted from that UI's bundle by `tools/gen_deck.py`) and composes cards the same way, so a card comes out looking like the one the new UI draws. The court cards are **fetched from the site on demand** and never bundled or stored: they're 471KB between them, they cache for a day, and a card whose art hasn't arrived yet simply keeps its usual picture.

Because we're drawing rather than recolouring, the four-colour option becomes exact here: blue diamonds and green clubs are the ink in the markup, not an SVG filter over someone else's red and black — so `overlay.css` skips the filters for our own faces (they'd come out black if run through them twice). It's also what the dealing animation textures from, so a dealt card is crisp at any size.

The swap is the same mechanism as the card backs: the size is pinned to the site's own before the src changes, and it's re-applied on mutation because GWT re-sets that `src` on every re-render. Our own faces carry their card in the markup's `id`, which is how the swap recognises its own work and settles instead of oscillating.

### Card backs
Replaces the face-down cards at every seat with one of four bundled designs — **rosette** (red), **lattice** (blue), **fan** (green) or **deco** (gold) — or leaves gpokr's own in place (**classic**). Pick one in the popup or from **card back** in the tools tab. Local to you: other players see whatever back they picked, and nothing about the game changes.

Each is an original drawing in the idiom of a classic casino back — a light border, an all-over ornamental ground, and a center medallion holding an ornate **G**. They take inspiration from that tradition rather than reproducing any house's artwork: Bicycle's Rider Back, Bee's diamond back, a Bellagio deck and the rest are live trademarks and trade dress, so they can't ship here. What carries the look is the structure, which is generic and centuries old.

gpokr draws a player's two face-down cards as a *single* 23×26 image — the pair, the rear card peeking up-and-left, and the soft grey halo they sit on — so a replacement is that whole little still life, not one card. `tools/make_cardbacks.py` draws ours on the same geometry so the swap lines up, and draws it **at 4× from vectors**: GWT pins the `<img>` display size with width/height attributes, so intrinsic size can't affect layout, and on a HiDPI display there are twice the device pixels to fill. The macro composition (border, ground, medallion) is what survives being squashed to 23×26 on a 1× display; the filigree is a bonus where there's resolution for it. `--preview` renders both sizes side by side so that stays honest.

Unlike the four-color deck this can't be done with a filter — no recoloring of one back yields a different *design* — so it's the one place the extension changes the site's DOM: the `<img>` is pointed at a bundled PNG, with width/height pinned first so the 4× asset is never laid out raw. GWT owns that element and re-sets its `src` whenever it re-renders a seat, so the swap is re-applied on mutation rather than once — which settles rather than oscillating, since our own write is recognized and left alone. Observer callbacks run before paint, so the site's back is never seen flashing through.

### Dealing animation
Each community card slides in from off the top of the screen, face down and spinning, and turns over on the spot it lands — the flop one card at a time, then the turn and the river. Toggle it with **dealing animation** in the tools tab (on unless you turn it off).

The card is a real 3D object on the same layer the chips fly on, textured with the site's *own* card image: gpokr inlines its deck as `data:` URIs, so the decoded `<img>` goes straight into a texture with nothing to fetch and nothing to taint it. It then **stays** — it is the card on the board from that point, with the site's `<img>` covered behind it until the board changes. Unlit, deliberately: that makes the texture render exactly as the browser draws the same image in the page, so the board looks no different for having a 3D card standing on it. The back is drawn at runtime rather than shipped (`assets/backs/*.png` are the *pair* still-life a seat shows, the wrong shape for one card) and takes its colour from whichever card back you picked.

Because the card stays, its life is managed rather than self-cleaning: it follows its slot when the table is scaled (the fast poll compares rects), it comes away the moment that slot's `src` changes to another card or to nothing, and it is handed back if the canvas it lives on ever disappears. Parked cards cost nothing per frame — the render loop is allowed to idle and the last frame persists (the renderer keeps its drawing buffer), so it only draws again when a card actually moves.

Which `<img>` is a community card is decided by the **game log**, not by the DOM: a card is unique, so a card the log lists on the board cannot also be in anybody's hand. That needs no knowledge of gpokr's board markup at all, and if the log can't be read the board reads empty and nothing animates — the right way to fail. The log is consulted again on every poll, so a card it stops vouching for is handed back rather than left standing in front of a hidden one.

It started as elimination instead — a card image in the game window, in no seat panel, not one of ours — and that was wrong about the one case it couldn't see: your *own* hole cards, which aren't in a seat panel either. They got dealt in, landed in the wrong order, and since cards park rather than hand back, the real ones stayed covered until a reload.

A card is face-down while it flies, so it reads later than it used to: measured at 0.46s for the first card and 0.69s for the last of the flop, which is fully face-up 0.75s after the deal. That's the real cost of the feature, and why the timings are a budget rather than a taste. Everything fails **open** — no renderer, an image that hasn't decoded, a texture the GPU refuses, an animation that never reports landing (a 1.5s watchdog), a tab hidden mid-flight, the setting being switched off — and every one of those paths uncovers the site's own card. A covered slot with nothing drawn over it is the one state that must never survive.

### Card images
Cards for shared hands and the summary panel are drawn from the site's own canonical images (`img.iogc.org/GPokr/cards/<card>.png`, all 52 verified), with a styled text card as the fallback if one won't load. This replaced an earlier learned store that correlated the game log against the images in your seat — which meant a card you'd never been dealt couldn't be drawn at all, and could be poisoned by learning from other players' showdowns. A canonical URL makes both failure modes impossible.

## Settings & storage

All state lives in `chrome.storage.local` and syncs live between the popup and open tables (no refresh needed):

| Key | Contents |
|---|---|
| `gpe_settings` | toggles + bet-button config |
| `gpe_player_stats` | per-player VPIP/PFR/aggression/showdown counters |
| `gpe_player_notes` | per-player note text |
| `gpe_session` | stack history for the session graph |

Nothing is sent anywhere — no servers, no analytics, no permissions beyond `storage`.

## Development

| File | Role |
|---|---|
| `content.js` | all table logic: log parsing, overlays, HUD, badges, bet columns |
| `odds.js` | pure poker math (no DOM): evaluator, Monte Carlo equity, draws, labels — exposed as `window.GPE_ODDS`, also a CommonJS module |
| `odds.test.js` | offline unit tests — `node odds.test.js` |
| `deck.test.js` | offline unit tests for four-color card identification — `node deck.test.js` |
| `cardbacks.test.js` | offline unit tests keeping the card-back style list, assets and picker in agreement — `node cardbacks.test.js` |
| `popup.html` / `popup.js` | settings UI, bet-button editor, session graph, card store export/import |
| `overlay.css` | styles for all injected UI |
| `riverbench.html` | dev harness: holds a river on a stand-in table, or lobs any catalog prop at a stand-in avatar (`?item=float`), with `?manual=1` for a hand-cranked clock |
| `seatbench.html` | dev harness: fires real `InteractionEvent`s at a fake seat, so the celebrations can be tested without a table — `__fire("dance")`, `__overlap()` |
| `launch-debug-chrome.sh` | starts a dedicated Chrome with remote debugging on :9222 (separate profile) for live DOM inspection |
| `tools/deck_hashes.py` | regenerates the four-color deck's `DECK_HASHES` table from the live site — run it if the recoloring stops working |
| `tools/drop-node.js` | strips named objects out of a model export before `tools/optimize-model.sh` (the life ring's rope loop is the case it exists for) |
| `tools/make_cardbacks.py` | draws `assets/backs/*.png`; `--preview` writes a magnified sheet to `assets-src/` (not shipped) |

After editing, reload the extension at `chrome://extensions` and refresh the gpokr tab. Content-script crashes don't appear in the page console — check **Errors** on the extension's card at `chrome://extensions`.
