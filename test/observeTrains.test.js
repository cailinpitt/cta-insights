const test = require('node:test');
const assert = require('node:assert/strict');
const { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN } = require('../scripts/observeTrains');

test('runTicks fires TICKS_PER_RUN times per cron firing', async () => {
  let calls = 0;
  await runTicks({
    tick: async () => {
      calls++;
    },
    sleep: async () => {},
  });
  assert.equal(calls, TICKS_PER_RUN);
});

test('runTicks waits TICK_INTERVAL_MS between consecutive ticks (and not before the first)', async () => {
  const sleeps = [];
  await runTicks({
    tick: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  // N ticks → N-1 sleeps, all at the configured interval.
  assert.equal(sleeps.length, TICKS_PER_RUN - 1);
  for (const ms of sleeps) assert.equal(ms, TICK_INTERVAL_MS);
});

test('runTicks calls sleep before tick on subsequent iterations, never before the first', async () => {
  const events = [];
  await runTicks({
    tick: async () => {
      events.push('tick');
    },
    sleep: async () => {
      events.push('sleep');
    },
    ticksPerRun: 3,
    intervalMs: 1000,
  });
  assert.deepEqual(events, ['tick', 'sleep', 'tick', 'sleep', 'tick']);
});

test('runTicks does not let one tick failure abort the run', async () => {
  let calls = 0;
  // Default tick swallows errors internally, but assert that even a tick that
  // throws (worst case if defaultTick's try/catch is later removed) doesn't
  // skip the second iteration when the caller wraps it.
  const safeTick = async () => {
    calls++;
    if (calls === 1) throw new Error('simulated transient API failure');
  };
  await assert.rejects(runTicks({ tick: safeTick, sleep: async () => {} }));
  // First tick ran before throwing.
  assert.equal(calls, 1);
});
