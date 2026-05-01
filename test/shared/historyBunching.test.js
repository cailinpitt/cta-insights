const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function freshDbPath() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-bunching-'));
  return Path.join(dir, 'history.sqlite');
}

function loadHistoryWithDb(dbPath) {
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
        Fs.rmSync(Path.dirname(dbPath), { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

function recordBusBunch(history, { route, vehicleCount, severityFt, ts }) {
  history.recordBunching(
    {
      kind: 'bus',
      route,
      direction: `pid-${route}`,
      vehicleCount,
      severityFt,
      nearStop: 'Test Stop',
      posted: true,
    },
    ts,
  );
}

test('bus route-record callout still fires when a stronger bunch exists elsewhere in the network', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  const now = Date.UTC(2026, 4, 1, 18, 0, 0);
  try {
    recordBusBunch(history, {
      route: '22',
      vehicleCount: 3,
      severityFt: 200,
      ts: now - 25 * 86400e3,
    });
    recordBusBunch(history, {
      route: '22',
      vehicleCount: 4,
      severityFt: 280,
      ts: now - 10 * 86400e3,
    });
    recordBusBunch(history, {
      route: '22',
      vehicleCount: 4,
      severityFt: 320,
      ts: now - 90 * 60 * 1000,
    });
    recordBusBunch(history, {
      route: '66',
      vehicleCount: 6,
      severityFt: 150,
      ts: now - 60 * 60 * 1000,
    });

    const ctx = history.getBusBunchingRecordContext(
      { route: '22', vehicleCount: 5, severityFt: 350 },
      now,
    );
    assert.equal(ctx.routeRecord, true);
    assert.equal(ctx.networkRecord, false);

    const callouts = history.bunchingCallouts(
      {
        kind: 'bus',
        route: '22',
        routeLabel: 'Route 22',
        vehicleCount: 5,
        severityFt: 350,
        recordContext: ctx,
      },
      now,
    );
    assert.deepEqual(callouts, [
      '2nd Route 22 bunch reported today',
      'worst reported on this route in 30 days',
    ]);
  } finally {
    cleanup();
  }
});

test('bus network-record context beats the strongest prior posted bunch across all routes', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  const now = Date.UTC(2026, 4, 1, 18, 0, 0);
  try {
    recordBusBunch(history, {
      route: '8',
      vehicleCount: 4,
      severityFt: 220,
      ts: now - 20 * 86400e3,
    });
    recordBusBunch(history, {
      route: '36',
      vehicleCount: 5,
      severityFt: 180,
      ts: now - 8 * 86400e3,
    });
    recordBusBunch(history, {
      route: '49',
      vehicleCount: 5,
      severityFt: 260,
      ts: now - 3 * 86400e3,
    });

    const ctx = history.getBusBunchingRecordContext(
      { route: '152', vehicleCount: 5, severityFt: 320 },
      now,
    );
    assert.equal(ctx.routeRecord, false);
    assert.equal(ctx.networkRecord, true);

    const callouts = history.bunchingCallouts(
      {
        kind: 'bus',
        route: '152',
        routeLabel: 'Route 152',
        vehicleCount: 5,
        severityFt: 320,
        recordContext: ctx,
      },
      now,
    );
    assert.deepEqual(callouts, []);
  } finally {
    cleanup();
  }
});

test('bus network record requires strict dominance over the strongest prior event', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  const now = Date.UTC(2026, 4, 1, 18, 0, 0);
  try {
    recordBusBunch(history, {
      route: '8',
      vehicleCount: 4,
      severityFt: 220,
      ts: now - 20 * 86400e3,
    });
    recordBusBunch(history, {
      route: '36',
      vehicleCount: 5,
      severityFt: 180,
      ts: now - 8 * 86400e3,
    });
    recordBusBunch(history, {
      route: '49',
      vehicleCount: 5,
      severityFt: 320,
      ts: now - 3 * 86400e3,
    });

    const ctx = history.getBusBunchingRecordContext(
      { route: '152', vehicleCount: 5, severityFt: 320 },
      now,
    );
    assert.equal(ctx.networkRecord, false);
  } finally {
    cleanup();
  }
});

test('bus network record can fire even when the route has little local history', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  const now = Date.UTC(2026, 4, 1, 18, 0, 0);
  try {
    recordBusBunch(history, {
      route: '8',
      vehicleCount: 3,
      severityFt: 220,
      ts: now - 20 * 86400e3,
    });
    recordBusBunch(history, {
      route: '36',
      vehicleCount: 4,
      severityFt: 180,
      ts: now - 8 * 86400e3,
    });
    recordBusBunch(history, {
      route: '49',
      vehicleCount: 4,
      severityFt: 260,
      ts: now - 3 * 86400e3,
    });

    const ctx = history.getBusBunchingRecordContext(
      { route: '152', vehicleCount: 5, severityFt: 320 },
      now,
    );
    assert.equal(ctx.routeRecord, false);
    assert.equal(ctx.networkRecord, true);
    assert.equal(ctx.routePriorCount, 0);
  } finally {
    cleanup();
  }
});
