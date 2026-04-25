# Service alerts

The bot's alerts account posts about CTA service problems from two sources:

1. **Republishing CTA's official alerts** — pulled from CTA's public alerts feed, filtered for significance and tracked routes, with a threaded "cleared" reply when CTA marks them resolved.
2. **Pulse — the bot's own detection** — a pulse detector that watches live train positions and infers a service suspension when a long stretch of a line goes "cold" (no trains in 15+ min) before CTA has issued an alert about it.

Both go to the same dedicated alerts account, so followers see a single feed combining "what CTA says" and "what the bot can see for itself."

## The plain-English version

### Republishing CTA alerts

Every few minutes:

1. Fetch all currently-active alerts from CTA.
2. Drop alerts that don't touch a route the bot watches.
3. Drop alerts that are "Major" by CTA's flag but actually trivial (single elevator out, painting an entrance, etc.).
4. For each new alert, post it.
5. For each alert we'd previously posted that's no longer in the feed for several consecutive checks, post a threaded reply saying it's been cleared.

For trains, when the alert text mentions "between [station A] and [station B]", we try to also draw a map dimming that segment of the line.

### Pulse — bot-detected disruptions

In parallel, every few minutes:

1. Pull every train position recorded in the last ~20 minutes for each line.
2. Walk along the line in 0.25-mile bins and ask: "when's the last time *any* train showed up in this bin?"
3. If a contiguous stretch of bins ≥ 2 miles long has been cold for at least 15 minutes (or 2× the scheduled headway, whichever is longer), and trains are still active elsewhere on the line, that's a candidate.
4. Require the same stretch to recur on two consecutive checks before posting (filters single-tick noise).
5. Post a map dimming the affected segment with a footer making clear this was inferred from live positions, not announced by CTA. If there's an open CTA alert for the same line, the pulse post is threaded as a reply to it.
6. When the dead stretch warms back up for several consecutive checks, post a `✅ trains running through X ↔ Y again` reply under the original pulse — independently of whether CTA ever issued an alert.

This is how the bot can flag a Red Line outage minutes before CTA's own alert appears — the empty stretch is right there in the live feed.

### Threading: keeping a single conversation per disruption

Pulse posts and CTA-alert posts can arrive in either order on the same disruption. The threading rules are designed so all related posts share the same thread root:

- **Pulse first, CTA second** — pulse posts top-level. When the CTA alert lands, `bin/train/alerts.js` looks up the most recent pulse for that line and threads under it. Both clears (bot-side `✅ trains running again` and CTA-side `✅ CTA has cleared:`) reply within that thread, with `resolveReplyRef` inheriting the pulse as root.
- **CTA first, pulse second** — CTA alert posts top-level. Pulse looks up the open CTA alert and threads under it (`findOpenAlertReplyRef` in `bin/train/pulse.js`). The bot-side clear inherits the CTA alert as root via the same `resolveReplyRef` helper.
- **Pulse only (CTA never publishes)** — pulse posts top-level, bot-side clear replies under it, no CTA participation.
- **CTA only (pulse never fires)** — single CTA alert + threaded `✅ CTA has cleared:` reply, same as before pulse existed.

The bot-side clear text varies based on whether a CTA alert has appeared in the thread:
- No CTA alert seen: *"… (CTA hasn't issued an alert for this.)"*
- CTA alert exists but unresolved: *"… (CTA hasn't cleared their alert yet.)"*

The `ctaAlertPostedSince` check (in `src/shared/history.js`) drives the variant; `hasObservedClearSince` provides idempotency so a process restart between posting the clear reply and deleting `pulse_state` doesn't double-post.

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

**Significance** (`isSignificantAlert`): CTA's `MajorAlert=1` flag is too noisy on its own — it tags single-stop closures, block-party reroutes, and elevator outages. We require:

1. `major` flag set, AND
2. None of the `MINOR_PATTERNS` match (`reroute`, `detour`, `elevator`, `escalator`, `entrance`, `bus stop`, `paint`, `track work`, `weekend service change`, etc.), AND
3. Either `MAJOR_PATTERNS` match (`no train|rail|bus|service`, `not running`, `suspended`, `shuttle bus`, `major delays`, `single-track`, `between X and Y`, etc.) OR `severityScore ≥ 3`.

