# Service alerts

The bot's alerts account posts about CTA service problems from three sources:

1. **Republishing CTA's official alerts** — pulled from CTA's public alerts feed, filtered for significance and tracked routes, with a threaded "cleared" reply when CTA marks them resolved.
2. **Train pulse — the bot's own rail detection** — watches live train positions and infers a service suspension when a long stretch of a line goes "cold" (no trains in 15+ min) before CTA has issued an alert about it.
3. **Bus pulse — the bot's own bus detection** — watches live bus positions and infers a route blackout when a route that should be running has zero distinct vehicles observed for several consecutive ticks while other routes report normally.

All three go to the same dedicated alerts account, so followers see a single feed combining "what CTA says" and "what the bot can see for itself."

## The plain-English version

### Republishing CTA alerts

Every few minutes:

1. Fetch all currently-active alerts from CTA.
2. Drop alerts that don't touch a route the bot watches.
3. Drop alerts that are "Major" by CTA's flag but actually trivial (single elevator out, painting an entrance, etc.).
4. For each new alert, post it.
5. For each alert we'd previously posted that's no longer in the feed for several consecutive checks, post a threaded reply saying it's been cleared.

For trains, when the alert text mentions "between [station A] and [station B]", we try to also draw a map dimming that segment of the line.

### Train pulse — bot-detected rail disruptions

In parallel, every few minutes:

1. Pull every train position recorded in the last ~20 minutes for each line.
2. Walk along the line in 0.25-mile bins and ask: "when's the last time *any* train showed up in this bin?"
3. If a contiguous cold run is long enough (≥ 2 mi as a sparse-fallback), or covers ≥ 2 stations, or covers ≥ 1 station with enough scheduled trains expected to have passed through, that's a candidate. Trains must still be active elsewhere on the line.
4. Require the same stretch to recur on two consecutive checks before posting (filters single-tick noise).
5. Post a map dimming the affected segment with a footer making clear this was inferred from live positions, not announced by CTA. If there's an open CTA alert for the same line, the pulse post is threaded as a reply to it.
6. When the dead stretch warms back up for several consecutive checks, post a `🚇✅ trains running through X ↔ Y again` reply under the original pulse — independently of whether CTA ever issued an alert.

A separate path catches the degenerate case: if a line has zero observations at all while other lines do, pulse synthesizes a full-line candidate and posts a line-wide blackout alert. That's how a Yellow shuttle-bus replacement (which empties the entire line) gets caught.

This is how the bot can flag a Red Line outage minutes before CTA's own alert appears — the empty stretch is right there in the live feed. The same machinery now handles single-station single-tracking (e.g. Belmont) and complete line shutdowns alongside the long-stretch case.

### Bus pulse — bot-detected route blackouts

The bus equivalent is intentionally simpler. Buses don't have a fixed branch geometry that maps cleanly to "between X and Y" the way rail does, so bus pulse operates at the *route* level:

