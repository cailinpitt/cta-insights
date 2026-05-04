const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIndex } = require('../../src/shared/gtfs');
const { ghosts, gaps, allRoutes, names } = require('../../src/bus/routes');

// Gaps and ghosts both *require* GTFS lookups (headway/expected-active gates)
// — a missing index entry there silently disables detection. allRoutes is
// broader (includes seasonal variants that CTA omits from the published GTFS
// feed); pulse tolerates missing entries by skipping the route, so it's not
// asserted here.
test('every gap/ghost-polled bus route is present in the GTFS index', () => {
  const idx = loadIndex();
  const polled = [...new Set([...ghosts, ...gaps])];
  const missing = polled.filter((r) => !idx.routes[r]);
  assert.deepEqual(missing, [], `re-run scripts/fetch-gtfs.js to index: ${missing.join(', ')}`);
});

// Night Owl routes that shadow a daytime number (N87 ↔ 87, N22 ↔ 22, …) are
// excluded from polling: CTA's getvehicles reports overnight vehicles under
// the daytime route_id, so the N-variant only ever returns "no data found".
// N5 is the exception — no daytime "5" exists, so CTA tracks it as its own
// route. Guards against accidental re-introduction of dead N* polling.
test('allRoutes excludes shadowed Night Owl routes but keeps N5', () => {
  const nightInList = allRoutes.filter((r) => /^N\d/.test(r));
  assert.deepEqual(nightInList, ['N5']);
  // Sanity: every excluded N* is still present in `names` for alert display.
  const excluded = Object.keys(names).filter((r) => /^N\d/.test(r) && r !== 'N5');
  assert.ok(excluded.length > 0, 'expected at least one shadowed N* route in names');
  for (const r of excluded) assert.ok(names[r], `${r} should remain in names map`);
});
