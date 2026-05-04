// Quote-attaches relevant analytics-bot bunching/gap posts into the alerts
// account's existing alert/observation threads. Strict relevance: route+
// direction+segment must all line up — better to miss than to mis-attach.
//
// Anchors enumerated each tick:
//   - alert_posts (CTA alerts) with resolved_ts NULL and post_uri set;
//     affected_from/to/direction populated at insert time.
//   - bus_pulse_state with active_post_uri NOT NULL AND affected_pid NOT NULL
//     (held-cluster observations; blackouts never anchor — no segment).
//   - pulse_state with active_post_uri NOT NULL (train pulse observations).
//
// Anchors that share a thread root are merged into one work item: routes are
// unioned, lead window taken from the earliest anchor, the cap-of-3 applies
// once per thread root.

const {
  listUnresolvedAlerts,
  listActiveBusPulseAnchors,
  listActiveTrainPulseAnchors,
  findRelatedAnalyticsPosts,
  recordThreadQuote,
  getThreadQuotedSourceUris,
} = require('./history');
const { getPostRecord, postQuote } = require('./bluesky');
const { isStationOnSegment } = require('./trainSegment');
const { resolveStopOnRoute } = require('../bus/patterns');

const LEAD_MS = 30 * 60 * 1000;
const MAX_QUOTES_PER_THREAD = 3;
const QUOTE_TEXT = 'Related observation:';
const TRAIN_BUFFER_STOPS = 1;
const BUS_BUFFER_FT = 2640; // ½ mile

function isEnabled() {
  return process.env.QUOTE_RELATED_POSTS !== '0';
}

// Resolve every anchor to its thread root and group. Each work item ends up
// with: { rootUri, rootCid, anchorUris[], routes: Set, earliestTs, kind,
// trainSegments[], busSegments[] }.
async function buildWorkItems({ kind, agent, now }) {
  const anchors = [];

  // CTA alerts
  for (const a of listUnresolvedAlerts(kind)) {
    if (!a.post_uri) continue;
    const routes = (a.routes || '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    anchors.push({
      kind,
      postUri: a.post_uri,
      routes,
      ts: a.first_seen_ts,
      trainSegment:
        kind === 'train' && a.affected_from_station && a.affected_to_station && routes.length === 1
          ? {
              line: routes[0],
              direction: a.affected_direction || null,
              from: a.affected_from_station,
              to: a.affected_to_station,
            }
          : null,
      // Bus alert segments resolved lazily inside relevance check (need pid +
      // pdist via loadPattern).
      busAlertSegment:
        kind === 'bus' && a.affected_from_station && a.affected_to_station
          ? {
              routes,
              from: a.affected_from_station,
              to: a.affected_to_station,
              direction: a.affected_direction || null,
            }
          : null,
    });
  }

  // Observation pulse anchors
  if (kind === 'train') {
    for (const a of listActiveTrainPulseAnchors()) {
      if (!a.active_post_uri) continue;
      anchors.push({
        kind,
        postUri: a.active_post_uri,
        routes: [a.line],
        ts: a.started_ts || now,
        trainSegment:
          a.from_station && a.to_station
            ? {
                line: a.line,
                direction: a.direction || null,
                from: a.from_station,
                to: a.to_station,
              }
            : null,
        busAlertSegment: null,
      });
    }
  } else if (kind === 'bus') {
    for (const a of listActiveBusPulseAnchors()) {
      anchors.push({
        kind,
        postUri: a.active_post_uri,
        routes: [a.route],
        ts: a.started_ts || now,
        trainSegment: null,
        busHeldSegment:
          a.affected_pid != null
            ? {
                pid: String(a.affected_pid),
                loFt: a.affected_lo_ft,
                hiFt: a.affected_hi_ft,
              }
            : null,
        busAlertSegment: null,
      });
    }
  }

  // Resolve each anchor's thread root via Bluesky getRecord (may fail if the
  // post was deleted — drop those silently).
  const groups = new Map();
  for (const anchor of anchors) {
    const rec = await getPostRecord(agent, anchor.postUri);
    if (!rec) continue;
    const rootUri = rec.replyRoot?.uri || anchor.postUri;
    const rootCid = rec.replyRoot?.cid || rec.cid;
    let g = groups.get(rootUri);
    if (!g) {
      g = {
        kind,
        rootUri,
        rootCid,
        latestPostUri: anchor.postUri,
        latestPostCid: rec.cid,
        latestTs: anchor.ts || 0,
        routes: new Set(),
        earliestTs: anchor.ts || now,
        trainSegments: [],
        busHeldSegments: [],
        busAlertSegments: [],
      };
      groups.set(rootUri, g);
    }
    for (const r of anchor.routes) g.routes.add(r);
    if (anchor.ts && anchor.ts < g.earliestTs) g.earliestTs = anchor.ts;
    if ((anchor.ts || 0) > g.latestTs) {
      g.latestTs = anchor.ts || 0;
      g.latestPostUri = anchor.postUri;
      g.latestPostCid = rec.cid;
    }
    if (anchor.trainSegment) g.trainSegments.push(anchor.trainSegment);
    if (anchor.busHeldSegment) g.busHeldSegments.push(anchor.busHeldSegment);
    if (anchor.busAlertSegment) g.busAlertSegments.push(anchor.busAlertSegment);
  }
  return [...groups.values()];
}

