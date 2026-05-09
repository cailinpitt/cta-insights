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
4. Suppress candidates during the first 30 minutes of an hour whose prior hour had no scheduled service. `activeByHour` averages over the hour, so a peak-only route resuming after a midday gap (e.g. X49 at 14:08) shows expectedActive ≥ 2 even though the first scheduled trip hasn't departed yet — without this guard, every post-gap restart would fire a false-positive blackout. The ghost detector handles the analogous problem with an observation-side tail-median check; pulse needs a schedule-side guard because strict-zero leaves no observations to compare against. Belt-and-suspenders: also suppress when the route has had **zero observations in the past 6 hours** (`getActiveBusRoutesSince`). A route with no obs all morning is service-not-yet-started, not a blackout — catches the FP class where the first bus pulls out 5–10 min after scheduled service start.
5. Require the same blackout to recur on two consecutive checks before posting (5–10 min of confirmed silence at the `*/5` cadence).
6. Post text-only — `🚌⚠️ #<route> <name> service appears suspended` — with a footer that calls out the inferred-from-live-positions provenance. If a CTA bus alert on the route is already open, thread under it.
7. When buses reappear for three consecutive clean ticks, post `🚌✅ #<route> <name> buses observed again` as a reply under the original pulse.

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

**Significance** (`isSignificantAlert`): CTA's `MajorAlert=1` flag is unreliable in both directions — it tags single-stop closures and elevator outages as major, but also leaves real bus-substitution events flagged minor. We no longer require `MajorAlert=1`. The gate runs in this order:

1. **Reroute admit overrides** — fires *only* when summary matches `reroute|detour`. Either path admits:
   - **Multi-route**: ≥ `MULTI_ROUTE_THRESHOLD` (3) impacted routes (bus + train, summed). Structural events: CPD funeral, parade, marathon, large road closures.
   - **High severity**: `severityScore ≥ HIGH_SEVERITY_THRESHOLD` (50). CTA's elevated score for acute incidents — police activity, crash, fire, hazmat. (See "CTA SeverityScore behavior" below for why 50.)
2. **MINOR_PATTERNS** veto — if the headline+short summary matches any of `reroute`, `detour`, `elevator`, `escalator`, `entrance`, `bus stop`, `paint`, `track work`, `weekend service change`, etc., reject.
3. **MAJOR_PATTERNS** admit — if the full text (headline + short + full description) matches `no train|rail|bus|service`, `not running`, `suspended`, `shuttle bus`, `major delays`, `single-track`, `between X and Y`, etc., admit.
4. **Severity fallback** — `MajorAlert=1` AND `severityScore ≥ MIN_SEVERITY` (3) admits.
5. Otherwise reject.

The minor-wins ordering on steps 2/3 matters: an alert headlined "No trains stopping at Belmont (elevator construction)" looks major by keyword but should drop on the elevator gate. The bot errs on silence — a missed real outage is recoverable; spamming followers with stop closures is not.

Step 1 was added 2026-05-08 after a CPD funeral generated multi-route reroute alerts that all got vetoed at step 2 (the underlying disruption fired pulse, ghost, and bunching detectors but the official CTA alerts explaining "why" never made it out). The Yellow Line bus substitution this gate originally fixed (arrived as `MajorAlert=0, SeverityScore=25`) is still caught by step 3 via the `shuttle bus` pattern.

#### CTA SeverityScore behavior (calibration data, 2026-05-08)

The thresholds in step 1 were calibrated against a snapshot of the live feed. Histogram of all 44 active alerts at the time:

| Severity | Count | Typical content |
|---|---|---|
| 5–12 | 9 | Service-info posts (e.g. "Cubs night-game extra service") |
| 19 | 11 | "Bus Stop Change" alerts |
| 37 | 23 | The vast majority of reroutes — CTA's de facto default for any temporary reroute |
| 55 | 1 | The single non-reroute outlier in the snapshot — `#84 Peterson police activity` |

Two takeaways that inform the thresholds:

- **Severity alone is unreliable.** Local block-party detours and 12-route processions both score 37. There's no severity-only threshold that separates them.
- **Severity ≥ 50 is rare and meaningful.** When CTA does score above their default, it's because something acute is happening (police activity, fire, etc.). The 50 threshold catches that signal while staying below the observed 55.

