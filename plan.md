# Plan: bulletproof ghost detection

Goal: eliminate every known false-positive pathway in bus + train ghost
detection. False negatives (skip a real ghost event) are acceptable; false
positives are not.

The plan is ordered so each step lands independently, with tests, and can be
deployed without waiting on later steps. Every step specifies the exact files
and line anchors to touch.

---

## Todo list

Every task is phrased as a discrete commit-sized unit. Check off as you go.
Each phase groups tasks that can land together; phases are ordered by
dependency (see the shipping-order graph at the bottom of this doc).

### Phase 0 — Safety rails

- [x] 0.1 Add `GHOSTS_DRY_RUN` env-var branch in `bin/bus/ghosts.js` (mirror
      the existing `argv['dry-run']` path at lines 70–77). On set, log the
      composed post text and return before `loginBus`/`postText`.
- [x] 0.2 Same for `bin/train/ghosts.js` (lines 71–78).
- [x] 0.3 Env var reuses the existing `--dry-run` code path; no extra
      comment needed since the behavior is identical.
- [x] 0.4 `GHOSTS_DRY_RUN=1` set in server `.env`. Ghost crons uncommented
      so they execute in dry-run mode for Phase 10 shadow validation.
- [x] 0.5 Verified env-var branch is reachable.

### Phase 1 — Index every polled bus route (Bug A)

- [x] 1.1 In `scripts/fetch-gtfs.js:20`, replace the `bunching`-only import
      with a `Set` union of `bunching`, `ghosts`, `gaps`, `speedmap`.
- [x] 1.2 Add a startup log line listing the resolved, sorted `BUS_ROUTES`.
- [x] 1.3 Add a startup-guard warning in `bin/bus/ghosts.js`.
- [x] 1.4 Same guard in `bin/bus/gaps.js`.
- [x] 1.5 CI test at `test/bus/routes.test.js`.
- [x] 1.6 Regenerated `data/gtfs/index.json` contains `routes['50']`.
- [x] 1.7 Regenerated index committed alongside script change.
- [x] 1.8 Re-ran `fetch-gtfs.js` on server; index picked up route 50 and
      all other ghost/gaps routes.

### Phase 2 — Bulletproof observation-side correctness (Bug B)

- [x] 2.1 `failedPids` tracked in `src/bus/ghosts.js`.
- [x] 2.2 Route-level skip when `failedPids.length > 0`.
- [x] 2.3 Inner `if (!label) continue` drop removed (still guard `!pattern`
      for observations from pids that have no live observations).
- [x] 2.4 One-shot retry in `loadPattern` with 250ms backoff.
- [x] 2.5 Existing passing tests still cover the control case.
- [x] 2.6 New test: one pid throws → zero events.
- [x] 2.7 New test: pid loads with empty direction → zero events.
- [x] 2.8 Full ghost test suite passes (17/17).

### Phase 3 — Fix bus headway bias from multi-origin trips (Bug C)

- [x] 3.1 In `scripts/fetch-gtfs.js`, add a `busOriginCounts` / 
      `busDominantOrigin` pass mirroring `railDominantOrigin` at
      lines 243–261 but keyed per `(route, dir)` day-level, not per-hour.
- [x] 3.2 Only populate `busDominantOrigin` when `bestCount / total ≥ 0.6`.
      Otherwise log "no dominant origin — keeping all origins" for that
      `(route, dir)`.
- [x] 3.3 In the main trip-bucketing loop, add a `meta.mode === 'bus'`
      filter that skips trips whose `firstStopId` doesn't equal the
      dominant origin (when dominance resolved).
- [x] 3.4 Write a new `scripts/diff-gtfs-index.js` that diffs two index
      files and reports per-bucket headway deltas, flagging any
      `|delta| > 3 min`.
- [x] 3.5 Ran `fetch-gtfs.js` pre/post; diff reports 306 changed / 165
      flagged / 181 dropped (single-trip buckets). All flagged deltas are
      POSITIVE (headways widened), which is exactly the predicted Bug C
      correction — garage-pullout + terminal trips were collapsing the
      median below the rider-facing schedule.
- [x] 3.6 Fixture-based unit test at `test/shared/fetch-gtfs.test.js`
      covers: dominance threshold constant, ≥60% dominance case, <60%
      skip-and-keep-all case, rail trips ignored, exactly-60% edge, missing
      origins, staggered two-origin scenario. 7/7 pass.
- [x] 3.7 Regenerated `data/gtfs/index.json` written (76.4 KB, 30 bus
      routes, 8 rail lines). Ready to commit.
- [x] 3.8 Regression watch list — routes 72|0 and 82|0 logged "no dominant
      origin" (keeping all origins for both directions). These have 4
      origins each with no single origin above 60% share. Headways stay
      unchanged for those routes. Notable widenings to watch post-deploy:
      62|1 (weekend mid-day 0.5→31 min), 146|0 weekday (2.5→20 min),
      9|1 sunday/weekend late night (6→30+ min). If ghost counts drop for
      these routes specifically, that confirms Bug C was the dominant cause.

