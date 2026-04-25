function formatDistance(ft) {
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function formatMinutes(m) {
  return `${Math.round(m)} min`;
}

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function elapsedMinutesLabel(totalSec) {
  const m = Math.max(1, Math.round(totalSec / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

function formatTimeCT(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });
}

module.exports = { formatDistance, formatMinutes, formatMinSec, elapsedMinutesLabel, formatTimeCT };