If the feed's severity defaults shift in the future (CTA changes scoring), revisit these thresholds. The constants live at the top of `src/shared/ctaAlerts.js`:

```js
const MULTI_ROUTE_THRESHOLD = 3;
const HIGH_SEVERITY_THRESHOLD = 50;
```

To recalibrate: pull `lapi.transitchicago.com/api/1.0/alerts.aspx?outputType=JSON&activeonly=true`, histogram `SeverityScore`, and pick a threshold above the de facto reroute default that's still below outliers you'd want to admit.

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

The bin also queries `getLineCorridorBbox(line, now - 6h)` — the bounding box of all observations for the line in the past 6 hours. This becomes the *active service corridor* fed into the detector and into the synthetic full-line path. It catches lines whose published polyline includes track that isn't actually being used right now (e.g. weekend Purple Express runs Linden ↔ Howard only, but `trainLines.json` has a single Linden → Loop polyline). Without the corridor clip, every bin south of Howard reads as cold and the synthesized candidate names "Linden → Merchandise Mart" instead of "Linden → Howard."

For Purple specifically, the bbox query also passes `excludeDestinations: ['Loop']` whenever `purpleExpressLikelyActive(now)` is false — i.e. weekends and the midday/late-evening windows on weekdays. CTA's Purple Express only runs ~5–10 AM and ~2–8 PM weekdays, but Loop-bound deadhead trips and end-of-rush stragglers stay on the wire long enough to extend a 6h (or even 90-min) corridor bbox south through the Loop trunk. The destination filter is what keeps midday Sedgwick→Quincy from looking like a cold outage when nothing is actually scheduled there. NULL destinations are kept (unknown shouldn't shrink the corridor); the gate is Purple-only because no other line has a rush-only segment.

### Step 2 — bin per branch (`src/train/pulse.js#detectDeadSegments`)

