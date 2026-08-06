# GPokr REST API Reference

Endpoint list derived from the server source; payload shapes, sizes, and auth
requirements below were verified live against gpokr.com on 2026-08-04 and are
marked where they differ from what the source implies.

## Auth & session

| Method | Path | ui2 | Description |
|---|---|---|---|
| POST | `/api/gpokr/auth/login` | ✅ | JWT login. Body `{email, password}` → `{accessToken, refreshToken, expiresIn, user, following}`. Also sets the `jwt_token` cookie and publishes `Arrive` to the user's table. 401 on bad credentials. |
| POST | `/api/gpokr/auth/refresh` | ✅ | Body `{refreshToken}` → new access token. ui2 calls it automatically before expiry and on any 401. |
| POST | `/api/gpokr/auth/logout` | — | Revokes the refresh token and expires the cookie. (ui2 currently signs out client-side by clearing tokens.) |

### Legacy session endpoints (pre-JWT, used by the old GWT client, not ui2)

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/gpokr/` | Legacy REST session bootstrap — returns a `StartSessionEvent` (user, table, tournaments, activePlayers, clientId). Superseded by the WebSocket connect. |
| POST | `/api/gpokr/me/signin` | Cookie-session sign-in, body `{email, password}`. |
| POST | `/api/gpokr/me/signup` | Create account, body `{name, email, password}`; returns per-field errors. |
| GET | `/api/gpokr/me/signout` | Sign out; notifies followers, expires cookies. |
| POST | `/api/gpokr/me/leave` | Leave the current table without signing out. |

## Lobby & tables

| Method | Path | ui2 | Description |
|---|---|---|---|
| GET | `/api/gpokr/tables` | ✅ | Lobby snapshot: `{tables, categories, tournies}`. Public. ui2 loads this for the table list and pull-to-refresh. |
| GET | `/api/gpokr/tables/{name}` | ✅ | Returns the full `TableImplData` for a table **and joins it** (leaves the previous table, publishes `Arrive`). Optional `?standUp=true` stands up from the old seat first. |
| GET | `/api/gpokr/me/tables` | (defined) | Tables the signed-in user owns / is a member of. |
| POST | `/api/gpokr/me/tables/{name}` | — | Update options of a user-owned table (body = map of option → value). |

## Seating (shared across games)

All GET, all act on the client's current table (from `IOGC-Client-ID`) and publish the corresponding table message; the state change comes back over the WebSocket.

| Method | Path | ui2 | Description |
|---|---|---|---|
| GET | `/api/gpokr/table/takeseat` | ✅ | Take a seat (optional `?table=<name>`). |
| GET | `/api/gpokr/table/standup` | ✅ | Leave the seat. |
| GET | `/api/gpokr/table/sitin` | ✅ | Return from sitting out to active play. |
| GET | `/api/gpokr/table/sitout` | (defined) | Sit out the next hand. |
| GET | `/api/gpokr/table/findseat` | (defined) | Server picks a suitable table by score and seats you; returns the `TableImplData`. |

## Poker game actions (gpokr-specific)

Handlers in `GPokrRestService.java`; each publishes a poker `TableMessage` for the table server.

| Method | Path | ui2 | Description |
|---|---|---|---|
| POST | `/api/gpokr/table/checkCall` | ✅ | Check or call. Empty body. |
| POST | `/api/gpokr/table/fold` | ✅ | Fold. Body = bare boolean `showCards` (`true` = fold and reveal hole cards). |
| POST | `/api/gpokr/table/betRaise` | ✅ | Bet or raise. Body = bare int amount. |
| POST | `/api/gpokr/user/refill` | — | Free chip refill when broke (gpokr attaches a `refillSeconds` countdown to sessions with score 0). Not yet wired in ui2. |

## Tournaments

| Method | Path | ui2 | Description |
|---|---|---|---|
| POST | `/api/gpokr/tournaments/{id}/join` | ✅ | Register for a tournament. Note: the boolean body is **ignored** — the table server treats it as a toggle. |
| GET | `/api/gpokr/tournaments/{id}/players` | ✅ | Full tournament leaderboard (`List<PlayerStatus>`); `null` if the tourney isn't running. ui2 fetches this once on joining a tourney table, then keeps it live from WS events (`TournyScoreChange` / `TournyResult` / `TournyPlayers`). ⚠️ Returns **204 No Content** when called without a session — even for a tourney that *is* running (verified against a live `state: 2` tourney). Needs the signed-in session / `IOGC-Client-ID`, so it's only usable from in-page code. |

## Chat, reactions & interactions

| Method | Path | ui2 | Description |
|---|---|---|---|
| POST | `/api/gpokr/table/chat` | ✅ | Send a chat message to the current table (body = JSON string). Incoming chat arrives over the WebSocket only. |
| POST | `/api/gpokr/table/react` | (new) | React to a received chat message with an emoji. Body `{messageId, reaction}`. Client helper: `IogcClient.sendReaction(messageId, reaction)`. Watchers may react (same audience rules as chat). No rate limit — parity with chat. |
| POST | `/api/gpokr/table/interact` | (new) | Fire a cosmetic seat-to-seat effect (chip throw, etc.). Body `{type, payload, toUserId}`. Client helper: `IogcClient.sendInteraction(type, payload?, toUserId?)`. **Never touches game state** — it is purely a broadcast for animation. See [Interactions & reactions](#interactions--reactions). |

## Profile & account

| Method | Path | ui2 | Description |
|---|---|---|---|
| POST | `/api/gpokr/me/name` | ✅ | Set player name (body = JSON string). Only allowed while the `NEW_NAME` access flag is set (fresh OAuth sign-ups); validates length/blocklist/uniqueness. |
| POST | `/api/gpokr/me/avatar` | ✅ | Upload avatar. JSON variant `{data: <base64 data-URL>, filename}` (used by ui2 native) or `multipart/form-data` field `avatar` (browser). Returns `{photoId, photoExt}`. 403 if `CANT_CHANGEPHOTO` or unverified. |
| POST | `/api/gpokr/me/settings` | ✅ | Persist the user's packed settings bitmask, body `{settings: "<int>"}`. |
| POST | `/api/gpokr/me/delete-account` | ✅ | GDPR delete. Body `{confirmation: "delete <username>"}`. Anonymizes the account, revokes all tokens. |
| GET | `/api/gpokr/me/profile` | — | Read profile fields (about, birthday, city, country, sex, tagline). |
| POST | `/api/gpokr/me/profile` | — | Write the same profile fields. |
| GET | `/api/gpokr/me/following` | — | Names the user follows. |
| GET | `/api/gpokr/me/followers` | — | Names following the user. |
| POST | `/api/gpokr/user/{name}/following` | — | Body bare boolean: `true` follow / `false` unfollow. Enforces favorites cap, emails the target, subscribes to their presence. |
| POST | `/api/gpokr/me/appStorePayment/{transactionId}/receipt` | — | Validate/record an in-app purchase receipt. |
| GET | `/profile/{userId}.json` | ✅ | **Not under `/api`** — extended profile stats JSON: `{today, monthName, monthStat, achievements[], careerTrophies[]}`. ui2 fetches this with a Bearer header, but **no auth is required** — it answers 200 for any user id, unauthenticated (verified 2026-08-04). See [Profile JSON shape](#profile-useridjson-shape). |

## Stats & replays

| Method | Path | ui2 | Description |
|---|---|---|---|
| GET | `/api/gpokr/games/stats` | — | Every finished game for a whole day, site-wide — not a highlights feed. `?date=YYYY-MM-DD` (default today) → `[{gameStatId, tableId, tableName?, finished, playerCount, players:[{name, scoreChange, rankChange, bust}]}]`. No auth. ⚠️ **Large**: a full day is 7,000–9,000 entries / **4–7 MB**, with no per-player or per-table filter — fetch on demand, never poll. `tableName` is absent (and `tableId: 0`) on tournament games. `bust: 1` marks a player who busted in that game. |
| GET | `/api/gpokr/games/recording/{gameStatId}` | — | Full replay of a finished game: start-state snapshot + event stream (~25 KB). 404 if missing. No auth check. **The id is the same one in the log's Replay link** (`gpokr.com/games/<ID>`), and a recording is queryable within seconds of the hand ending. See [Recording shape](#recording-shape). |

## Moderation / admin (moderator-gated)

| Method | Path | Description |
|---|---|---|
| GET | `/api/gpokr/user/{id}` | Load a player for moderation — full `UserInfo` incl. last IP and alt accounts on that IP. Null unless caller is a moderator. |
| GET | `/api/gpokr/find/{name}` | Same, looked up by username. |
| POST | `/api/gpokr/user/{id}` | Save moderation changes: toggle chat/play/post/avatar access flags, IP re-registration ban, wipe avatar; writes a `ModLog` row. |
| POST | `/api/gpokr/user/{id}/contribs` | Award a contribution to a user (non-admin mods rate-limited to 1/week). |



## Interactions & reactions

Two additions that ride the existing table WebSocket. Both are sent over REST and
received as events; neither has any effect on the hand.

### Interactions (cosmetic, seat-to-seat)

`POST /api/gpokr/table/interact` — `{type, payload, toUserId}`

| Field | Limit | Notes |
|---|---|---|
| `type` | string, ≤ 32 chars | e.g. `"chip_throw"`. |
| `payload` | opaque JSON string, ≤ 1024 chars | Yours to define — **the server never parses it**. |
| `toUserId` | user id, or `0` | The target; `0` means no specific target. |

Received by implementing `onEventInteraction?(event: InteractionEvent)` on the
listener (`EventListener.ts`); the dispatcher is already registered. Fields:
`type`, `payload`, `fromUserId`, `toUserId`.

- `fromUserId` is **set server-side from the session** — the client never sends it.
- The handler may return a `Promise`, and the event queue awaits it exactly like a
  scene. An animation can therefore block subsequent events on purpose.
- The event broadcasts to **everyone at the table** regardless of `toUserId`; the
  target only tells receiving clients where to aim the animation.

Server rules — violations are **silently dropped**, with no error to the caller:

- Sender must be seated, and `toUserId` (when non-zero) must be seated too.
  Watchers are excluded on both ends.
- Per-user cooldown, 2 s by default (`interactionCooldownMs` property).
- Sender must pass `canChat` — muted users can't interact either.

### Chat message ids & reactions

Every `ChatEvent` now carries a server-assigned `messageId`: a per-table sequence,
unique for the table session. **`0` means a pre-upgrade server — treat as
not-reactable.** The TS `ChatEvent` interface now has `id` (sender's userId),
`messageId`, and `targetMessageId`.

A reaction arrives back through the normal `onEventChat` path as a `ChatEvent` with:

| Field | Value |
|---|---|
| `type` | `5` (`REACTION`) |
| `message` | the emoji |
| `targetMessageId` | the message being reacted to |
| `id` / `name` | who reacted |

`reaction` on the way out is the emoji string, ≤ 32 chars — enough for ZWJ sequences.

Client-side work still outstanding:

- `IogcClient.onEventChat` doesn't render `type = 5` yet; it falls through
  silently. Displaying reactions requires chat messages held as **objects keyed by
  `messageId`** rather than pre-rendered HTML strings, so badges can attach.
- The local `ChatType` map has **`SYSTEM`/`NEW` swapped** versus the server
  (server: `SYSTEM = 3`, `NEW = 4`). Worth fixing in the same pass.
- There is no chat history, so a client can only react to messages it actually
  received during this session.

## Recording shape

`GET /api/gpokr/games/recording/{gameStatId}` → `{gameId, startDate, data, events[], eventTimes[]}`.

- `data.gameInfo` is the state at the **start** of the hand: `smallBlind`/`bigBlind`, `dealer`, `pot`, and `playerInfo[]` indexed **by seat** (9 slots), each with `chipsAtStart` and a full `user` object (`name`, `id`, `rank`, `score`, `level`, `careerScore`, `teamId`, `photoId`). This is the seat → name map for the events below.
- `data.tableInfo` / `data.categoryInfo` — same shapes the lobby returns (`categoryInfo.ante`, blind tier).
- `events[]` replay the hand forward from that snapshot; `eventTimes[]` are the matching timestamps. Every event carries `typeName` and `publisher` (the table id), and references players by **seat index**, not name.

| `typeName` | Payload | Log line it corresponds to |
|---|---|---|
| `StartHandEvent` | `dealer`, `smallblind`, `bigblind`, `chips[]`, `ranks[]`, `forceBlinds[]`, `gameId` | "Starting Hand" (blinds are never logged) |
| `CheckCallEvent` | `seat` | "NAME checks" / "NAME calls" |
| `BetRaiseEvent` | `seat`, `amount` | "NAME bets $N" / "NAME raises $N" |
| `FoldEvent` | `seat` | "NAME folds" |
| `FlopEvent` | `card1`, `card2`, `card3` as `{suit, rank}` | the board |
| `TurnEvent` / `RiverEvent` | `card1` | the board |
| `ShowCardsEvent` | `seat`, `card1`, `card2`, `rank` (hand strength) | "NAME shows [..] for &lt;hand&gt;" |
| `TakesPotEvent` | `type` (**0 = main, 1 = side**), `seat`, `amount`, `chips` (stack after) | "NAME wins main\|side pot $N" |
| `TournyResultEvent` | `player: {id, name, rank}` — `rank` **is the finishing place** | "NAME finishes the tournament Nth" |
| `TournyScoreChange` | `player: {id, name, score, rank, tableName}` | — |
| `StandUpEvent` / `SitInEvent` / `SitOutEvent` | `seat` | "NAME stands up" etc. |
| `TablePlayersEvent` | `tableScore[]`, `teamRanks[]`, `bountyPot`, `leaderboard[]` | — |
| `ChatEvent` | table chat | the chat pane |
| `AvailableGameEvent` / `TeamsLeaderboardUpdateEvent` | other tables' seats / team standings | — |

Two things this settles:

- **Card exposure is faithful to the table.** Hole cards appear *only* in `ShowCardsEvent` — i.e. only for players who actually showed. `playerInfo[].pocketCount` is a count (0 or 2), never the cards. Recordings also only exist once a hand is over, so there is no live-play information leak.
- **A recording is inherently single-table.** `TournyResultEvent` inside our own hand's recording can only name someone at our table, unlike the log's "finishes the tournament" lines, which are broadcast tournament-wide.

## `/profile/{userId}.json` shape

```json
{ "today":      { "scoreChange": 9950, "rankChange": 40, "safetyNet": 0, "played": 38, "busts": 7, "ppg": 252 },
  "monthName":  "August 2026",
  "monthStat":  { "score": 22507, "rank": 146, "played": 146, "safetyNet": 0, "busts": 13, "ppg": 75, "bonus": 1306 },
  "achievements":  [ { "bonusType": "TABLE_BOUNTY", "amount": 676, "rank": 2, "sourceName": "Bodega",
                       "imageUrl": "/images/bounty/Bodega_676_2.png?ref=User45319498" } ],
  "careerTrophies":[ { "monthName": "October 2024", "rank": 1,
                       "imageUrl": "/images/trophy/GPokr/October%202024_1.png" } ] }