The minor-wins ordering matters: an alert headlined "No trains stopping at Belmont (elevator construction)" looks major by keyword but should drop on the elevator gate. The bot errs on silence — a missed real outage is recoverable; spamming followers with stop closures is not.

**Relevance** (per-bin): `bin/bus/alerts.js` requires at least one of the alert's bus routes to be in the union of `bunching`, `gaps`, `speedmap`, and `ghosts` route lists. Train alerts are kept if they touch any tracked line (all 8). Most bus-alert volume is for routes followers don't care about; this filter throws away ~80% of them.

### Step 3 — post new alerts

`buildAlertPostText` (`src/shared/alertPost.js`) produces:

```
🚌⚠ <headline>

<shortDescription, truncated to ~200 chars on a sentence boundary>

Per CTA. Check transitchicago.com for updates.
```

If the rendered text exceeds Bluesky's 300-grapheme post limit, it falls back to headline + "Per CTA. transitchicago.com".

For trains, the bin tries to extract `between X and Y` station names from the alert text and resolve them to a real polyline segment. If both endpoints resolve, the post includes a map dimming that segment of the line — see `src/shared/disruption.js` for the post text and `bin/train/disruption.js` for the rendering.

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

1. Build a polyline and divide it into 0.25-mile bins.
2. For every observation in the lookback window, perpendicular-project its lat/lon onto the polyline. Reject projections > 1,500 ft off-line (off-branch trains).
3. For each bin, record the most recent timestamp any train was there.
4. A bin is **cold** if `lastSeenTs < now - max(15 min, 2 × headway)`.
5. The longest contiguous run of cold bins, *excluding terminal zones at both ends*, becomes the candidate.

### Step 3 — sanity gates

Before returning a candidate, the detector requires:

| Gate | Threshold | Rationale |
|---|---|---|
| `MIN_RUN_FT` | ≥ 2 mi | Anything shorter is a single train holding at a station, not a suspension. |
| `MIN_COVERAGE_FRAC` | ≥ 50% of bins seen ≥ once | If half the line never had a single observation, our data is too sparse — silence rather than guess. |
| `MIN_SPAN_FRAC` | observations span ≥ 50% of lookback | Prevents firing on a 30-second blip of data. |
| Terminal zone exclusion | dead run can't touch first/last `terminalZoneFt` of the branch | Loop tail-tracks and short-turn pockets at terminals legitimately go quiet. |
| Distinct stations | `fromStation ≠ toStation` | A 2-mi run that resolves to a single named station is a render artifact. |

The bin-level gates (`bin/train/pulse.js`):

- `MIN_HOUR = 5` — skip pulse before 5 AM CT, when owl service produces irregular gaps.
- `MIN_DISTINCT_TS = 3` — need at least 3 distinct snapshot timestamps in the lookback before the line can be evaluated. Stops a freshly bootstrapped observations table from looking like a system-wide outage.

### Step 4 — debounce + post

`pulse_state` (in `history.sqlite`) tracks the candidate per `(line, branch)`. Each tick:

- If the new candidate's `[runLoFt, runHiFt]` overlaps the prior candidate's range by ≥ 50%, increment `consecutive_ticks`. Otherwise reset to 1.
- Post only when `consecutive_ticks ≥ MIN_CONSECUTIVE_TICKS = 2`.
- A 90-minute cooldown per `(line, branch, segment)` prevents the same dead segment from posting again on every single tick once cleared and re-flagged.
- If the pulse candidate disappears, the state row sits for `CLEAR_TICKS_TO_RESET = 3` clean ticks before being deleted, so a single noisy tick where one train sneaks into the dead zone doesn't cancel the chain.

### Step 5 — render and thread

The detector emits a `Disruption` object: `{ line, suspendedSegment: { from, to }, alternative, source: 'observed', evidence: { runLengthMi, minutesSinceLastTrain, trainsOutsideRun, … } }`. `src/shared/disruption.js#buildPostText` formats it as:

