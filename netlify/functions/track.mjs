// §104 (Scott, Nov 25, 2026): open-tracking pixel. Every email the app
// sends carries a 1x1 image pointing here with that outbox row's
// track_token; when a mail app loads it, the open is stamped on the
// outbox row (first open, last open, count) so the organizer's Email
// Proof report can show who actually opened what. Public by necessity
// (mail apps fetch it unauthenticated); the token is 64 random hex
// chars, and the endpoint only ever returns the same 43-byte GIF.
import { db, ensureOutboxTracking } from '../../server/core.mjs';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default async req => {
  try {
    const t = new URL(req.url).searchParams.get('t') || '';
    if (/^[a-f0-9]{32,128}$/.test(t)) {
      const sql = db();
      await ensureOutboxTracking(sql);
      await sql`update market.outbox set opened_at=coalesce(opened_at,now()),last_opened_at=now(),open_count=coalesce(open_count,0)+1 where track_token=${t}`;
    }
  } catch (e) { /* a pixel must never fail visibly */ }
  return new Response(new Uint8Array(GIF), {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Length': String(GIF.length)
    }
  });
};