// Train relevance: station name from the analytics post must lie on at least
// one of the group's train segments (CTA alerts and pulse observations both
// produce train segments).
function trainCandidateRelevant(candidate, group) {
  if (group.trainSegments.length === 0) return false;
  for (const seg of group.trainSegments) {
    if (candidate.route !== seg.line) continue;
    // Direction filter — skip when either side lacks direction info, drop
    // when both present and don't agree (compass vs branch trDr — handled in
    // isStationOnSegment via COMPASS_TO_HINT; here we just pass it through).
    const onSeg = isStationOnSegment({
      line: seg.line,
      direction: seg.direction || null,
      station: candidate.near_stop,
      fromStation: seg.from,
      toStation: seg.to,
      bufferStops: TRAIN_BUFFER_STOPS,
    });
    if (onSeg) return true;
  }
  return false;
}

async function busCandidateRelevant(candidate, group, getKnownPidsForRoute, loadPattern) {
  if (!candidate.near_stop) return false;
  // Held-cluster observation: pid + pdist range known precisely.
  for (const seg of group.busHeldSegments) {
    if (candidate.direction && String(candidate.direction) !== seg.pid) continue;
    const resolved = await resolveStopOnRoute({
      pids: [seg.pid],
      loadPattern,
      stopName: candidate.near_stop,
    });
    if (!resolved) continue;
    if (
      seg.loFt != null &&
      seg.hiFt != null &&
      resolved.pdist >= seg.loFt - BUS_BUFFER_FT &&
      resolved.pdist <= seg.hiFt + BUS_BUFFER_FT
    ) {
      return true;
    }
  }
  // CTA bus alert with extracted from/to. Resolve from/to and candidate's
  // near_stop on the same pid; require all three to land + candidate within
  // [min, max] ± buffer. Try each pid the route knows about.
  for (const seg of group.busAlertSegments) {
    if (!seg.routes.includes(candidate.route)) continue;
    const pids = getKnownPidsForRoute(candidate.route) || [];
    if (candidate.direction) {
      // Prefer the candidate's pid (its `direction` field IS the pid for buses).
      pids.unshift(String(candidate.direction));
    }
    for (const pid of pids) {
      const fromStop = await resolveStopOnRoute({ pids: [pid], loadPattern, stopName: seg.from });
      if (!fromStop) continue;
      const toStop = await resolveStopOnRoute({ pids: [pid], loadPattern, stopName: seg.to });
      if (!toStop) continue;
      const cand = await resolveStopOnRoute({
        pids: [pid],
        loadPattern,
        stopName: candidate.near_stop,
      });
      if (!cand) continue;
      const lo = Math.min(fromStop.pdist, toStop.pdist) - BUS_BUFFER_FT;
      const hi = Math.max(fromStop.pdist, toStop.pdist) + BUS_BUFFER_FT;
      if (cand.pdist >= lo && cand.pdist <= hi) return true;
    }
  }
  return false;
}

