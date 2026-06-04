// Dead-man's-switch for the cta-insights cron pipeline.
//
// Every cron job pings POST /ping/<slug> through bin/cron-run.sh after it runs.
// A single Durable Object records each slug's last-seen timestamp in its SQLite
// store and, via a self-rescheduling alarm, alerts (ntfy) when a *monitored*
// job goes silent past its budget — then again when it recovers. The watcher
// runs on Cloudflare, independent of the home server it is watching, so "the
// box died" is exactly the case it catches.
//
// All jobs are recorded (visible on GET /status); only slugs in MONITORED
// raise alerts, so widening coverage later is a one-line edit here, no server
// change. Unmonitored slugs are still useful liveness on the status board.

const MIN = 60_000;

// slug -> max silence before it's considered down. Budget = job period + grace.
// observe-buses/observe-trains run every minute and feed the whole detection
// pipeline, so they are the canaries: if the box, network, or CTA API dies they
// stop pinging within ~2 min. 8 min of silence (≈7 missed minute-pings) is
// loose enough to ride out a transient network blip without paging, while still
// catching a real outage quickly.
const MONITORED = {
  'observe-buses': 8 * MIN,
  'observe-trains': 8 * MIN,
};

const ALARM_INTERVAL_MS = 60_000;

export default {
  async fetch(request, env) {
    // One global monitor instance fans in every job's pings.
    const stub = env.HEARTBEAT.get(env.HEARTBEAT.idFromName('monitor'));
    return stub.fetch(request);
  },
};

export class HeartbeatMonitor {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hb (
        slug    TEXT PRIMARY KEY,
        ts      INTEGER NOT NULL,
        status  TEXT,
        alerted INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    const ping = url.pathname.match(/^\/ping\/([A-Za-z0-9_-]+)$/);
    if (ping) {
      if (request.method !== 'POST') return text('method not allowed', 405);
      const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/, '');
      if (!this.env.PING_TOKEN || token !== this.env.PING_TOKEN) {
        return text('unauthorized', 401);
      }
      const slug = ping[1];
      const status = url.searchParams.get('status') ?? 'ok';
      // Deliberately do NOT touch `alerted` here — the alarm owns the
      // down->up recovery transition, so resetting it on ping would swallow
      // the recovery notice.
      this.sql.exec(
        `INSERT INTO hb (slug, ts, status, alerted) VALUES (?, ?, ?, 0)
         ON CONFLICT(slug) DO UPDATE SET ts = excluded.ts, status = excluded.status`,
        slug,
        Date.now(),
        status,
      );
      await this.ensureAlarm();
      return text('ok');
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return this.statusResponse();
    }

    return text('not found', 404);
  }

  async alarm() {
    const now = Date.now();
    const rows = this.sql.exec('SELECT slug, ts, status, alerted FROM hb').toArray();
    for (const r of rows) {
      const budget = MONITORED[r.slug];
      if (budget === undefined) continue; // recorded for /status, not alerted on
      const stale = now - r.ts > budget;
      if (stale && !r.alerted) {
        await this.notify('down', r, now);
        this.sql.exec('UPDATE hb SET alerted = 1 WHERE slug = ?', r.slug);
      } else if (!stale && r.alerted) {
        await this.notify('up', r, now);
        this.sql.exec('UPDATE hb SET alerted = 0 WHERE slug = ?', r.slug);
      }
    }
    // Keep the loop alive; ~1440 fires/day is trivial on the free plan.
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async notify(kind, row, now) {
    if (!this.env.NTFY_URL) return;
    const seen = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 16);
    const mins = Math.round((now - row.ts) / MIN);
    const down = kind === 'down';
    // Keep header values ASCII — HTTP headers are latin-1, so the icon goes in
    // Tags (ntfy renders the shortcode as an emoji), never in Title.
    try {
      await fetch(this.env.NTFY_URL, {
        method: 'POST',
        headers: {
          Title: `cta-insights: ${row.slug} ${down ? 'silent' : 'recovered'}`,
          Priority: down ? 'urgent' : 'default',
          Tags: down ? 'rotating_light' : 'white_check_mark',
        },
        body: down
          ? `No heartbeat in ${mins}m (last seen ${seen}Z, status ${row.status}).`
          : `Heartbeat resumed (last seen ${seen}Z).`,
      });
    } catch (e) {
      console.error(`ntfy notify failed: ${e}`);
    }
  }

  statusResponse() {
    const now = Date.now();
    const rows = this.sql.exec('SELECT slug, ts, status, alerted FROM hb ORDER BY slug').toArray();
    const jobs = rows.map((r) => {
      const budget = MONITORED[r.slug];
      return {
        slug: r.slug,
        lastSeen: new Date(r.ts).toISOString(),
        ageSec: Math.round((now - r.ts) / 1000),
        status: r.status,
        monitored: budget !== undefined,
        stale: budget !== undefined && now - r.ts > budget,
        alerted: !!r.alerted,
      };
    });
    return Response.json({ now: new Date(now).toISOString(), jobs });
  }
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}