```

- **`today` can be `null`** (a user who hasn't played today) — as can any nested block; guard every read. Across a 20-profile sample the five top-level keys were always present, but `today` was `null` twice.
- `achievements[].bonusType` seen: `TABLE_BOUNTY`, `TOURNAMENT`, `TEAM_VIP` (the last also carries `sourcePhotoId`/`sourcePhotoExt`). `imageUrl` is server-rendered and already contains the amount/rank in its filename.
- `imageUrl`s are site-relative paths to **512×512 PNGs, 45–120 KB each**. Scale them down and cap how many you render — career trophy counts of 70+ are common.
- Counts are unbounded: sampled players had 0–30 achievements and 0–78 career trophies.

## Getting a userId

Several endpoints are keyed by numeric user id rather than name. Sources, in order of convenience:

- The seat panel's profile link (`a[href*="/profile/"]`) — what the extension already reads for seat names.
- `photoId` in any `user` object ends with `-<userId>` (e.g. `cf12136847fd2a7abf9d42d550643bc6-45319498`), so avatar URLs carry it too.
- `user.id` throughout a recording's `playerInfo[]`, and `player.id` on `TournyResultEvent` / `TournyScoreChange`.

## Gotchas worth knowing

- `GET /tables/{name}` has the side effect of **joining** the table, not just reading it.
- `POST /tournaments/{id}/join` ignores its body — it's a registration toggle.
- `GET /api/gpokr/tournaments/{id}/players` answers `204` with no session (see above), so it can't be probed from outside the page.
- `/api/gpokr/games/stats` is a whole day in one 4–7 MB response — treat it as an offline/on-demand query, not a live source.
- Recordings include `ChatEvent`s, so anything the extension posts to table chat (e.g. encoded shared hands) is stored in a public, permanently fetchable replay.
- Unauthenticated requests need a browser-ish `User-Agent`: a bare `urllib` call gets **403**, the same URL via `curl` gets 200.