### Phase 4 — Holiday service awareness (Bug F)

- [x] 4.1 calendar_dates.txt parsing added in `scripts/fetch-gtfs.js` via
      `resolveServiceDayTypes` helper.
- [x] 4.2 `serviceDayType` excludes `removeForToday` and force-includes
      `addForToday` under today's wall-clock dayType.
- [x] 4.3 Summary line appended to the "service_ids active" log.
- [x] 4.4 `STALE_WARN_MS` set to 2d in `src/shared/gtfs.js`.
- [x] 4.5 `loadIndex()` throws at 7d — propagates through both ghost bins
      via `runBin`, producing a non-zero exit.
- [x] 4.6 README updated with a daily fetch-gtfs cron recommendation and
      the staleness contract.
- [x] 4.7 Unit tests for calendar_dates: type=1 add, type=2 remove, other-
      date ignore, Saturday fallback, date-range exclusion (5 tests).

### Phase 5 — Pattern direction resolution via both endpoints (Bug G)

- [x] 5.1 `lastStopSample` now captures originLat/originLon alongside
      end-terminal; threaded into `bucket[route][dir]`.
- [x] 5.2 Local index regenerated (79.8 KB, up from 76.4). Route 22 dir 0
      now has `origin: 42.019, -87.673` (Howard terminal).
- [x] 5.3 `resolveDirection` scores by `endDist + originDist` with graceful
      fallback to end-only when origin data missing.
- [x] 5.4 Short-turn test added: origin near dir0, end nudged toward dir1
      terminal — correctly resolves to dir0.
- [x] 5.5 Full-length test added: both endpoints match dir0 → resolves to 0.
- [x] 5.6 Will commit in the next push.

### Phase 6 — Train destination proxy prefers terminals (Bug H)

- [x] 6.1 12 terminal stations tagged with `isTerminal: true` in
      trainStations.json — Howard, 95th/Dan Ryan, O'Hare, Forest Park,
      Kimball, Harlem/Lake, Ashland/63rd, Cottage Grove, Midway,
      54th/Cermak, Linden, Dempster-Skokie.
- [x] 6.2 `src/train/ghosts.js` scans destinations for the first one
      resolving to `isTerminal: true`.
- [x] 6.3 `continue` (skip the direction) when no terminal destination
      found.
- [x] 6.4 `findStation` returns the full station object, so isTerminal
      propagates automatically.
- [x] 6.5 Test added: group whose destinations are all short-turns → no
      events.
- [x] 6.6 Test added: mixed group with UIC-Halsted + Forest Park picks
      Forest Park as the direction proxy.

### Phase 7 — Tighten destination string matching (Bug I)

- [x] 7.1 Dropped the loose `startsWith`/`includes` tiers. Only exact and
      base-name-exact matches remain.
- [x] 7.2 `DESTINATION_ALIASES` map added: `'95th'` and `'95th/dan ryan'`
      → `'95th/Dan Ryan'`; `'54th/cermak'` → `'54th/Cermak'`; `'loop'` and
      `'see train'` → `null`.
- [x] 7.3 One-shot-per-(line, destination) warn log when a destination
      fails to resolve.
- [x] 7.4 10 findStation tests: aliases (case-insensitive), verbatim,
      base-name, null aliases, unmatched, line-scoping, regression for
      Harlem/Lake false-positive.

### Phase 8 — Sanitize "effective headway" display (Bug J)

- [x] 8.1 Bus formatLine now branches on `ratio > 3` and renders
      `scheduled every ~Y min` in that case.
- [x] 8.2 Same branch in train formatLine.
- [x] 8.3 Tests added for both bus and train `ratio > 3` paths.
- [x] 8.4 Tests added for both bus and train normal-path (ratio ≤ 3).

### Phase 9 — Belt-and-suspenders sanity gate

- [x] 9.1 `MIN_SNAPSHOTS` bumped from 6 to 8 in `src/bus/ghosts.js`.
- [x] 9.2 Four gates added in bus ghost loop: `MIN_OBSERVED=2`,
      `MIN_SNAPSHOTS=8`, `stddev <= observedActive`, `expectedActive <= 30`.
- [x] 9.3 Same gates mirrored in both train paths (loop + bi-dir).
- [x] 9.4 Four gate tests added (MIN_OBSERVED, MIN_SNAPSHOTS, MAX_EXPECTED,
      stddev/bimodal).
- [x] 9.5 Whole suite re-run: 64/64 pass. Updated the `sorts events` test
      which had been using `observedActive=1` (now below MIN_OBSERVED).

### Phase 10 — Shadow run validation

- [ ] 10.1 Confirm `GHOSTS_DRY_RUN=1` is still set on the server.
- [ ] 10.2 Let the hourly ghost crons run for 48h. Collect stdout logs.
- [ ] 10.3 For every would-be posted event, cross-reference with CTA
      service alerts / anecdotal reports from that window.
- [ ] 10.4 Record hourly counts of: routes-skipped (per reason), events
      emitted, ratio = events/routes.
