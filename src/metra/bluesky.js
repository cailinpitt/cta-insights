const shared = require('../shared/bluesky');

// Metra runs two accounts, mirroring the CTA split (analytics vs alerts):
//   loginMetra       — analytics/insights bot: speedmap, recap, and the
//                      cancellation + delay rollup. Sibling of loginBus/loginTrain,
//                      where the bot's OWN schedule-vs-reality detections (ghosts,
//                      gaps) post — so the Metra ghost analog (cancellations) and
//                      gap analog (delays) belong here, not on the alerts account.
//   loginMetraAlerts — republished GTFS-rt service alerts + the single-train
//                      annulment lifecycle. Sibling of loginAlerts (the CTA
//                      republish path), but Metra-only so its thread space stays
//                      self-contained rather than mixing into the shared CTA
//                      alerts account.
function loginMetra() {
  return shared.login(process.env.BLUESKY_METRA_IDENTIFIER, process.env.BLUESKY_METRA_APP_PASSWORD);
}

function loginMetraAlerts() {
  return shared.login(
    process.env.BLUESKY_METRA_ALERTS_IDENTIFIER,
    process.env.BLUESKY_METRA_ALERTS_APP_PASSWORD,
  );
}

module.exports = { loginMetra, loginMetraAlerts, ...shared };
