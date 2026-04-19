const axios = require('axios');
const { recordBusObservations } = require('./observations');

const BUS_BASE = 'http://www.ctabustracker.com/bustime/api/v3';

async function get(endpoint, params) {
  const { data } = await axios.get(`${BUS_BASE}/${endpoint}`, {
    params: { key: process.env.CTA_BUS_KEY, format: 'json', ...params },
    timeout: 15000,
  });
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
  // "20260415 15:52:13"
  const [d, t] = s.split(' ');
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t}`;
  return new Date(iso);
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

module.exports = { getVehicles, getPattern, getPredictions };