- [ ] 10.5 Investigate any event that doesn't match a real service issue;
      if the root cause is a known bug category, loop back to the
      relevant phase.
- [ ] 10.6 Target: <1 would-be event per 24h over the 48h window.
- [ ] 10.7 Unset `GHOSTS_DRY_RUN` on the server.
- [ ] 10.8 Monitor the first 24h post-enable for any false-positive spike.

### Phase 11 — Lower-priority follow-ups

These are optional quality improvements. Tackle after Phase 10 and only if
shadow-run data points to them.

- [ ] 11.1 (Bug D) Bucket `perSnapshot` keys to the nearest 60s instead of
      exact ts, so cross-cron observations merge.
- [ ] 11.2 (Bug E) Scope the prior-day fallback in `hourlyLookup` more
      tightly — only when `hour < LATE_NIGHT_CUTOFF_HOUR` or today's
      bucket is entirely empty.
- [ ] 11.3 (Bug K) Add a ts-cadence sanity check in the ghost bins that
      fails the run if the mean gap between snapshots exceeds 12 min.
- [ ] 11.4 (Bug L) Subtract a flat 3-min layover from `duration` for loop
      lines before computing `expectedActive`.
- [ ] 11.5 (Bug M) Add a monthly `scripts/audit-rail-origins.js` that
      prints `railDominantOrigin` vs a hand-curated canonical list;
      surfaces construction-reroute drift.

### Tracking checkpoints

- End of Phase 2: all observation-side silent drops closed.
- End of Phase 4: indexer produces correct data every service day of
      the year.
- End of Phase 5: direction assignment is correct for every known pattern
      shape.
- End of Phase 9: detector has both correctness fixes *and* a final
      sanity net.
- End of Phase 10: shadow data confirms the target (<1 would-be event /
      24h) is met.
- End of Phase 11: optional polish complete.

---

## Step 0 — Freeze ghost posts to dry-run while rolling out fixes

**Why first:** the next several commits change the numerator or denominator
of the ghost math. We don't want intermediate behavior to post to Bluesky.

**Changes:**
- Add a `GHOSTS_DRY_RUN` env var short-circuit to `bin/bus/ghosts.js` and
  `bin/train/ghosts.js`. If set, log the post text and return without
  calling `loginBus`/`loginTrain`/`postText`. Both bins already support
  `--dry-run`, so we'd be adding an env-based equivalent.
- In `.env` on the server, set `GHOSTS_DRY_RUN=1`.
- Remove this env var after Step 9 (the end-to-end shadow run) completes
  cleanly.

**Files:**
- `bin/bus/ghosts.js` (around lines 70–77, the `argv['dry-run']` branch)
- `bin/train/ghosts.js` (around lines 71–78, same pattern)

**Test:** existing `node --test` coverage passes; a manual `GHOSTS_DRY_RUN=1
node bin/bus/ghosts.js` prints but does not post.

---

## Step 1 — Bug A: index every polled bus route, not just `bunching`

**Root cause:** `scripts/fetch-gtfs.js:20` imports only `bunching` into
`BUS_ROUTES`. Route 50 is in `ghosts` but not `bunching`, so
`data/gtfs/index.json` has no entry for it and `busLookup('50', …)` returns
`null`, silently skipping the route.

**Fix:**

1. In `scripts/fetch-gtfs.js`, replace the import at line 20 with a union of
   all polled bus-route lists:

   ```js
   const { bunching, ghosts, gaps, speedmap } = require('../src/bus/routes');
   const BUS_ROUTES = [...new Set([...bunching, ...ghosts, ...gaps, ...speedmap])];
   ```

   Including `speedmap` is free — it's a small extra surface and keeps the
   rule "if we ever poll it, we index it." Log the resolved list at startup
   so future additions are visible in the cron log:

   ```js
   console.log(`Indexing ${BUS_ROUTES.length} bus routes: ${BUS_ROUTES.sort().join(', ')}`);
   ```

2. Add a startup guard in both ghost bins. At the top of `main()` in
   `bin/bus/ghosts.js` and `bin/bus/gaps.js` (gaps shares the same hazard):

   ```js
   const { loadIndex } = require('../../src/shared/gtfs');
   const index = loadIndex();
   const unindexed = ghostRoutes.filter((r) => !index.routes[r]);
   if (unindexed.length) {
     console.warn(`Skipping routes without GTFS index: ${unindexed.join(', ')} — re-run fetch-gtfs.js`);
   }
   ```

   Keep the existing behavior (skip silently inside `busLookup`) as the
   backstop, but at least the job log makes the gap visible.

3. Re-run `node scripts/fetch-gtfs.js` on the server once the change ships,
   so `data/gtfs/index.json` picks up Route 50.

**Test (new, in `test/shared/gtfs.test.js` or a new `test/bus/routes.test.js`):**

