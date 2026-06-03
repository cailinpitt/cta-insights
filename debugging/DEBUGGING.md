# Debugging scripts

Retained helpers for the recurring "what did the bot actually see / would say?"
questions, so we stop re-deriving them as throwaway scripts. These complement
the heavier harnesses already in `scripts/` (`replay-pulse.js`,
`replay-incident.js`, `render-bunch-snapshot.js`, `render-disruption-once.js`),
which replay/render against a **local copy of the prod DB**.

| Script | What it does |
| --- | --- |
| `query-prod.sh` | Read-only SQL against prod's `history.sqlite` over SSH. |
| `pull-prod-db.sh` | Pull a consistent snapshot of prod's DB for the replay/render harnesses. |
| `preview-bot-text.js` | Render the bot's detection/resolution/bullet text from a sample observation — no DB, no posting. |

> **Never query the local `state/history.sqlite` for real data.** It's a stale
> dev artifact. The bot runs on the server; the only source of truth is prod.

### Setup (the two shell scripts)

`query-prod.sh` and `pull-prod-db.sh` need to know your server and the DB path
on it. Nothing is hardcoded — set two variables:

```sh
cp debugging/config.example.sh debugging/config.sh   # gitignored; fill in your values
```

```sh
# debugging/config.sh
export CTA_SERVER="user@your-host"                                  # or an ~/.ssh/config alias
export CTA_REMOTE_DB="/path/to/cta-insights/state/history.sqlite"
```

The scripts source `config.sh` if present, otherwise they read `CTA_SERVER` /
`CTA_REMOTE_DB` from the environment, and error with a hint if neither is set.
(`query-prod.sh --help` works without config.)

> **Never run a `bin/` to "see what it would post".** Bins post to Bluesky on
> import. Use `--dry-run` on the real bins, or `preview-bot-text.js` here for the
> text renderers.

---

## `query-prod.sh`

Run a read-only query against the live DB without pulling it. Every query opens
the DB with `-readonly`, so it can never write prod.

```sh
debugging/query-prod.sh 'SELECT COUNT(*) FROM gap_events'
debugging/query-prod.sh "SELECT ts, ratio, near_stop FROM gap_events WHERE route='red' ORDER BY ts DESC LIMIT 10"
debugging/query-prod.sh --tables            # list tables
debugging/query-prod.sh --schema gap_events # column list for a table
debugging/query-prod.sh --recent red        # canned recent activity for a line/route
```

`--recent <line|route>` dumps the last few rows from `gap_events`,
`meta_signals`, `disruption_events`, and `roundup_anchors` for that
line/route — the fastest "is this alert a false positive?" first look.

Tables worth knowing: `gap_events`, `ghost_events`, `bunching_events`,
`meta_signals` (the cross-detector correlation feed; rolls off at 48h),
`disruption_events` (pulse-*/thin-gap), `roundup_anchors`, `alert_posts`,
`observations` (raw vehicle positions).

## `pull-prod-db.sh`

Pull a **transactionally-consistent** snapshot of prod's `history.sqlite` to a
local file, for the replay/render harnesses that need the whole DB.

```sh
debugging/pull-prod-db.sh                 # -> tmp/server-history.sqlite
debugging/pull-prod-db.sh path/to.sqlite  # custom destination

# then:
HISTORY_DB_PATH=tmp/server-history.sqlite \
  node scripts/replay-pulse.js --line=red --start=2026-05-03T20:00Z --end=2026-05-03T22:30Z
```

The DB is WAL-mode and ~900MB, so the script runs `sqlite3 .backup` on the
server first (folding in the WAL for a clean snapshot) and transfers that — a
plain `rsync` of the live file could tear or miss recent commits. Snapshot +
transfer takes a minute or two; the harnesses are read-only, so re-pull whenever
you want fresher data.

## `preview-bot-text.js`

Render the plain-English strings the web export derives from a bot observation —
detection sentence, evidence bullets, onset line, resolution sentence — by
exercising the pure renderers in `src/shared/observationDescribe.js` directly.
No DB, no bin, no Bluesky. Use it to iterate on wording or sanity-check a new
signal shape.

```sh
node debugging/preview-bot-text.js --example roundup     # gap+ghost train roundup
node debugging/preview-bot-text.js --example pulse-cold   # train dead-segment
node debugging/preview-bot-text.js --example thin-gap     # silent low-freq bus route
node debugging/preview-bot-text.js --file path/to/observation.json
echo '{"kind":"train","line":"red","detection_source":"roundup","signals":["gap"],"bullets":[{"source":"gap","detail":{"ratio":3.1,"fromStation":"Howard","toStation":"Jarvis"}}]}' \
  | node debugging/preview-bot-text.js
```

Input is one observation row shaped like what `bin/export-web.js` feeds the
renderers: `{ kind, line, detection_source, signals, bullets, evidence,
from_station, to_station, ts, onset_ts }`. To see the real shape for a live
event, pull it from the wire: `curl -s https://chicagotransitalerts.app/data/alerts.json`.

---

## Notes & gotchas

- **Data quality belongs here, not in the frontend.** If the archive shows
  something wrong, the fix is in the export (`bin/export-web.js`) /
  `src/shared/observationDescribe.js`, then backfilled — not patched in
  cta-alert-history.
- **`meta_signals` and `observations` roll off at 48h.** Forensics older than
  that have to come from `gap_events` / `disruption_events` / `roundup_anchors`,
  which persist.
- **SSH from a sandboxed shell** may need DNS/Tailscale access the sandbox
  blocks; run these from a normal terminal.