1. Pull every bus observation recorded in the last 25–60 min (window scaled by the route's GTFS headway — 3× the longest direction, clamped) for each tracked route.
2. For each route, count distinct vehicle IDs in the window.
3. If the count is **zero** *and* GTFS says the route should have ≥ 2 active trips this hour *and* at least 5 other watchlist routes are reporting normally, that route is a blackout candidate.
4. Require the same blackout to recur on two consecutive checks before posting (5–10 min of confirmed silence at the `*/5` cadence).
5. Post text-only — `🚌⚠️ #<route> <name> service appears suspended` — with a footer that calls out the inferred-from-live-positions provenance. If a CTA bus alert on the route is already open, thread under it.
6. When buses reappear for three consecutive clean ticks, post `🚌✅ #<route> <name> buses observed again` as a reply under the original pulse.

The strict-zero gate is the key difference from train pulse. Even one bus on the air — including a stuck yard bus broadcasting position from the lot — suppresses pulse. Gaps with ≥ 2 buses still active are `bin/bus/gapPost.js`'s channel, not pulse's. False positives on bus pulse are higher-cost than false negatives, so the bar is deliberately conservative.

### Threading: keeping a single conversation per disruption

Pulse posts and CTA-alert posts can arrive in either order on the same disruption. The threading rules are designed so all related posts share the same thread root:

- **Pulse first, CTA second** — pulse posts top-level. When the CTA alert lands, `bin/train/alerts.js` looks up the most recent pulse for that line and threads under it. Both clears (bot-side `✅ trains running again` and CTA-side `✅ CTA has cleared:`) reply within that thread, with `resolveReplyRef` inheriting the pulse as root.
- **CTA first, pulse second** — CTA alert posts top-level. Pulse looks up the open CTA alert and threads under it (`findOpenAlertReplyRef` in `bin/train/pulse.js`). The bot-side clear inherits the CTA alert as root via the same `resolveReplyRef` helper.
- **Pulse only (CTA never publishes)** — pulse posts top-level, bot-side clear replies under it, no CTA participation.
- **CTA only (pulse never fires)** — single CTA alert + threaded `✅ CTA has cleared:` reply, same as before pulse existed.

The bot-side clear text varies based on whether a CTA alert has appeared in the thread:
- No CTA alert seen: *"… (CTA hasn't issued an alert for this.)"*
- CTA alert exists but unresolved: *"… (CTA hasn't cleared their alert yet.)"*

`hasUnresolvedCtaAlert` (in `src/shared/history.js`) drives the variant by checking whether any open alert touches the route, rather than the previous time-windowed lookup. `hasObservedClearForPulse` provides idempotency so a process restart between posting the clear reply and finalizing pulse state doesn't double-post.

## The technical version — CTA republishing

### Step 1 — fetch and normalize (`src/shared/ctaAlerts.js`)

`fetchAlerts({ activeOnly: true })` calls the CTA endpoint and `parseAlerts` walks the XML/JSON. Two quirks of the feed:

- `CTAAlerts.Alert` is missing when there are zero alerts, an object when there's exactly one, and an array otherwise. The parser handles all three.
- Date strings are wall-clock times in `America/Chicago`. We try both DST and standard offsets and pick the one that round-trips back to the same wall time.

Each alert is normalized into:

```
{ id, headline, shortDescription, fullDescription,
  major, severityScore, severityColor,
  eventStart, eventEnd,
  busRoutes: [...], trainLines: [...], url }
```

`busRoutes` are CTA route IDs (e.g. `"66"`); `trainLines` are mapped from CTA's rail `ServiceId` codes (`Red`, `Brn`, `Org`, …) to the bot's lowercase line keys (`red`, `brn`, `org`, …) via `RAIL_ROUTE_TO_LINE`.

### Step 2 — relevance and significance gates

Two filters in series.

**Significance** (`isSignificantAlert`): CTA's `MajorAlert=1` flag is unreliable in both directions — it tags single-stop closures and elevator outages as major, but also leaves real bus-substitution events flagged minor. We no longer require `MajorAlert=1`. The gate is:

1. None of the `MINOR_PATTERNS` match (`reroute`, `detour`, `elevator`, `escalator`, `entrance`, `bus stop`, `paint`, `track work`, `weekend service change`, etc.), AND
2. Either `MAJOR_PATTERNS` match (`no train|rail|bus|service`, `not running`, `suspended`, `shuttle bus`, `major delays`, `single-track`, `between X and Y`, etc.) OR `severityScore ≥ MIN_SEVERITY = 3`.

The minor-wins ordering matters: an alert headlined "No trains stopping at Belmont (elevator construction)" looks major by keyword but should drop on the elevator gate. The bot errs on silence — a missed real outage is recoverable; spamming followers with stop closures is not. The canonical case the new gate fixes is a Yellow Line bus substitution that arrived as `MajorAlert=0, SeverityScore=25` — clearly significant, but the old `major`-required gate dropped it.

**Relevance** (per-bin): `bin/bus/alerts.js` requires at least one of the alert's bus routes to be in the union of `bunching`, `gaps`, `speedmap`, and `ghosts` route lists. Train alerts are kept if they touch any tracked line (all 8). Most bus-alert volume is for routes followers don't care about; this filter throws away ~80% of them.

### Step 3 — post new alerts

`buildAlertPostText` (`src/shared/alertPost.js`) produces:

```
🚌⚠ <headline>

<shortDescription, truncated to ~200 chars on a sentence boundary>

Per CTA. Check transitchicago.com for updates.
```

If the rendered text exceeds Bluesky's 300-grapheme post limit, it falls back to headline + "Per CTA. transitchicago.com".

For trains, the bin tries to extract `between X and Y` station names from the alert text and resolve them to a real polyline segment. `extractBetweenStations` is case-insensitive and prefers the phrase anchored to the disruption verb ("suspended between X and Y") over any earlier `between …` mention in the headline. If both endpoints resolve, the post includes a map dimming that segment of the line — see `src/shared/disruption.js` for the post text and `bin/train/disruption.js` for the rendering. The manual disruption poster (`bin/train/disruption.js`) logs in via `loginAlerts` so manually-posted disruptions land on the alerts account, and calls `recordDisruption` so subsequent flows can thread under it.

Posting goes to a dedicated alerts account (separate from the main bus and train accounts), keeping the main feeds focused on visualizations rather than alert republishing.

### Step 4 — track resolutions

Each posted alert's `(alert_id, post_uri, kind, headline, routes)` row is written to `history.sqlite`. Every subsequent tick:

1. Pull the active-alerts list again.
2. For each unresolved alert in our DB:
   - If it's in the active list, reset its "missing tick" counter.
   - If it's missing, increment the counter.
3. Once the counter hits `ALERT_CLEAR_TICKS` consecutive misses, post a threaded `✅ CTA has cleared: <headline>` reply to the original post.

The multi-tick threshold protects against feed flicker — the CTA endpoint occasionally returns a brief empty response. There's also a guard at the top of the resolution sweep: if the *whole* fetch returned zero alerts (likely a feed glitch, not "everything's fixed at once"), the sweep is skipped entirely.

## The technical version — pulse detection

### Step 1 — observe (`src/shared/observations.js`)

Every train-related cron job (`bunching`, `gaps`, `snapshot`, `pulse` itself) writes every observed `(ts, line, rn, trDr, lat, lon)` to the SQLite observations table. The pulse detector reads back the last 20 minutes of those rows for each line — `getRecentTrainPositions(sinceTs)`.

### Step 2 — bin per branch (`src/train/pulse.js#detectDeadSegments`)

Each line has one or more *branches* (Green's Ashland and Cottage Grove, Blue's O'Hare and Forest Park, etc.) — sourced from `trainLines.json` shapes. For each branch:

1. Build a polyline and divide it into 0.25-mile bins. Round-trip "loop" branches (Brown, Pink, Orange, Purple) are split by `processSegment` / `buildLineBranches` into outbound + inbound branches that share geometry but carry a `trDrFilter` matching the Train Tracker direction code (`LOOP_LINE_TRDR_OUTBOUND`: brn=1 Kimball, org=5 Midway, pink=5 54th/Cermak, p=1 Linden). Yellow is intentionally omitted — Train Tracker reports a single trDr for both physical directions, so it stays unsplit. Without per-direction binning, a one-way outage on a loop line was masked by trains running the opposite direction in the same bins.
2. For every observation in the lookback window, perpendicular-project its lat/lon onto the polyline using equirectangular projection at the branch's latitude. Reject projections > 1,500 ft off-line (off-branch trains) or with mismatched `trDrFilter`.
3. For each bin, record the most recent timestamp any train was there.
4. A bin is **cold** if `lastSeenTs < now - max(15 min, 2 × headway)`.
5. The longest contiguous run of cold bins, *excluding terminal zones at both ends*, becomes the candidate.

Pulse `direction` keys derive from a stable hash of geometry, not the branch's index in `trainLines.json`, so reordering shapes in the JSON doesn't break pulse_state continuity across deploys.

### Step 3 — sanity gates

The distance gate is composite. The candidate is admitted if **any** of the following pass:

- `passLong` — run length ≥ `MIN_RUN_FT` (2 mi). Sparse-fallback for outer branches with few stations.
- `passMulti` — ≥ 2 named stations fully inside the cold run.
- `passSolo` — ≥ 1 named station inside, *and* `expectedTrains = floor(coldMin / headwayMin) ≥ SOLO_EXPECTED_TRAINS = 3`, *and* `coldMs ≥ max(15 min, 3 × headway)`.

The flat 2-mi minimum is gone. `passSolo`'s time-side `expectedTrains ≥ 3` factor is what blocks the obvious false-positive — a single train held at a station — without rejecting Belmont-style single-tracking, where one to two stations go cold for long enough that several trains *should* have passed through.

Other gates still apply:

| Gate | Threshold | Rationale |
|---|---|---|
| `MIN_COVERAGE_FRAC` | ≥ 50% of bins seen ≥ once | If half the line never had a single observation, our data is too sparse — silence rather than guess. |
| `MIN_SPAN_FRAC` | observations span ≥ 50% of lookback | Prevents firing on a 30-second blip of data. |
| Terminal zone exclusion | dead run can't touch first/last `terminalZoneFt` of the branch | Loop tail-tracks and short-turn pockets at terminals legitimately go quiet. |
| Distinct stations | `fromStation ≠ toStation` | A run that resolves to a single named station is a render artifact. |

`fromStation`/`toStation` are taken from `stationsInRun.filter(s => trackDist >= runLoFt && trackDist <= runHiFt)` — strictly inside the cold run. The previous `nearestStationAtOrBefore`/`After` reach-out could pick named endpoints that lay past the terminal-zone clip, mislabeling the dim segment.

A separate full-line zero-obs branch handles complete blackouts: when a line has zero observations in the lookback while other lines have data and `expectedTrainActiveTrips > 0`, bin synthesizes a full-branch candidate marked `synthetic: true`. The renderer uses synthetic-specific evidence text: *"📡 No trains observed on this line in the last 20 min — service appears suspended line-wide."*

The bin-level gates (`bin/train/pulse.js`):

- `MIN_HOUR = 5` — skip pulse before 5 AM CT, when owl service produces irregular gaps. `chicagoHourNow` uses `hourCycle: 'h23'` so midnight CT correctly returns 0 (not 24, which previously bypassed the MIN_HOUR gate).
- `MIN_DISTINCT_TS = 3` — need at least 3 distinct snapshot timestamps in the lookback before the line can be evaluated. Stops a freshly bootstrapped observations table from looking like a system-wide outage.

### Step 4 — debounce + post

`pulse_state` (in `history.sqlite`) tracks the candidate per `(line, branch)` and now also carries `active_post_uri` and `active_post_ts` columns identifying the live pulse post. Each tick:

- If the new candidate's `[runLoFt, runHiFt]` overlaps the prior candidate's range by ≥ 50%, increment `consecutive_ticks`. Otherwise reset to 1.
- Post only when `consecutive_ticks ≥ MIN_CONSECUTIVE_TICKS = 2`.
- After a successful post, the row is **not** cleared — `active_post_uri` and `active_post_ts` are pinned. While `active_post_uri` is set, subsequent matching candidates skip the post but continue to refresh state. This is what wires the eventual bot-side clear directly to the right post.
- A cooldown prevents the same dead segment from re-posting if it briefly clears and re-flags. The cooldown key is `train_pulse_<line>_<direction>_<from-slug>__<to-slug>` derived from the bracketing stations (`stableSegmentTag(candidate)`), so single-bin drift between ticks — which used to shift `runLoFt`/`runHiFt` by a few hundred feet and defeat a foot-range cooldown — no longer breaks it.
- If the pulse candidate disappears, the state row sits for `CLEAR_TICKS_TO_RESET = 3` clean ticks before being deleted, so a single noisy tick where one train sneaks into the dead zone doesn't cancel the chain.

### Step 5 — render and thread

The detector emits a `Disruption` object: `{ line, suspendedSegment: { from, to }, alternative, source: 'observed', evidence: { runLengthMi, minutesSinceLastTrain, trainsOutsideRun, … } }`. `src/shared/disruption.js#buildPostText` formats it as:

```
⚠ <Line> Line service suspended

Between <from> and <to>.

📡 No trains seen on this 4.2-mi stretch in the last 18 min (12 trains active elsewhere on the line).

Inferred from live train positions; CTA hasn't issued an alert for this yet.
```

If there's an open CTA alert post for the same line in our DB, the pulse post is threaded as a reply to it (`findOpenAlertReplyRef`, which scores open-alert candidates by station-name overlap with the pulse's bracketing stations). The reverse case — pulse first, CTA alert later — is handled symmetrically in `bin/train/alerts.js#postNewAlert` via `getRecentPulsePostsAll` (24h window, broadened from 3h) ranked by station-name overlap with the alert text. Either ordering converges to a single thread. `bin/bus/alerts.js` uses the shared `resolveReplyRef` helper rather than its previous hand-rolled `parseAtUri`.

The same `Disruption` shape and renderer are reused by `bin/train/disruption.js`, which lets an operator manually post a disruption from CLI args (typically copying CTA alert info verbatim before the auto-republisher catches up). The auto-detector and the manual command share everything downstream of the `Disruption` object.

### Step 6 — bot-side clear

When `pulse_state` rolls off after `CLEAR_TICKS_TO_RESET = 3` clean ticks, `bin/train/pulse.js#postClearReply` posts a `✅ <Line> trains running through X ↔ Y again` reply directly under `active_post_uri` (the pinned URI on the pulse_state row) and releases the per-segment cooldown so a fresh outage on the same stretch can post immediately. The previous 24h time-window lookup to find the pulse post is gone — pinning is exact, so a clear can't accidentally reply under a different recent pulse on the same line. Two safeguards:

- **Idempotency** — `hasObservedClearForPulse` checks `disruption_events` for an existing `observed-clear` row tied to the same `active_post_uri` before posting; if one exists, the reply is skipped. This prevents a duplicate clear if the process is killed between posting and finalizing state.
- **Wording variant** — `hasUnresolvedCtaAlert` toggles the parenthetical: *"(CTA hasn't issued an alert for this.)"* when no open CTA alert touches the route, *"(CTA hasn't cleared their alert yet.)"* when one exists. This replaced the previous time-windowed `ctaAlertPostedSince` check, which missed older alerts that were still open. The bot-side clear fires in both cases — CTA's eventual `✅ CTA has cleared:` is an independent signal and both belong in the thread.

### Alert resolution flicker

`recordAlertSeen` (in `src/shared/history.js`) is the entry point for every observed alert tick. It now reverses premature resolutions in two cases: (a) the row was marked resolved but a real `postUri` arrived afterward, and (b) `last_seen_ts` is older than `ALERT_FLICKER_RESET_MS = 30 min` and the row was resolved. In either case `resolved_ts`, `resolved_reply_uri`, and `clear_ticks` are nulled so tracking re-engages — the next genuine CTA-side clear will then post normally instead of being silently swallowed.

## Why this approach

Riders already have transitchicago.com and the CTA app. The value of this account on Bluesky is in two complementary signals:

- **Trustworthy republishing**: thread-attached "cleared" replies, filtering for significance and tracked routes, and visual segment maps for "between X and Y" rail alerts make the official feed easier to consume.
- **Earlier detection**: the pulse detector regularly flags suspensions before CTA issues an alert. The composite distance gate covers the long-stretch case, single-station and 1–2 station outages (Belmont single-tracking and similar), and complete line blackouts (Yellow shuttle replacement) under the same machinery. The footer is explicit ("Inferred from live train positions; CTA hasn't issued an alert for this yet") so readers know what kind of signal it is — and threading the pulse post under the CTA alert when one eventually appears keeps everything in one place.

The conservative filtering (minor-wins, severity floor, multi-tick clear, debounce, coverage/span gates, cold-start guards) is deliberate across both halves. False alarms here are higher-cost than for the visualization posts: a post on this account reads as transit info, and over-posting trivial alerts or a phantom suspension trains followers to ignore the feed.

The bot-side clear (step 6 above) is the one place we deliberately accept a small false-positive risk: a single tick where the dead-zone briefly warms back up could fire a premature `✅`. The 3-tick `CLEAR_TICKS_TO_RESET` debounce makes that unlikely, and on balance leaving pulse posts hanging without resolution was a worse failure mode — followers couldn't tell if a flagged disruption was still live.

## Files

- `src/shared/ctaAlerts.js` — fetching, normalization, significance gates. `cleanText` decodes both named and numeric HTML entities; `parseCtaDate` accepts ISO 8601 (the actual feed format, not just the legacy wall-clock form).
- `src/shared/alertPost.js` — alert and resolution post text.
- `src/shared/disruption.js` — segment-dim disruption post text, alt text, and `buildClearPostText` (shared by republished alerts and pulse).
- `src/shared/bluesky.js` — `resolveReplyRef` for root-aware threading (used by both pulse and alerts; bus alerts now go through it too).
- `src/shared/history.js` — `recordAlertSeen` (with flicker reversal), `listUnresolvedAlerts`, `incrementAlertClearTicks`, `pulse_state` rows (now with `active_post_uri` / `active_post_ts`), `recordDisruption`, `getRecentPulsePostsAll` (24h), `hasObservedClearForPulse`, `hasUnresolvedCtaAlert`, `rolloffOld` (now also cleans up the cooldowns table). `ctaAlertPostedSince`, `hasObservedClearSince`, and `parseAtUri` were removed in favor of the new helpers.
- `src/shared/observations.js` — train position storage + `getRecentTrainPositions` for pulse.
- `src/train/pulse.js` — dead-segment detector (pure, no DB). Composite distance gate, full-line synthetic candidates, `stableSegmentTag`, `snapToLineWithPerp` (equirectangular).
- `bin/bus/alerts.js`, `bin/train/alerts.js` — CTA-republishing cron entry points.
- `bin/train/pulse.js` — pulse detector cron entry point (debounce, cooldown, threading, posting).
- `bin/train/disruption.js` — manual disruption poster; logs in via `loginAlerts` so output goes to the alerts account, calls `recordDisruption`, shares the renderer with pulse.
- `bin/audit-alerts.js` — health audit cron that surfaces stuck pulse_state rows, unresolved alerts past their natural lifetime, and other invariant violations across the alert pipeline.