```
⚠ <Line> Line service suspended

Between <from> and <to>.

📡 No trains seen on this 4.2-mi stretch in the last 18 min (12 trains active elsewhere on the line).

Inferred from live train positions; CTA hasn't issued an alert for this yet.
```

If there's an open CTA alert post for the same line in our DB, the pulse post is threaded as a reply to it (`findOpenAlertReplyRef`). The reverse case — pulse first, CTA alert later — is handled symmetrically in `bin/train/alerts.js#postNewAlert` via `getRecentPulsePost`, so either ordering converges to a single thread.

The same `Disruption` shape and renderer are reused by `bin/train/disruption.js`, which lets an operator manually post a disruption from CLI args (typically copying CTA alert info verbatim before the auto-republisher catches up). The auto-detector and the manual command share everything downstream of the `Disruption` object.

### Step 6 — bot-side clear

When `pulse_state` rolls off after `CLEAR_TICKS_TO_RESET = 3` clean ticks, `bin/train/pulse.js#postClearReply` posts a `✅ <Line> trains running through X ↔ Y again` reply under the original pulse (24h lookup window) and releases the per-segment cooldown so a fresh outage on the same stretch can post immediately. Two safeguards:

- **Idempotency** — `hasObservedClearSince` checks `disruption_events` for an existing `observed-clear` row tied to the same pulse before posting; if one exists, the reply is skipped. This prevents a duplicate clear if the process is killed between the post and `clearPulseState`.
- **Wording variant** — `ctaAlertPostedSince` toggles the parenthetical: *"(CTA hasn't issued an alert for this.)"* when CTA never weighed in, *"(CTA hasn't cleared their alert yet.)"* when there's an unresolved CTA alert in the thread. The bot-side clear fires in both cases — CTA's eventual `✅ CTA has cleared:` is an independent signal and both belong in the thread.

## Why this approach

Riders already have transitchicago.com and the CTA app. The value of this account on Bluesky is in two complementary signals:

- **Trustworthy republishing**: thread-attached "cleared" replies, filtering for significance and tracked routes, and visual segment maps for "between X and Y" rail alerts make the official feed easier to consume.
- **Earlier detection**: the pulse detector regularly flags suspensions before CTA issues an alert. The footer is explicit ("Inferred from live train positions; CTA hasn't issued an alert for this yet") so readers know what kind of signal it is — and threading the pulse post under the CTA alert when one eventually appears keeps everything in one place.

The conservative filtering (minor-wins, severity floor, multi-tick clear, debounce, coverage/span gates, cold-start guards) is deliberate across both halves. False alarms here are higher-cost than for the visualization posts: a post on this account reads as transit info, and over-posting trivial alerts or a phantom suspension trains followers to ignore the feed.

The bot-side clear (step 6 above) is the one place we deliberately accept a small false-positive risk: a single tick where the dead-zone briefly warms back up could fire a premature `✅`. The 3-tick `CLEAR_TICKS_TO_RESET` debounce makes that unlikely, and on balance leaving pulse posts hanging without resolution was a worse failure mode — followers couldn't tell if a flagged disruption was still live.

## Files

- `src/shared/ctaAlerts.js` — fetching, normalization, significance gates.
- `src/shared/alertPost.js` — alert and resolution post text.
- `src/shared/disruption.js` — segment-dim disruption post text, alt text, and `buildClearPostText` (shared by republished alerts and pulse).
- `src/shared/bluesky.js` — `resolveReplyRef` for root-aware threading (used by both pulse and alerts).
- `src/shared/history.js` — `recordAlertSeen`, `listUnresolvedAlerts`, `incrementAlertClearTicks`, `pulse_state` rows, `recordDisruption`, `getRecentPulsePost`, `hasObservedClearSince`, `ctaAlertPostedSince`, etc.
- `src/shared/observations.js` — train position storage + `getRecentTrainPositions` for pulse.
- `src/train/pulse.js` — dead-segment detector (pure, no DB).
- `bin/bus/alerts.js`, `bin/train/alerts.js` — CTA-republishing cron entry points.
- `bin/train/pulse.js` — pulse detector cron entry point (debounce, cooldown, threading, posting).
- `bin/train/disruption.js` — manual disruption poster from the train account; shares the renderer with pulse.