```js
test('every route in ghosts/gaps is also present in the GTFS index', () => {
  const { loadIndex } = require('../../src/shared/gtfs');
  const { ghosts, gaps } = require('../../src/bus/routes');
  const idx = loadIndex();
  const missing = [...new Set([...ghosts, ...gaps])].filter((r) => !idx.routes[r]);
  assert.deepEqual(missing, []);
});
```

This turns the "route added without re-indexing" footgun into a red CI.

**Files touched:** `scripts/fetch-gtfs.js`, `bin/bus/ghosts.js`,
`bin/bus/gaps.js`, new test.

---

## Step 2 — Bug B: fail the whole route if any pid fails pattern resolution

**Root cause:** `src/bus/ghosts.js:52–59` silently drops observations whose
pid has no resolvable pattern. The GTFS-derived `expectedActive` still
counts trips that served that pattern, so observed < expected → ghost.

**Fix:** switch from per-observation drop to per-route skip-on-failure.

In `src/bus/ghosts.js`, replace the current pid-resolution loop (lines
37–59) with something like:

```js
const pids = [...new Set(obs.map((o) => o.direction).filter(Boolean))];
const patternByPid = new Map();
const failedPids = [];
for (const pid of pids) {
  try {
    const p = await getPattern(pid);
    if (p && p.direction) {
      patternByPid.set(pid, p);
    } else {
      failedPids.push(pid);
    }
  } catch (e) {
    failedPids.push(pid);
    console.warn(`ghosts: pattern fetch failed for pid ${pid}: ${e.message}`);
  }
}

// Any pid that has observations in the window but no resolvable pattern
// makes the observed count untrustworthy for this route. Skip rather than
// risk a false positive.
const observedPidsWithRows = new Set();
for (const o of obs) if (o.direction) observedPidsWithRows.add(o.direction);
const droppedWithObs = failedPids.filter((p) => observedPidsWithRows.has(p));
if (droppedWithObs.length) {
  console.warn(`ghosts: skipping route ${route} — unresolved pids with observations: ${droppedWithObs.join(', ')}`);
  continue;
}
```

(`continue` is the outer `for (const route of routes)` loop.)

Also: count observations dropped because `pattern.direction` is falsy the
same way — any pattern that loads but has no `rtdir` is a "resolved pid
with unusable direction label." Treat it identically to a fetch failure.

**Secondary fix in `src/bus/patterns.js`:**

Currently `loadPattern` writes the response to disk on success, but on
failure it throws — the next call re-fetches. That's correct behavior, so
no change needed. However, the cache TTL is 24h; consider adding a
short-circuit retry for transient failures: if `getPattern` throws, wait
250ms and retry once before propagating. This keeps a single flaky CTA
call from killing a whole hour's detection.

```js
async function loadPattern(pid) {
  Fs.ensureDirSync(CACHE_DIR);
  const cachePath = Path.join(CACHE_DIR, `${pid}.json`);
  if (Fs.existsSync(cachePath)) {
    const age = Date.now() - Fs.statSync(cachePath).mtimeMs;
    if (age < TTL_MS) return Fs.readJsonSync(cachePath);
  }
  let pattern;
  try {
    pattern = await getPattern(pid);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 250));
    pattern = await getPattern(pid); // re-throws if still failing
  }
  pattern.signature = patternSignature(pattern);
  Fs.writeJsonSync(cachePath, pattern);
  return pattern;
}
```

**Tests (append to `test/ghosts.test.js`):**

```js
test('skips a route entirely when any observed pid fails pattern resolution', async () => {
  const obs = [
    ...buildObs({ pid: 'good', snapshots: 12, vidsPerSnapshot: 3 }),
    ...buildObs({ pid: 'broken', snapshots: 12, vidsPerSnapshot: 3 }),
  ];
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async (pid) => {
      if (pid === 'broken') throw new Error('CTA down');
      return mkPattern('Eastbound');
    },
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});

test('skips a route when a pid resolves to pattern with no direction label', async () => {
  const obs = buildObs({ pid: 'headless', snapshots: 12, vidsPerSnapshot: 3 });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => ({ pid: 'headless', direction: '', route: '66' }),
    expectedHeadway: () => 6,
    expectedDuration: () => 60,
  });
  assert.equal(events.length, 0);
});
```

**Files touched:** `src/bus/ghosts.js`, `src/bus/patterns.js`,
`test/ghosts.test.js`.

---

## Step 3 — Bug C: re-introduce dominant-origin filter for buses, but day-level (not per-hour)

**Root cause:** `scripts/fetch-gtfs.js` (after `775a151`) lets every origin
for a `(route, dir)` contribute to the per-hour headway buckets. When a
route has a garage pullout origin staggered with the main terminal, the
median of consecutive departure gaps collapses below the rider-facing
headway, inflating `expectedActive = duration / headway`.

**Design:** apply the same treatment as rail (`ea953a5`) but tuned so the
Route 55 EB 2 AM regression (`775a151`) doesn't return. The Route 55
regression was caused by *per-hour* origin dominance — an hour with few
trips could pick a non-representative dominant origin and drop everything
else. Day-level dominance is safer: one origin per `(route, dir)` for the
whole day, chosen across the full day's trip count.

