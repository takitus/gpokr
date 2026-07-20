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

### Card-image learning
The site renders cards as inline images. The extension learns which image is which card from your own hands, the board, and showdowns — used to render shared hands as real card images (text fallback until learned). The popup shows progress (n / 52) and supports **Copy JSON** / **Import** to share a learned set between machines.

## Settings & storage

All state lives in `chrome.storage.local` and syncs live between the popup and open tables (no refresh needed):

| Key | Contents |
|---|---|
| `gpe_settings` | toggles + bet-button config |
| `gpe_player_stats` | per-player VPIP/PFR/aggression/showdown counters |
| `gpe_player_notes` | per-player note text |
| `gpe_session` | stack history for the session graph |
| `gpe_card_images_v2` | learned card images |

Nothing is sent anywhere — no servers, no analytics, no permissions beyond `storage`.

## Development

| File | Role |
|---|---|
| `content.js` | all table logic: log parsing, overlays, HUD, badges, bet columns |
| `odds.js` | pure poker math (no DOM): evaluator, Monte Carlo equity, draws, labels — exposed as `window.GPE_ODDS`, also a CommonJS module |
| `odds.test.js` | offline unit tests — `node odds.test.js` |
| `popup.html` / `popup.js` | settings UI, bet-button editor, session graph, card store export/import |
| `overlay.css` | styles for all injected UI |
| `launch-debug-chrome.sh` | starts a dedicated Chrome with remote debugging on :9222 (separate profile) for live DOM inspection |

After editing, reload the extension at `chrome://extensions` and refresh the gpokr tab. Content-script crashes don't appear in the page console — check **Errors** on the extension's card at `chrome://extensions`.
