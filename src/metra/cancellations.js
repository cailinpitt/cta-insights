// Metra cancellation detection — the flagship Phase 2 detector and the analog of
// CTA "ghost" service. Two layers, mirroring the CTA model (official alert +
// bot-inferred pulse):
//
//   - CONFIRMED  — Metra says so: a trip whose GTFS-realtime TripDescriptor
//     carries schedule_relationship = CANCELED. Authoritative.
//   - INFERRED   — Metra is silent, but the schedule disagrees with reality: a
//     scheduled trip whose departure passed by a grace margin with NO vehicle
//     ever observed, NO live prediction, NO CANCELED flag, and NO covering alert.
//     This is the true "ghost" — a train that should be running but isn't, that
//     Metra never flagged. Posted with hedged framing.
//
// Pure function — the bin gathers the inputs (feed, schedule index, observations)
// and persists/posts. The inferred layer is FP-prone (like CTA pulse), so it's
// gated behind a feed-health check: if the whole Metra feed stalled, every trip
// looks unobserved and we must NOT read that as mass cancellation.

// A train that has neither reported a position nor produced a live prediction
// this long after its scheduled departure is almost certainly not running.
// Conservative on purpose — Metra trains normally start emitting GPS at/just
// before departure, so 15 min clears ordinary feed-start lag without inferring
// a ghost for a merely-late train. Tunable.
const DEFAULT_GRACE_MS = 15 * 60 * 1000;

// Classify scheduled/observed trips into confirmed + inferred cancellations.
// Inputs (all injected by the bin so this stays unit-testable):
//   canceledTrips        [{tripId, route, ...schedule fields}] already CANCELED-flagged + enriched
//   candidateTrips       [{tripId, route, scheduledDepMs, ...}] scheduled in the inferred window
//   observedTripIds      Set<tripId> that had a vehicle position today
//   livePredictionTripIds Set<tripId> currently producing real (non-NO_DATA) predictions
//   alertCoveredTripIds  Set<tripId> named by an active alert (optional)
//   feedHealthy          bool — when false, the inferred layer is suppressed
function detectCancellations({
  canceledTrips = [],
  candidateTrips = [],
  observedTripIds = new Set(),
  livePredictionTripIds = new Set(),
  alertCoveredTripIds = new Set(),
  now = Date.now(),
  graceMs = DEFAULT_GRACE_MS,
  feedHealthy = true,
}) {
  const canceledIds = new Set(canceledTrips.map((t) => t.tripId));
  const confirmed = canceledTrips.map((t) => ({ ...t, source: 'cancellation' }));

  let inferred = [];
  if (feedHealthy) {
    inferred = candidateTrips
      .filter((t) => t.scheduledDepMs < now - graceMs)
      .filter((t) => !canceledIds.has(t.tripId))
      .filter((t) => !observedTripIds.has(t.tripId))
      .filter((t) => !livePredictionTripIds.has(t.tripId))
      .filter((t) => !alertCoveredTripIds.has(t.tripId))
      .map((t) => ({ ...t, source: 'cancellation-inferred' }));
  }

  return { confirmed, inferred };
}

// Feed-health guard for the inferred layer. Given the distinct snapshot
// timestamps the Metra feed produced over the recent window, the feed is healthy
// when (a) the newest snapshot is fresh and (b) there's no long gap in the
// window — i.e. observeMetra has been delivering data continuously. A fleet-wide
// stall (upstream outage or observeMetra down) makes every trip look unobserved,
// so when this returns false the bin suppresses inferred cancellations.
function isFeedHealthy(
  snapshotTimestamps,
  now = Date.now(),
  { maxStaleMs = 5 * 60 * 1000, windowMs = 30 * 60 * 1000, maxGapMs = 8 * 60 * 1000 } = {},
) {
  const ts = [...snapshotTimestamps].filter((t) => t >= now - windowMs).sort((a, b) => a - b);
  if (ts.length === 0) return false;
  if (now - ts[ts.length - 1] > maxStaleMs) return false; // stale: nothing fresh
  // Gap from window start through each snapshot to now must stay under maxGapMs.
  let prev = now - windowMs;
  for (const t of ts) {
    if (t - prev > maxGapMs) return false;
    prev = t;
  }
  if (now - prev > maxGapMs) return false;
  return true;
}

module.exports = { detectCancellations, isFeedHealthy, DEFAULT_GRACE_MS };