**Fix in `scripts/fetch-gtfs.js`:**

Add a bus origin-dominance pass symmetric to `railDominantOrigin`
(lines 243–261) but keyed on `(route, dir)` only:

```js
const busOriginCounts = new Map(); // route|dir → Map(stopId → count)
for (const [tripId, meta] of tripMeta) {
  if (meta.mode !== 'bus') continue;
  const origin = firstStopId.get(tripId);
  if (!origin) continue;
  const k = `${meta.route}|${meta.dir}`;
  if (!busOriginCounts.has(k)) busOriginCounts.set(k, new Map());
  const m = busOriginCounts.get(k);
  m.set(origin, (m.get(origin) || 0) + 1);
}
const busDominantOrigin = new Map();
for (const [k, counts] of busOriginCounts) {
  let best = null;
  let bestCount = -1;
  let total = 0;
  for (const [stopId, c] of counts) { total += c; if (c > bestCount) { bestCount = c; best = stopId; } }
  // Safety: only filter if dominance is clear. If no origin has ≥60% share,
  // keep all origins — means this route doesn't have a single "canonical"
  // origin and filtering would do more harm than good. Log so we can
  // investigate surprising exclusions.
  if (best && bestCount / total >= 0.6) busDominantOrigin.set(k, best);
  else console.log(`bus ${k}: no dominant origin (top=${bestCount}/${total}) — keeping all origins`);
}
```

Then, inside the main trip bucketing loop (around line 273–307), add the
filter:

```js
if (meta.mode === 'bus') {
  const domOrigin = busDominantOrigin.get(`${meta.route}|${meta.dir}`);
  if (domOrigin && firstStopId.get(tripId) !== domOrigin) continue;
}
```

The `≥60%` threshold is the guardrail against the Route 55 2 AM regression:
when origins are genuinely mixed, we keep all of them and accept slightly
noisier headways rather than drop 80% of trips.

**Verification:** after the change, compare `index.json` diffs for routes
we've seen report ghosting today. Expected: their per-hour headways *widen*
(larger numbers), making `expectedActive` smaller and fewer ghost posts.

Add a verification script under `scripts/diff-gtfs-index.js`:
- Loads the pre-change and post-change index files
- For each `(route, dir, dayType, hour)` prints
  `{ before: medHw, after: medHw, delta }` sorted by absolute delta
- Flags any bucket where `|delta| > 3 min`

Run it once, sanity-check that no "real" schedule shifted by >3 min unless
the route actually had a known short-turn/garage issue, then commit the
new index.

**Tests:** add a fixture-based test under `test/shared/fetch-gtfs.test.js`
that feeds synthetic trips (two origins, staggered) and asserts the
bucketed median gap matches the main-origin-only expectation. Keep it
narrow — full-pipeline tests against CTA data live on the server.

**Files touched:** `scripts/fetch-gtfs.js`, `scripts/diff-gtfs-index.js`
(new), `test/shared/fetch-gtfs.test.js` (new).

---

## Step 4 — Bug F: consume `calendar_dates.txt` for holiday service

**Root cause:** `scripts/fetch-gtfs.js:120–135` reads only `calendar.txt`.
Holidays (CTA uses the "add for this date / remove for that date" pattern)
produce a service_id active only for specific dates, which won't match any
day-of-week bitmap. On those days, the index reflects the *regular* weekday
schedule, but observations reflect holiday service → mass ghosts.

**Fix in `scripts/fetch-gtfs.js`:**

Today (April 22) isn't a holiday so we can land this code safely, but the
next holiday is Memorial Day 2026-05-25 — needs to be in place well before.

```js
// After reading calendar.txt, also read calendar_dates.txt for today.
console.log('Reading calendar_dates.txt...');
const exceptions = parseCsv(await readFromZip('calendar_dates.txt'));
const addForToday = new Set();    // service_ids to force-include
const removeForToday = new Set(); // service_ids to force-exclude
for (const r of exceptions) {
  if (r.date !== todayStr) continue;
  if (r.exception_type === '1') addForToday.add(r.service_id);
  else if (r.exception_type === '2') removeForToday.add(r.service_id);
}
```

Then when building `serviceDayType`:

```js
for (const c of calendars) {
  const dt = dayTypeFor(c);
  if (!dt) continue;
  // calendar.txt active if date range covers today AND not explicitly removed.
  const inRange = todayStr >= c.start_date && todayStr <= c.end_date;
  if (!inRange || removeForToday.has(c.service_id)) continue;
  serviceDayType.set(c.service_id, dt);
}
// Force-add: for service_ids that only appear via calendar_dates, map them
// to the current wall-clock dayType so per-hour dominance can still select
// against them.
if (addForToday.size) {
  const fallbackDt = (() => {
    const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(today);
    if (w === 'Sat') return 'saturday';
    if (w === 'Sun') return 'sunday';
    return 'weekday';
  })();
  for (const sid of addForToday) {
    if (!serviceDayType.has(sid)) serviceDayType.set(sid, fallbackDt);
  }
}
console.log(`  +${addForToday.size} added / -${removeForToday.size} removed via calendar_dates`);
```

