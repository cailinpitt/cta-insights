const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-branch-thread-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

test('Bug 28: getRecentPulsePostsAll returns up to 10 pulses for caller scoring', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now() - 60 * 60 * 1000;
    history.recordDisruption(
      {
        kind: 'train',
        line: 'blue',
        direction: 'branch-0',
        fromStation: 'Rosemont',
        toStation: 'Cumberland',
        source: 'observed',
        posted: true,
        postUri: 'at://ohare-pulse',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'blue',
        direction: 'branch-1',
        fromStation: 'Pulaski',
        toStation: 'Cicero',
        source: 'observed',
        posted: true,
        postUri: 'at://forest-park-pulse',
      },
      t0 + 60_000,
    );

    const pulses = history.getRecentPulsePostsAll({
      kind: 'train',
      line: 'blue',
      withinMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(pulses.length, 2);

    // Caller-side scoring: O'Hare-branch alert text → O'Hare pulse wins.
    const alertText = 'Service suspended between Rosemont and Cumberland on the Blue Line.';
    const text = alertText.toLowerCase();
    const scored = pulses
      .map((p) => {
        const fromHit = p.from_station && text.includes(p.from_station.toLowerCase()) ? 1 : 0;
        const toHit = p.to_station && text.includes(p.to_station.toLowerCase()) ? 1 : 0;
        return { ...p, score: fromHit + toHit };
      })
      .sort((a, b) => b.score - a.score || b.ts - a.ts);
    assert.equal(scored[0].post_uri, 'at://ohare-pulse');

    // Forest Park branch alert text → Forest Park pulse wins.
    const fpText =
      'Shuttle buses replace Blue Line service between Pulaski and Cicero.'.toLowerCase();
    const scoredFp = pulses
      .map((p) => {
        const fromHit = p.from_station && fpText.includes(p.from_station.toLowerCase()) ? 1 : 0;
        const toHit = p.to_station && fpText.includes(p.to_station.toLowerCase()) ? 1 : 0;
        return { ...p, score: fromHit + toHit };
      })
      .sort((a, b) => b.score - a.score || b.ts - a.ts);
    assert.equal(scoredFp[0].post_uri, 'at://forest-park-pulse');
  } finally {
    cleanup();
  }
});