Each line has one or more *branches* (Green's Ashland and Cottage Grove, Blue's O'Hare and Forest Park, etc.) — sourced from `trainLines.json` shapes. For each branch:

1. Build a polyline and divide it into 0.25-mile bins. Round-trip "loop" branches (Brown, Pink, Orange, Purple) are split by `processSegment` / `buildLineBranches` into outbound + inbound branches that share geometry but carry a `trDrFilter` matching the Train Tracker direction code (`LOOP_LINE_TRDR_OUTBOUND`: brn=1 Kimball, org=5 Midway, pink=5 54th/Cermak, p=1 Linden). Yellow is intentionally omitted — Train Tracker reports a single trDr for both physical directions, so it stays unsplit. Without per-direction binning, a one-way outage on a loop line was masked by trains running the opposite direction in the same bins.
2. For every observation in the lookback window, perpendicular-project its lat/lon onto the polyline using equirectangular projection at the branch's latitude. Reject projections > 1,500 ft off-line (off-branch trains) or with mismatched `trDrFilter`.
3. For each bin, record the most recent timestamp any train was there.
4. A bin is **cold** if `lastSeenTs < now - max(15 min, 2.5 × headway)`. The headway-driven term is what makes the threshold scale with service density — peak weekday (~4 min headway) clamps at the 15-min floor, Sunday midday (~10 min) opens to 25 min, late-evening (~12 min) to 30 min. For bidirectional lines (Red/Blue/Green), the bin script falls back to `expectedTrainHeadwayMinAnyDir` (slowest of the two GTFS directions) so the headway term still applies when no destination is available — without that fallback, bidirectional lines silently dropped to the floor and over-fired during off-peak hours.
5. The longest contiguous run of cold bins, *excluding terminal zones at both ends*, becomes the candidate.

Pulse `direction` keys derive from a stable hash of geometry, not the branch's index in `trainLines.json`, so reordering shapes in the JSON doesn't break pulse_state continuity across deploys.

### Step 3 — sanity gates

The distance gate is composite. The candidate is admitted if **any** of the following pass:

- `passLong` — run length ≥ `MIN_RUN_FT` (2 mi) *and* `coldMs ≥ max(15 min, 2.5 × headway)`. Sparse-fallback for outer branches with few stations.
- `passMulti` — ≥ 2 named stations fully inside the cold run *and* `coldMs ≥ max(15 min, 2.5 × headway)`.
- `passSolo` — ≥ 1 named station inside, *and* `expectedTrains = floor(coldMin / headwayMin) ≥ SOLO_EXPECTED_TRAINS = 3`, *and* `coldMs ≥ max(15 min, 3.5 × headway)`.

The shared `coldMs ≥ threshold` clause keeps every admit path scaling with service density. Without it, `passLong`/`passMulti` could admit a 2-mi or 2-station cold run at exactly 1× scheduled headway — within natural bunching variance — which produced FPs on sparse-service lines (e.g. Sunday Green @ 20-min headway).

The bin script (`bin/train/pulse.js`) sizes its observation lookback to match: `lookbackMs = max(20 min, 2.5 × headway + 5 min buffer)`. With a fixed 20-min lookback, any line with headway > 6 min would have a cold threshold larger than the lookback window, meaning every bin not seen in 20 min would read cold against the (longer) threshold despite no actual evidence of how long it had been empty. The headway-driven lookback ensures bins read cold only when there's real observation data backing the claim.

The flat 2-mi minimum is gone. `passSolo`'s time-side `expectedTrains ≥ 3` factor is what blocks the obvious false-positive — a single train held at a station — without rejecting Belmont-style single-tracking, where one to two stations go cold for long enough that several trains *should* have passed through.

Other gates still apply:

| Gate | Threshold | Rationale |
|---|---|---|
| `MIN_COVERAGE_FRAC` | ≥ 50% of *in-corridor* bins seen ≥ once | If half the active corridor never had a single observation, our data is too sparse — silence rather than guess. The corridor clip (step 1) limits the denominator so weekend Purple's unused Express track doesn't drag coverage below threshold. |
| `MIN_SPAN_FRAC` | observations span ≥ 50% of lookback | Prevents firing on a 30-second blip of data. |
| Terminal zone exclusion | dead run can't touch first/last `terminalZoneFt` of the branch | Loop tail-tracks and short-turn pockets at terminals legitimately go quiet. |
| Service-corridor clip | bins outside the past-6h observation bbox are excluded from the cold-run scan | The published polyline can include track not in active service today (Purple weekend Express, etc.). Bins outside the corridor are treated as "outside service," not cold. For Purple outside Express service hours, Loop-bound observations are also dropped from the bbox so AM-rush stragglers don't keep the Loop trunk in corridor through the midday shuttle window. |
| Distinct stations | `fromStation ≠ toStation` | A run that resolves to a single named station can't be described as "X to Y" in a post and produces a degenerate polyline slice that breaks `splitSegments` downstream (NaN bbox → Mapbox 422). Always skip. |
| Straddle veto | reject if any train's consecutive observations bracket the cold run | At ~3–5 min observer cadence, trains traversing a 1 mi+ run between snapshots leave no in-run observation and look identical to a true outage. Per-train trajectories are tracked on the branch; if any pair of consecutive observations has `along[i-1] < runLoFt && along[i] > runHiFt` (or vice versa), the train physically crossed the run between snapshots and the candidate is dropped. Without this, short station gaps on dense lines (Pink California↔Western, Brown IPark↔Addison) generated FPs because the bin was "never observed" at our sampling rate. |

`fromStation`/`toStation` are taken from `stationsInRun.filter(s => trackDist >= runLoFt && trackDist <= runHiFt)` — strictly inside the cold run. The previous `nearestStationAtOrBefore`/`After` reach-out could pick named endpoints that lay past the terminal-zone clip, mislabeling the dim segment.

A separate full-line zero-obs branch handles complete blackouts: when a line has zero observations in the lookback while other lines have data and `expectedTrainActiveTrips > 0`, bin synthesizes a full-branch candidate marked `synthetic: true`. The renderer uses synthetic-specific evidence text: *"📡 No trains observed anywhere on the line in the last 20 min."*

The synthetic path applies a **cold-start grace**: if `getLineCorridorBbox(line, now - 6h)` returns null — i.e. the line has zero observations in the past 6 hours — the bin treats this as service-not-yet-started rather than blackout and skips. Otherwise it would fire FPs every morning in the gap between scheduled service start and the first train actually pulling out of its terminal. When the corridor *is* known, the synthesized candidate's `from`/`to` stations are clipped to the in-corridor station list, so weekend Purple synthesizes "Linden → Howard" rather than "Linden → Merchandise Mart."

The bin-level gates (`bin/train/pulse.js`):

- `MIN_HOUR = 5` — skip pulse before 5 AM CT, when owl service produces irregular gaps. `chicagoHourNow` uses `hourCycle: 'h23'` so midnight CT correctly returns 0 (not 24, which previously bypassed the MIN_HOUR gate).
- `MIN_DISTINCT_TS = 3` — need at least 3 distinct snapshot timestamps in the lookback before the line can be evaluated. Stops a freshly bootstrapped observations table from looking like a system-wide outage.

### Step 4 — debounce + post

`pulse_state` (in `history.sqlite`) tracks the candidate per `(line, branch)` and now also carries `active_post_uri` and `active_post_ts` columns identifying the live pulse post. Each tick:

- If the new candidate's `[runLoFt, runHiFt]` overlaps the prior candidate's range by ≥ 50%, increment `consecutive_ticks`. Otherwise reset to 1.
- Post only when `consecutive_ticks ≥ MIN_CONSECUTIVE_TICKS = 2`.
- After a successful post, the row is **not** cleared — `active_post_uri` and `active_post_ts` are pinned. While `active_post_uri` is set, subsequent matching candidates skip the post but continue to refresh state. This is what wires the eventual bot-side clear directly to the right post.
- **`from_station` / `to_station` are also pinned once `active_post_uri` is set.** Without this, the cold run could drift one bin (one station) per tick during a multi-hour outage, the row's named stations would follow, and the eventual `✅` clear reply would name different stations than the original suspended post said. The original post text is canonical; ticks that update the run boundaries don't update the row's station names.
- A cooldown prevents the same dead segment from re-posting if it briefly clears and re-flags. The cooldown key is `train_pulse_<line>_<direction>_<from-slug>__<to-slug>` derived from the bracketing stations (`stableSegmentTag(candidate)`), so single-bin drift between ticks — which used to shift `runLoFt`/`runHiFt` by a few hundred feet and defeat a foot-range cooldown — no longer breaks it.
- If the pulse candidate disappears, the state row sits for `CLEAR_TICKS_TO_RESET = 3` clean ticks before being deleted, so a single noisy tick where one train sneaks into the dead zone doesn't cancel the chain.
- **Sparse-coverage clear advancement.** If the detector returns `skipped='sparse-coverage'` but observations did arrive on the line *and* an open pulse exists for that line, clear-ticks advance anyway. Previously a stuck pulse on a sparse-coverage line (e.g. Purple at off-peak when only a couple of trains cover the long branch) could never clear because the gate kept the detector from evaluating; the row lived forever.

### Step 5 — render and thread

The detector emits a `Disruption` object: `{ line, suspendedSegment: { from, to }, alternative, source: 'observed', evidence: { runLengthMi, minutesSinceLastTrain, trainsOutsideRun, … } }`. `src/shared/disruption.js#buildPostText` formats it as:

```
🚇⚠️ <Line> Line: trains to <terminus> not seen

Between <from> and <to>.

📡 No trains seen on this 4.2-mi stretch in the last 18 min — ~3 trains missed (12 trains active elsewhere on the line).

Inferred from live train positions; CTA hasn't issued an alert for this yet.
```

The observed-pulse title hedges intentionally (*"trains not seen"*, not *"service suspended"*) — the bot can only see an absence of observations and can't distinguish a true suspension from held trains, a snapshot aliasing miss, or a genuinely paused branch. CTA-sourced alerts (`source: 'cta-alert'`) keep the strong *"service suspended"* framing because CTA is authoritative.

Round-trip Loop lines (Brown/Orange/Pink/Purple) detect per-direction, so the title carries the **terminus name** of the affected direction — "trains to 54th/Cermak not seen" or "trains to the Loop not seen." Bidirectional lines (Red/Blue/Green) pool both directions into the same bins, so an observed cold run there means *neither* direction has a train through the segment; the title omits the qualifier. The terminus map lives in `DIRECTION_TERMINUS` in `src/shared/disruption.js`. Evidence text correctly singularises ("~1 train missed" vs "~3 trains missed") and counts unique trains for the "active elsewhere on the line" tally — previously this counted observation rows, which with ~15s observer cadence inflated the count ~80× and produced absurd numbers like "171 trains active elsewhere" for a 5-train line.

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
- `src/shared/disruption.js` — segment-dim disruption post text, alt text, and `buildClearPostText` (shared by republished alerts and pulse). `titleFor` branches on `source`: `'cta-alert'` keeps the strong *"service suspended"* framing; `'observed'` hedges with *"trains not seen"* since the bot only sees an absence and can't certify a true suspension.
- `src/map/disruption.js` — Mapbox static map renderer that produces the dim/bright overlay on the route line, station-name pills, and title pill. `splitSegments` cuts the polyline at the from/to stations into `active` and `suspended` slices; `truncateRoundTrip` first prunes round-trip lines (Pink/Brown/Orange/Purple, which ship as one terminus→Loop→terminus polyline) at the apex, otherwise the return-leg "active" half visually redraws bright over the dim on short stretches like Pink California↔Western. The truncation is **disruption-aware**: if either `fromLoc` or `toLoc` is closer to the dropped (return-leg) half than the kept half, the disruption sits on the apex itself (typical for Loop-section pulses on Brown/Orange/Pink/Purple — e.g. Orange Roosevelt↔Washington/Wabash). In that case `truncateRoundTrip` returns the *full* polyline; otherwise `splitSegments` would chop the very geometry the suspended segment lives on and produce bogus bbox/overlay coordinates. Active overlays are `path-10+color-0.95`, drawn first (bottom). Suspended is `path-10+color-0.4`, drawn **last** (top) so it covers the bright round-cap overlap that would otherwise bridge the gap on short suspensions. Station labels are placed via `pairedStationLabels` which flips the second pill below the dot if the two would horizontally collide above.
- `src/shared/bluesky.js` — `resolveReplyRef` for root-aware threading (used by both pulse and alerts; bus alerts now go through it too).
- `src/shared/history.js` — `recordAlertSeen` (with flicker reversal), `listUnresolvedAlerts`, `incrementAlertClearTicks`, `pulse_state` rows (now with `active_post_uri` / `active_post_ts`), `recordDisruption`, `getRecentPulsePostsAll` (24h), `hasObservedClearForPulse`, `hasUnresolvedCtaAlert`, `rolloffOld` (now also cleans up the cooldowns table). `ctaAlertPostedSince`, `hasObservedClearSince`, and `parseAtUri` were removed in favor of the new helpers.
- `src/shared/observations.js` — train position storage + `getRecentTrainPositions` for pulse, plus `getLineCorridorBbox(line, sinceTs)` (active-corridor bbox over the past 6h, used to clip detection to revenue track) and `getActiveBusRoutesSince(sinceTs)` (Set of routes with ≥1 bus obs in the past 6h, used by bus pulse cold-start grace).
- `src/train/pulse.js` — dead-segment detector (pure, no DB). Composite distance gate, full-line synthetic candidates, `stableSegmentTag`, `snapToLineWithPerp` (equirectangular).
- `bin/bus/alerts.js`, `bin/train/alerts.js` — CTA-republishing cron entry points.
- `bin/train/pulse.js` — pulse detector cron entry point (debounce, cooldown, threading, posting).
- `bin/train/disruption.js` — manual disruption poster; logs in via `loginAlerts` so output goes to the alerts account, calls `recordDisruption`, shares the renderer with pulse.
- `bin/audit-alerts.js` — health audit cron that surfaces stuck pulse_state rows, unresolved alerts past their natural lifetime, and other invariant violations across the alert pipeline.

## Quote-attached related observations (post-2026-05-03)

The alerts account doubles as the connective tissue between two other accounts: when the analytics bots (`@ctabusinsights`, `@ctatraininsights`) post a bunching or gap event that matches a live disruption, the alerts account quote-replies into the disruption's thread.

The cross-account part is the point: a rider opens a CTA-alert thread on `@ctaalertinsights` and sees both the CTA alert and the analytics-bot's ground-truth observation of the symptom (e.g. *"3 buses bunched on Belmont near Halsted"*) as a quote-card in-thread, without the analytics bots needing to know an alert exists.

### What anchors a thread

The sweep runs at the end of `bin/{bus,train}/alerts.js` each tick (every 10 min) and considers three anchor sources:

1. **Unresolved CTA alerts** — `alert_posts` rows with `resolved_ts IS NULL AND post_uri NOT NULL`.
2. **Active train pulse observations** — `pulse_state` rows with `active_post_uri NOT NULL`.
3. **Active bus held-cluster observations** — `bus_pulse_state` rows with `active_post_uri NOT NULL AND affected_pid NOT NULL`. Whole-route bus blackouts have no segment, so they intentionally do not anchor (any bunching anywhere on the route would match if they did).

Anchors that share a thread root (e.g. a CTA alert that threaded under an earlier pulse observation) are merged into one work item — the union of routes is queried and the cap-of-3 quotes/thread applies once across both. Thread root is resolved by reading each anchor's record and taking `value.reply.root.uri` or the post itself.

### What's a candidate

`findRelatedAnalyticsPosts({kind, routes, sinceTs, untilTs, excludeSourceUris})` unions `bunching_events` and `gap_events` filtered by:

- `kind` matches the alerts bin's kind (bus or train).
- `route IN (group's union of anchor routes)`.
- `posted = 1 AND post_uri IS NOT NULL` — only events the analytics bots actually posted.
- `ts BETWEEN earliestAnchorTs - 30 min AND now` — the 30-min lead window catches "rider was already seeing the symptom before CTA acknowledged."
- not already in `thread_quote_posts` for this thread root (idempotency).

### Strict relevance filter

A route match alone is not enough. Each candidate is then checked dimensionally:

**Trains** (`trainCandidateRelevant` in `src/shared/relatedQuotes.js`):
- **Segment**: the candidate's `near_stop` must lie on the line's polyline between `from`/`to` with a 1-stop buffer (median inter-station gap on the matched branch). Station resolution is fail-closed — unresolved names → reject.
- **Direction**: directions arrive in three different formats — compass words from CTA alerts, `branch-N-{outbound,inbound}` from pulse anchors, trDr codes (`'1'`/`'5'`) from candidate rows. `compassToTrDr(line, compass)` translates the anchor's compass to the line's trDr (per-line because conventions disagree: red 1=N, blue 1=O'Hare, brn 1=Kimball, etc.). When both anchor and candidate carry direction, mismatches are rejected outright. This is what makes "Red NB alert + SB bunching at Wilson" reject even though Wilson is geographically inside the segment.

**Buses** (`busCandidateRelevant`):
- **Held-cluster anchor**: candidate's `direction` (which is the pid for buses) must equal the cluster's pid; resolve candidate's `near_stop` on that pid via `resolveStopOnRoute` and require its `pdist` to fall within `[clusterLoFt - 2640, clusterHiFt + 2640]` (½-mi buffer).
- **CTA bus alert anchor**: try each known pid for the candidate's route (preferring the candidate's own pid). Resolve the alert's from/to and the candidate's near_stop on the same pid; admit when all three resolve and candidate falls in `[min(from,to) - 2640, max(from,to) + 2640]`.
- Bus alert direction is captured in `affected_direction` but currently unused — pid codes don't map cleanly to compass words without per-route metadata. Documented limitation; segment containment carries the relevance signal.

If the anchor lacks segment info (e.g. `extractBetweenStations` couldn't parse the headline, or a bus pulse blackout with no held-cluster), no quotes attach. **Better to miss than to mis-attach** — this is the design ethos.

### Posting

Per qualifying candidate:
1. Fetch the source post's `cid` via `getPostRecord`. Source missing (deleted) → record a tombstone in `thread_quote_posts` with `quote_post_uri = NULL` and skip on future sweeps.
2. Build a `replyRef` rooted at the thread root with `parent` = the latest anchor in the thread (so the quote lands at the tail).
3. `postQuote(agent, "Related observation:", {uri, cid}, replyRef)` builds an `app.bsky.embed.record` post under the alerts account that quotes the analytics post in-thread.
4. Record in `thread_quote_posts (thread_root_uri, source_post_uri, quote_post_uri, ts)` for idempotency.

Cap is **3 quotes per thread root lifetime**, sorted ts DESC, so noisy disruptions don't flood the thread. Each posted quote becomes the new thread tail for any subsequent quotes this tick (so they thread under each other in posting order).

### Schema additions

- `alert_posts`: `affected_from_station`, `affected_to_station`, `affected_direction` — populated at insert from `extractBetweenStations` + `extractDirection`. Stored alongside the alert so the relevance filter doesn't re-parse on every tick.
- `bus_pulse_state`: `affected_pid`, `affected_lo_ft`, `affected_hi_ft` — populated for held-cluster pulses; left null for blackouts (which intentionally don't anchor).
- `thread_quote_posts (thread_root_uri, source_post_uri, quote_post_uri, ts)` — idempotency; tombstones missing-source posts so we don't re-fetch every tick.

### Kill switches

- `QUOTE_RELATED_POSTS=0` — disables the sweep entirely (returns immediately with a log line).
- `ALERTS_DRY_RUN=1` / `--dry-run` — sweep enumerates and logs but skips both the bluesky post and the DB write.

### Files

- `src/shared/relatedQuotes.js` — sweep orchestration, train + bus relevance filters.
- `src/shared/trainSegment.js` — `isStationOnSegment`, `compassToTrDr`, `normalizePulseDirection`, `COMPASS_TO_HINT` (round-trip branch picker), `COMPASS_TO_TRDR` (bidirectional candidate filter).
- `src/shared/ctaAlerts.js` — `extractDirection(text, line)` returning `north|south|east|west|in|out|null`.
- `src/bus/patterns.js` — `resolveStopOnRoute({pids, loadPattern, stopName})` for bus stop name → `(pid, pdist)` resolution.
- `src/shared/bluesky.js` — `postQuote`, `getPostRecord` (returns `{uri, cid, value, replyRoot}`; replaces hand-rolled cid+root logic in `resolveReplyRef`).
- `src/shared/history.js` — schema migrations, `recordThreadQuote`, `getThreadQuotedSourceUris`, `findRelatedAnalyticsPosts`, `listActiveBusPulseAnchors`, `listActiveTrainPulseAnchors`.

### Known limitations

- Bus alert direction is never enforced (segment containment carries the signal).
- `compassToTrDr` was empirically derived from a 24h trDr → destination histogram on the production observations table; a future CTA convention change would need this updated.
- Multi-line CTA alerts (rare) only get a `trainSegment` populated when `trainLines.length === 1`. Multi-line alerts route-match but don't segment-filter.

## Held-train detection (post-2026-05-03)

Cold-segment pulse measures *absence of pings*, not *absence of service*. When CTA halts service mid-run and trains sit at stations with their doors open, those trains keep emitting GPS — bins read warm and pulse stays silent. The Sox-35th police hold on 2026-05-03 surfaced this as a missed shutdown.

`src/train/heldClusters.js` complements pulse with a different signal: trains that ARE pinging but aren't moving. Each train's recent observations are classified by `src/train/motion.js` into `moving` / `stationary` / `unknown`. A held-cluster candidate fires when:

- ≥ 2 stationary trains share a branch within `HELD_CLUSTER_FT` (1 mi).
- No moving train is within `HELD_CLUSTER_FT` of the cluster midpoint in the same direction.
- Each stationary train has been so for ≥ `max(10 min, 1.5 × scheduled headway)`.
- GTFS says service should be active.

Held candidates flow through the same `handleCandidate` machinery as cold-segment candidates: 2-tick consecutive overlap, `pulse_state` keyed by `(line, direction)`, 90-min cooldown, threading under any open CTA alert. The post copy is different: `🚇🚨 [Line] Line: service halted around X` with evidence `🛑 N trains stationary M+ min near …` instead of the "no trains seen" cold framing.

Disable held detection via `HELD_DETECTION=0`.

## Sparse-line gate hardening

Two compounding vetoes guard against the false-positive class where a single missed turnaround on a sparse line (Sunday Green Lake branch is the canonical case) reads as an outage:

- **Terminal-adjacency veto** in `src/train/pulse.js` — when the cold run sits within 0.5 mi of the active corridor's terminal-most station AND `coldMs` is within `1.2 × coldThresholdMs` AND the candidate isn't admitted by `passLong`, drop it. Rationale: the corridor edge is where natural between-turnaround gaps cluster, and a 1.0× ratio cold reading there is more likely a single missed dispatch than a service halt.
- **Dispatch-continuity veto** — `expectedTrainDispatchesInWindow(line, trDr, sinceTs, untilTs)` (in `src/shared/gtfs.js`) sums GTFS active-by-hour fractions across the lookback window. When ≥ 1 dispatch was scheduled AND `coldMs` is within `1.5 × coldThresholdMs` AND not `passLong`, the candidate is dropped as a between-dispatches gap.

Both vetoes specifically exempt long sustained cold runs (`passLong`) so a real multi-hour outage at the line's edge still admits.

## Loop trunk scoping

`inLoopTrunk` (in `src/train/speedmap.js`) accepts either-direction observations on the elevated Loop trunk so a Brown/Orange/Pink/Purple train tagged with the wrong `trDr` mid-circuit doesn't leave inbound bins falsely cold. The override now applies only to the round-trip lines explicitly listed in `LOOP_TRUNK_LINES = {brn, org, pink, p}`. On bidirectional lines (Red/Blue/Green) with stable `trDr` codes, the override would mask single-direction Loop holds — Green Lake/Wabash service stopping eastbound while westbound runs through the same trunk bins should still flag.

## Gap-detector cap exemption + rush-period reset

`bin/train/gaps.js` enforces a per-line cap of 2 posted gap events per **rush period** (AM 05–10, midday 10–15, PM 15–20, evening 20–05) instead of per Chicago day. Each rush gets its own budget so two morning Red gap posts don't suppress an actual evening incident.

When the cap is hit, the gate is bypassed if either of these correlated signals is firing:

- A pulse on the same line within the last 30 min (`recentPulseOnLine`).
- A ghost-detector near-miss on the same line within the last 90 min (`recentGhostOnLine` reads from `meta_signals`).

Rationale: the cap exists to suppress repeated bunching events on a chronically problematic line. It should *not* suppress a fresh, distinct incident when other detectors are also seeing it.

## Multi-signal correlation roundup

`bin/incident-roundup.js` runs every 5 min on the `:04` offset and emits a single text-only post when multiple sub-threshold signals correlate within a 30-min window. Each detector writes near-miss rows to a new `meta_signals` table:

- Pulse writes `pulse-cold` / `pulse-held` rows for candidates that are 1/2 ticks (would-be-but-not-yet).
- Gap detector writes `gap` rows when cap- or cooldown-suppressed.
- Ghost detector writes `ghost` rows for sub-threshold deficits ≥ 50% of `MISSING_ABS_THRESHOLD`, plus full-strength rows for the events it does post.

The roundup scoring takes the max severity per source, adds a per-source persistence bonus (`0.15 × (count − 1)` capped at `+0.5`), then sums distinct sources. When the score crosses 1.75 (e.g. one full-strength signal + one half-strength, two half-strength signals each repeating across a few ticks, or one full-strength signal repeating with a single weak corroborator), it posts:

```
⚠ Red Line · multiple service signals
· 2.66x gap (cap)
· 2.5 of 8.5 trains missing
· pulse near-miss Clark/Division → Harrison

None individually crossed its alert threshold; together they suggest service is degraded.
```

Per-line cooldown is 60 min. The post is text-only because by definition no single detector had clean evidence to render a map for.

## Ghost trailing-tail threshold

The hourly ghost detector's `MISSING_ABS_THRESHOLD = 3` is the right floor for whole-hour deficits but over-rejects mid-incident drops where the deficit is concentrated in the trailing slice of the window. A trailing-deficit override admits at `missing ≥ 2` when:

- `tailMedian < observedActive` (deficit concentrated in tail, not steady).
- `trailingDeficit ≥ 2`.

Rationale: a 16:08 ghost run that sees `red/5: 2.5 missing` after a 16:00 incident should fire even though the prior hour was healthy. A 24/7 under-count of 2 still drops.

## Observation cadence

`scripts/observeTrains.js` polls Train Tracker every 30s via cron, recording observations independent of the detector crons. Cron's minimum granularity is 1 minute, so the script itself runs two ticks 30s apart per cron firing. This densifies the `observations` table so held-train detection has plenty of motion samples per train to classify reliably, and snapshot timelapses (15-min window) get ~30 frames per train for visibly continuous motion. Train Tracker shares the 100k/day CTA budget with Bus Tracker but one batched call returns all 8 lines — at 30s cadence that's ~2.9k calls/day, well under the cap.

## Replay harness

`scripts/replay-pulse.js` re-runs pulse detection against historical `observations` data at synthetic `now` values. Used to test detector changes against past incidents (e.g. the 2026-05-03 16:00–18:00 window) without burning a real shadow week. Modes:

- `--line=red --start=ISO --end=ISO` for a single line over a window.
- `--all-lines --days-back=7` to scan recent history across all lines.
- `--step=5m` (or `2m`, `1h`) for cadence control.

Output flags every tick that would post or skip, with the candidate detail and overlap math. No DB writes.