**Tradeoff:** the index becomes date-specific — it represents *today*, not
a week. That's already true for the calendar-range filter introduced in
`775a151`. Solidify the contract: the index is valid for one service day.
The existing `STALE_MS = 30d` warn-only window is too lax; tighten it.

- In `src/shared/gtfs.js:6`, change `STALE_MS` to `2 * 24 * 60 * 60 * 1000`
  (48h). If the index is older than 48h, warn loudly but continue.
- Add a hard ceiling at 7 days: if the index is older than 7d, return `null`
  from `loadIndex()` or throw — caller in `bin/*/ghosts.js` already skips
  on null schedule. Prefer logging + process exit in the bin so the cron
  job FAILS visibly rather than silently under-reporting.
- Server cron must run `fetch-gtfs.js` daily. Document this in README.

**Test:** a fixture for `parseCsv` on a synthetic `calendar_dates.txt` and
assertions on the `serviceDayType` map.

**Files touched:** `scripts/fetch-gtfs.js`, `src/shared/gtfs.js`, README.

---

## Step 5 — Bug G: resolve bus pattern direction using both endpoints

**Root cause:** `src/shared/gtfs.js:73–96` picks `direction_id` by nearest
GTFS terminal to the pattern's last point. For short-turn patterns that
end mid-route, the last point is closer to whichever terminal is closer
spatially, which may not match the pattern's operational direction.

**Fix:** compare pattern *origin* (first point) against *origin terminal*
of each GTFS direction, and pattern *last point* against *end terminal*,
and pick the direction with the smaller sum. Requires the index to store
origin terminals, not just end terminals.

1. In `scripts/fetch-gtfs.js`, in the loop around lines 295–307, also
   record the origin terminal:

   ```js
   if (!lastStopSample.has(rdKey)) {
     const lastStopIdVal = lastStopId.get(tripId);
     const firstStopIdVal = firstStopId.get(tripId);
     const endStop = lastStopIdVal && byStopId.get(lastStopIdVal);
     const startStop = firstStopIdVal && byStopId.get(firstStopIdVal);
     if (endStop) {
       lastStopSample.set(rdKey, {
         lat: parseFloat(endStop.stop_lat),
         lon: parseFloat(endStop.stop_lon),
         originLat: startStop ? parseFloat(startStop.stop_lat) : null,
         originLon: startStop ? parseFloat(startStop.stop_lon) : null,
         headsign: meta.headsign,
       });
     }
   }
   ```

   Thread `originLat`/`originLon` into the output bucket at
   `fetch-gtfs.js:328–334`.

2. In `src/shared/gtfs.js:73–96`, compare both endpoints:

   ```js
   function resolveDirection(pattern) {
     const cached = _directionCache.get(pattern.pid);
     if (cached) return cached;
     const index = loadIndex();
     const byDir = index.routes[pattern.route];
     if (!byDir) return null;
     const first = pattern.points[0];
     const last = pattern.points[pattern.points.length - 1];
     let best = null;
     let bestScore = Infinity;
     for (const dir of ['0', '1']) {
       const info = byDir[dir];
       if (!info || info.terminalLat == null) continue;
       const endDist = haversineFt({ lat: info.terminalLat, lon: info.terminalLon }, last);
       const originDist = info.originLat != null
         ? haversineFt({ lat: info.originLat, lon: info.originLon }, first)
         : 0;
       const score = endDist + originDist;
       if (score < bestScore) { bestScore = score; best = dir; }
     }
     if (best) _directionCache.set(pattern.pid, best);
     return best;
   }
   ```

   For short-turns, origin-dist dominates the score and forces the right
   direction even when end-dist would mislead.

**Test:** a case in `test/shared/gtfs.test.js` with two synthetic GTFS
directions (opposite ends of a line) and two patterns (one full-length,
one short-turn) that both correctly resolve.

**Files touched:** `scripts/fetch-gtfs.js`, `src/shared/gtfs.js`,
`test/shared/gtfs.test.js`.

---

## Step 6 — Bug H: train direction proxy should prefer true-terminal destinations

**Root cause:** `src/train/ghosts.js:87` uses `group.find((o) => o.destination)?.destination`,
which is the first observation's destination. Short-turns leak in.

**Fix:** pick the destination whose matched station is a known terminal,
falling back to farthest-from-midpoint if no terminal match exists.

1. Add a list of known rail terminals to
   `src/train/data/trainStations.json` — or mark existing entries with
   `isTerminal: true`. A terminal is any station that appears as
   `end-of-line` for at least one `line` on itself.

