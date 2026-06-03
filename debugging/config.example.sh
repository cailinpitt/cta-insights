# Config for the prod-DB debug scripts (query-prod.sh, pull-prod-db.sh).
#
# Copy this to debugging/config.sh (gitignored) and fill in your own values:
#   cp debugging/config.example.sh debugging/config.sh
#
# Or just export these in your shell / CI instead of using the file.

# SSH target for the host running the bot. Either user@host, or an alias you've
# defined in ~/.ssh/config.
export CTA_SERVER="user@your-host"

# Absolute path to history.sqlite on that host.
export CTA_REMOTE_DB="/path/to/cta-insights/state/history.sqlite"
