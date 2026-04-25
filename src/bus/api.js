const axios = require('axios');
const { recordBusObservations, getLatestBusSnapshot } = require('../shared/observations');
const { withRetry } = require('../shared/retry');

const BUS_BASE = 'https://www.ctabustracker.com/bustime/api/v3';

async function get(endpoint, params) {
  const { data } = await withRetry(() => axios.get(`${BUS_BASE}/${endpoint}`, {
    params: { key: process.env.CTA_BUS_KEY, format: 'json', ...params },
    timeout: 15000,
  }), { label: `CTA bus ${endpoint}` });
  const body = data['bustime-response'];
  if (body.error) {
    // "No data found" is CTA's way of saying a route has no active vehicles
    // right now (e.g. express routes off-peak). The response still contains
    // vehicles from the other routes in the batch, so just log and continue.
    const errors = Array.isArray(body.error) ? body.error : [body.error];
    const fatal = errors.filter((e) => !/no data found/i.test(e.msg || ''));
    const benign = errors.filter((e) => /no data found/i.test(e.msg || ''));
    if (benign.length > 0) {
      console.log(`CTA ${endpoint}: no data for ${benign.map((e) => e.rt).join(', ')}`);
    }
    if (fatal.length > 0) {
      throw new Error(`CTA ${endpoint}: ${JSON.stringify(fatal)}`);
    }
  }
  return body;
}

function parseVehicle(v) {
  return {
    vid: v.vid,
    route: v.rt,
    pid: v.pid,
    lat: parseFloat(v.lat),
    lon: parseFloat(v.lon),
    heading: parseInt(v.hdg, 10),
    pdist: v.pdist,
    destination: v.des,
    delayed: v.dly,
    tmstmp: parseBusTime(v.tmstmp),
  };
}

function parseBusTime(s) {
  // CTA returns wall-clock Chicago time as "20260415 15:52:13" with no
  // timezone. Compute the UTC instant by finding the offset that, applied
  // to the parsed wall-clock, lands back on the same Chicago wall-clock.
  const [d, t] = s.split(' ');
  const y = +d.slice(0, 4), mo = +d.slice(4, 6), da = +d.slice(6, 8);
  const [h, mi, se] = t.split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, da, h, mi, se);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(utcGuess));
  const get = (k) => +parts.find((p) => p.type === k).value;
  const seenAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = utcGuess - seenAsUtc;
  return new Date(utcGuess + offset);
}

async function getVehicles(routes) {
  if (routes.length === 0) return [];
  // API allows up to 10 routes per call
  const chunks = [];
  for (let i = 0; i < routes.length; i += 10) chunks.push(routes.slice(i, i + 10));

  const results = [];
  for (const chunk of chunks) {
    const body = await get('getvehicles', { rt: chunk.join(','), tmres: 's' });
    for (const v of body.vehicle || []) results.push(parseVehicle(v));
  }
  // Log observations so ghost detection sees every vehicle fetched by any job.
  // Uses its own `now` rather than per-vehicle `tmstmp` so a single fetch is
  // bucketed as one polling snapshot.
  recordBusObservations(results);
  return results;
}

async function getPattern(pid) {
  const body = await get('getpatterns', { pid });
  const ptr = body.ptr?.[0];
  if (!ptr) throw new Error(`No pattern returned for pid ${pid}`);
  return {
    pid: ptr.pid,
    direction: ptr.rtdir,
    lengthFt: ptr.ln,
    points: ptr.pt.map((p) => ({
      seq: p.seq,
      lat: p.lat,
      lon: p.lon,
      type: p.typ,
      stopId: p.stpid,
      stopName: p.stpnm,
      pdist: p.pdist,
    })),
  };
}

/**
 * Fetch BusTime predictions. `vid` filters to a specific vehicle, `stpid`
 * narrows to a stop. Returned fields include:
 *   vid, stpid, stpnm, rt, prdtm ("20260418 15:52:13"), prdctdn ("DUE"|"N"|"DLY"),
 *   typ ("A" arrival | "D" departure), dly (boolean).
 *
 * prdctdn is a string — may be "DUE" or "DLY" instead of a number. Caller
 * should parse defensively.
 */
async function getPredictions({ stpid, vid, rt, top }) {
  const params = {};
  if (stpid) params.stpid = Array.isArray(stpid) ? stpid.join(',') : stpid;
  if (vid) params.vid = Array.isArray(vid) ? vid.join(',') : vid;
  if (rt) params.rt = Array.isArray(rt) ? rt.join(',') : rt;
  if (top) params.top = top;
  const body = await get('getpredictions', params);
  return body.prd || [];
}

/**
 * Return vehicles for `routes`, preferring the latest snapshot already in the
 * observations DB if it's fresh enough. Falls back to a live `getVehicles`
 * fetch when the cache is empty or stale.
 *
 * Returns `{ vehicles, now, source }`:
 *   - `vehicles`: array of Vehicle-shaped objects
 *   - `now`: the timestamp the caller should pass to detectors as their `now`
 *     (so per-vehicle `tmstmp` staleness gates fire against the snapshot's
 *     reference time, not the cron's wall clock)
 *   - `source`: 'cache' or 'fetch' — for logging
 *
 * `maxStaleMs` defaults to 4 min, which sits comfortably between the
 * 5-min observeGhosts cadence and the 3-min per-vehicle staleness floor in
 * the detectors. The DB snapshot is at most 5 min old; vehicle tmstmps inside
 * are <= snapshotTs.
 */
async function getVehiclesCachedOrFresh(routes, { maxStaleMs = 4 * 60 * 1000 } = {}) {
  const cached = getLatestBusSnapshot(routes, maxStaleMs);
  if (cached && cached.vehicles.length > 0) {
    return { vehicles: cached.vehicles, now: new Date(cached.snapshotTs), source: 'cache' };
  }
  const vehicles = await getVehicles(routes);
  return { vehicles, now: new Date(), source: 'fetch' };
}

module.exports = { getVehicles, getVehiclesCachedOrFresh, getPattern, getPredictions, parseBusTime };