async function processGroup({
  group,
  kind,
  agent,
  dryRun,
  now,
  getKnownPidsForRoute,
  loadPattern,
}) {
  const alreadyQuoted = getThreadQuotedSourceUris(group.rootUri);
  if (alreadyQuoted.size >= MAX_QUOTES_PER_THREAD) return 0;

  const sinceTs = (group.earliestTs || now) - LEAD_MS;
  const candidates = findRelatedAnalyticsPosts({
    kind,
    routes: [...group.routes],
    sinceTs,
    untilTs: now,
    excludeSourceUris: alreadyQuoted,
  });
  if (candidates.length === 0) return 0;

  let posted = 0;
  const remaining = MAX_QUOTES_PER_THREAD - alreadyQuoted.size;
  for (const cand of candidates) {
    if (posted >= remaining) break;
    let relevant;
    if (kind === 'train') {
      relevant = trainCandidateRelevant(cand, group);
    } else {
      relevant = await busCandidateRelevant(cand, group, getKnownPidsForRoute, loadPattern);
    }
    if (!relevant) continue;

    const sourceRec = await getPostRecord(agent, cand.post_uri);
    if (!sourceRec) {
      // Tombstone: source post disappeared. Record so we don't re-check.
      if (!dryRun) {
        recordThreadQuote({
          threadRootUri: group.rootUri,
          sourcePostUri: cand.post_uri,
          quotePostUri: null,
        });
      }
      continue;
    }

    const replyRef = {
      root: { uri: group.rootUri, cid: group.rootCid },
      parent: { uri: group.latestPostUri, cid: group.latestPostCid },
    };

    if (dryRun) {
      console.log(
        `--- DRY RUN quote-attach (${kind} ${cand.source}) ${cand.post_uri} → thread ${group.rootUri} ---`,
      );
      posted++;
      continue;
    }

    try {
      const result = await postQuote(
        agent,
        QUOTE_TEXT,
        { uri: sourceRec.uri, cid: sourceRec.cid },
        replyRef,
      );
      console.log(
        `Quote-attached ${cand.source} ${cand.post_uri} → thread ${group.rootUri}: ${result.url}`,
      );
      recordThreadQuote({
        threadRootUri: group.rootUri,
        sourcePostUri: cand.post_uri,
        quotePostUri: result.uri,
      });
      // The quote post itself replies to latestPost — it now becomes the new
      // tail for any subsequent quotes this tick.
      group.latestPostUri = result.uri;
      group.latestPostCid = result.cid;
      posted++;
    } catch (e) {
      console.warn(`postQuote failed for ${cand.post_uri}: ${e.stack || e.message}`);
    }
  }
  return posted;
}

async function sweepRelatedQuotes({
  kind,
  agent,
  dryRun = false,
  now = Date.now(),
  getKnownPidsForRoute = () => [],
  loadPattern = null,
}) {
  if (!isEnabled()) {
    console.log(`[${kind}/related-quotes] disabled via QUOTE_RELATED_POSTS=0`);
    return { groups: 0, posted: 0 };
  }
  const groups = await buildWorkItems({ kind, agent, now });
  let posted = 0;
  for (const g of groups) {
    try {
      posted += await processGroup({
        group: g,
        kind,
        agent,
        dryRun,
        now,
        getKnownPidsForRoute,
        loadPattern,
      });
    } catch (e) {
      console.warn(`related-quotes group ${g.rootUri} failed: ${e.stack || e.message}`);
    }
  }
  console.log(`[${kind}/related-quotes] ${groups.length} thread(s), ${posted} quote(s) posted`);
  return { groups: groups.length, posted };
}

module.exports = {
  sweepRelatedQuotes,
  trainCandidateRelevant,
  busCandidateRelevant,
  buildWorkItems,
  QUOTE_TEXT,
  MAX_QUOTES_PER_THREAD,
  LEAD_MS,
};