2. In `src/train/ghosts.js`, replace the sample-destination logic:

   ```js
   const destinations = [...new Set(group.map((o) => o.destination).filter(Boolean))];
   let bestDest = null;
   for (const d of destinations) {
     const s = findStation(line, d);
     if (s && s.isTerminal) { bestDest = d; break; }
   }
   if (!bestDest) bestDest = destinations[0] || null;
   const destStation = bestDest ? findStation(line, bestDest) : null;
   ```

   If no terminal match is found, **skip the direction rather than pick a
   short-turn destination** — the resulting `expectedActive` would be
   unreliable, and safety > coverage.

**Files touched:** `src/train/data/trainStations.json`,
`src/train/ghosts.js`, `src/train/findStation.js` (if terminal flag needs
propagation), `test/ghosts.test.js`.

---

## Step 7 — Bug I: tighten `findStationByDestination` matching

**Root cause:** the fuzzy `startsWith`/`includes` logic in
`src/train/findStation.js:15` can cross-match station names.

**Fix:**
- Drop the `baseName.startsWith(norm) || norm.startsWith(baseName)` tier.
- Add a known-aliases map for the handful of destination strings CTA uses
  that don't match station names verbatim:

  ```js
  const DESTINATION_ALIASES = {
    '95th/dan ryan': '95th',
    '54th/cermak': '54th/Cermak',
    'loop': null, // loop destinations don't resolve to a terminal station
    'see train': null,
    // extend as we observe unmatched destinations in logs
  };
  ```
- If alias yields `null`, return `null` up front — callers already handle
  this and skip the direction.
- Log any unmatched destination once per process so new aliases surface in
  the cron log.

**Files touched:** `src/train/findStation.js`, `test/ghosts.test.js` or new
`test/train/findStation.test.js`.

---

## Step 8 — Bug J: sanitize "effective headway" display

**Root cause:** `bin/bus/ghosts.js:32` and `bin/train/ghosts.js:25` compute
`effectiveHeadway = headway * (expected / observed)`. When observed is 1,
the ratio becomes huge.

**Fix:** cap the display at the max of actual scheduled gap × 4, or drop
the "instead of ~X min" clause when the ratio > 3. Better: reword to
"scheduled every ~X min" without the effective-headway estimate.

```js
const ratio = event.expectedActive / Math.max(event.observedActive, 1);
const scheduledHeadway = Math.round(event.headway);
const effective = ratio > 3
  ? null
  : Math.round(event.headway * ratio);
const suffix = effective == null
  ? `scheduled every ~${scheduledHeadway} min`
  : `every ~${effective} min instead of ~${scheduledHeadway}`;
return `🚌 ${title} ${dir} · ${missing} of ${expected} missing (${pct}%) · ${suffix}`;
```

Purely presentational; no test changes required, but add a quick snapshot
test verifying the ratio > 3 branch.

**Files touched:** `bin/bus/ghosts.js`, `bin/train/ghosts.js`,
`test/ghosts.test.js`.

---

## Step 9 — Add a "sanity gate" after existing thresholds

**Goal:** a last-line-of-defense sanity check, on top of all the
correctness fixes above. This is the belt for the suspenders.

In `src/bus/ghosts.js` (and mirrored in `src/train/ghosts.js`), after
computing `missing` but before pushing the event, require:

1. **Minimum observed floor**: `observedActive >= 2`. A route reported as
   "missing 7 of 9" when observed is 0 or 1 is either a schedule bug or a
   real outage so extreme the gap-detector would already flag it. Don't
   post.
2. **Coverage floor**: `perSnapshot.size` over the window should be ≥ 8
   (up from 6). At a 5-min observer cadence, the window holds ~12 snapshots;
   ≥ 8 guarantees we lost at most 4 polls.
3. **Stability floor**: compute stddev of per-snapshot counts. If the
   stddev exceeds `observedActive`, the route's live coverage is too
   noisy to trust (polling blackouts masquerading as missing vehicles).
