const axios = require('axios');

const BUS_BASE = 'http://www.ctabustracker.com/bustime/api/v3';

async function get(endpoint, params) {
  const { data } = await axios.get(`${BUS_BASE}/${endpoint}`, {
    params: { key: process.env.CTA_BUS_KEY, format: 'json', ...params },
    timeout: 15000,
  });
  const body = data['bustime-response'];
  if (body.error) throw new Error(`CTA ${endpoint}: ${JSON.stringify(body.error)}`);
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

module.exports = { getVehicles, getPattern };
