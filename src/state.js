const Path = require('path');
const Fs = require('fs-extra');

const STATE_FILE = Path.join(__dirname, '..', 'state', 'posted.json');
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per pid

function load() {
  try {
    return Fs.readJsonSync(STATE_FILE);
  } catch {
    return {};
  }
}

function save(data) {
  Fs.ensureDirSync(Path.dirname(STATE_FILE));
  Fs.writeJsonSync(STATE_FILE, data);
}

function isOnCooldown(pid, now = Date.now()) {
  const data = load();
  const last = data[pid];
  if (!last) return false;
  return now - last < COOLDOWN_MS;
}

function markPosted(pid, now = Date.now()) {
  const data = load();
  data[pid] = now;
  // prune entries older than 1 day so the file doesn't grow forever
  const day = 24 * 60 * 60 * 1000;
  for (const key of Object.keys(data)) {
    if (now - data[key] > day) delete data[key];
  }
  save(data);
}

module.exports = { isOnCooldown, markPosted, COOLDOWN_MS };
