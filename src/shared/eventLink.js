// Builds the link-card payload for a resolution reply pointing at the
// originating incident's page on chicagotransitalerts.app. Used by every
// bot pipeline that posts a "✅ cleared" reply (CTA alerts, train pulse,
// bus pulse, roundup) so each resolution gets a tappable archive link.
//
// The `/resolved` suffix exists to bust Bluesky's URL-keyed link-card cache:
// the original post may have already cached an "Active" card for the
// canonical event URL, and Bluesky's CardyB service won't refetch the same
// URL when generating the reply's card. The cta-alert-history prerenderer
// emits an identical page at /event/<rkey>/resolved with an "Archived" OG
// card so the reply gets the right thumbnail.

const EVENT_BASE_URL = 'https://chicagotransitalerts.app/event';

function rkeyFromAtUri(uri) {
  if (!uri) return null;
  const parts = uri.split('/');
  if (parts.length < 5) return null;
  return parts[parts.length - 1] || null;
}

function resolvedEventLink(postUri, title) {
  const rkey = rkeyFromAtUri(postUri);
  if (!rkey) return null;
  const url = `${EVENT_BASE_URL}/${rkey}/resolved`;
  return {
    url,
    title: title || 'CTA Alert History',
    description: 'View this incident on the CTA Alert History archive.',
    thumbUrl: `${url}/og.png`,
  };
}

module.exports = { EVENT_BASE_URL, rkeyFromAtUri, resolvedEventLink };
