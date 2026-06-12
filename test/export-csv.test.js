const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCsvFromPayload, CSV_COLUMNS } = require('../bin/export-csv.js');

test('export-csv flattens official alerts and observations', () => {
  const start = Date.UTC(2026, 5, 11, 15, 0);
  const end = Date.UTC(2026, 5, 11, 15, 30);
  const csv = buildCsvFromPayload({
    incidents: [
      {
        id: 'abc',
        kind: 'metra',
        routes: ['me'],
        title: 'Metra Electric train #130 delayed',
        cta: {
          alert_id: 'metra-130',
          headline: 'Original headline',
          first_seen_ts: start,
          resolved_ts: end,
          active: false,
          post_url: 'https://bsky.app/profile/example/post/abc',
        },
        observations: [
          {
            id: 42,
            kind: 'metra',
            line: 'me',
            detection_source: 'delay',
            ts: start + 60_000,
            resolved_ts: end,
            active: false,
            post_url: 'https://example.com/obs',
          },
        ],
      },
    ],
  });

  const lines = csv.trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.match(csv, /alert,metra-130,metra,me,Metra Electric train #130 delayed/);
  assert.match(csv, /observation,obs-42,metra,me,,delay,delay/);
});