4. **Direction-count sanity**: `expectedActive` cap at a hard ceiling of
   30. If the schedule computes higher, log and skip — that indicates a
   bad GTFS bucket (e.g., garage-pullout-driven 1-min median from Bug C
   we haven't caught).

```js
if (observedActive < 2) continue;
if (perSnapshot.size < 8) continue;
const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
const stddev = Math.sqrt(variance);
if (stddev > observedActive) continue;
if (expectedActive > 30) { console.warn(`ghosts: ${route}/${direction} expected=${expectedActive} exceeds cap — likely schedule-index bug`); continue; }
```

Bump `MIN_SNAPSHOTS` to 8 in `src/bus/ghosts.js:7`.

**Tests:** extend `test/ghosts.test.js` with cases that trigger each of the
four gates and verify no event is produced.

**Files touched:** `src/bus/ghosts.js`, `src/train/ghosts.js`,
`test/ghosts.test.js`.

---

## Step 10 — Shadow run and cleanup

**Shadow run:** with `GHOSTS_DRY_RUN=1` from Step 0 still set, let the
hourly cron run for 48 hours. For each hour's logs:
- Confirm no route fires that wouldn't fire under a hand-check (compare to
  CTA's own service alerts / Twitter reports).
- Spot-check routes that fire — do they match "heavy ghosting" reports
  anecdotally, or are they still the multi-origin culprits from Bug C?

**Metrics to record** (stdout grepable, no infra needed):
- Count of routes skipped due to: no index, pattern-resolution failure,
  expected-active < 2, stddev check, expected-active cap.
- Count of events emitted.
- Ratio of (events emitted) / (routes processed) per hour.

Aim: <1 event per 24 hours during normal operations. If the shadow run
shows more, investigate before unsetting `GHOSTS_DRY_RUN`.

**Cleanup:**
- Unset `GHOSTS_DRY_RUN` in `.env`.
- Remove the env check from the bins (or keep as a documented kill switch —
  probably keep).
- Remove `STALE_MS` warn if we decided to make staleness fatal in Step 4;
  otherwise leave.

---

## Step 11 — Lower-priority follow-ups (not blocking deployment)

These are from the report but not in the critical bulletproofing path.
Land after Step 10 if any show up in shadow-run logs.

- **Bug D** (ts-keyed snapshots split across crons): switch `perSnapshot`
  from exact-ts key to "bin-to-nearest-60s" key. Observations recorded
  within 60s of each other count as one snapshot. Reduces noise in median
  and stabilizes the coverage floor from Step 9.
- **Bug E** (unconditional prior-day fallback): scope the fallback to
  strictly `hour < LATE_NIGHT_CUTOFF_HOUR` cases, plus an explicit
  "dayType-matches" guard. Low value outside late-night.
- **Bug K** (cadence sanity): in `rolloffOldObservations` or a new helper,
  assert `ts` spacing for the ghost window — if mean gap > 12 min,
  something's wrong with the observer cron. Fail the job rather than
  post bad data.
- **Bug L** (loop-line layover undercount): subtract a flat 3-min layover
  from `duration` before computing `expectedActive` for loop lines. Small
  tweak, visible benefit on Brown/Pink.
- **Bug M** (rail origin-dominance drift during construction reroutes):
  add a monthly reconciliation script that prints the current
  `railDominantOrigin` table and flags any `(route, dir)` whose dominant
  origin isn't in a hand-curated canonical-terminals list.

---

## Summary of files touched (by step)

| Step | Files |
|---|---|
| 0 | `bin/bus/ghosts.js`, `bin/train/ghosts.js` |
| 1 | `scripts/fetch-gtfs.js`, `bin/bus/ghosts.js`, `bin/bus/gaps.js`, `test/shared/gtfs.test.js` (or new test) |
| 2 | `src/bus/ghosts.js`, `src/bus/patterns.js`, `test/ghosts.test.js` |
| 3 | `scripts/fetch-gtfs.js`, `scripts/diff-gtfs-index.js` (new), `test/shared/fetch-gtfs.test.js` (new) |
| 4 | `scripts/fetch-gtfs.js`, `src/shared/gtfs.js`, `README.md` |
| 5 | `scripts/fetch-gtfs.js`, `src/shared/gtfs.js`, `test/shared/gtfs.test.js` |
| 6 | `src/train/data/trainStations.json`, `src/train/ghosts.js`, `src/train/findStation.js`, `test/ghosts.test.js` |
| 7 | `src/train/findStation.js`, `test/train/findStation.test.js` (new) |
| 8 | `bin/bus/ghosts.js`, `bin/train/ghosts.js`, `test/ghosts.test.js` |
| 9 | `src/bus/ghosts.js`, `src/train/ghosts.js`, `test/ghosts.test.js` |
| 10 | none — observation only |

---

## Shipping order / dependencies

```
Step 0 (kill switch)
  └─► Steps 1, 4 (indexer fixes — re-run fetch-gtfs.js after each)
  └─► Step 2 (observation-side correctness)
  └─► Step 3 (indexer — re-run fetch-gtfs.js after)
  └─► Steps 5, 6, 7 (direction resolution)
  └─► Step 8 (display)
  └─► Step 9 (final sanity gate)
  └─► Step 10 (shadow-run validation)
  └─► Step 11 (follow-ups)
```

Steps 1, 2, 3, 4 can ship independently. Steps 5–8 can ship independently
after 1–4. Step 9 depends on 1–8 landing so we don't mask bugs that 1–8
would fix. Step 10 is the final gate.

Deploy cadence: one step per commit. After each indexer-changing step (1,
3, 4, 5), re-run `node scripts/fetch-gtfs.js` on the server and commit the
regenerated `data/gtfs/index.json` so cron jobs read the new index.

---

## Non-goals

- We are **not** auto-indexing all 124 CTA bus routes. The polled-route
  union keeps the index narrow and makes unexpected additions visible in
  the cron log.
- We are **not** removing the `bunching`/`ghosts`/`gaps`/`speedmap` list
  split in `src/bus/routes.js`. Each list has independent tuning concerns
  (coverage vs density); merging them would regress other features.
- We are **not** rewriting the ghost detector as a streaming/online
  algorithm. The hourly-rollup batch model is the right shape for this
  problem and the failure modes above are all addressable without changing
  the architecture.
