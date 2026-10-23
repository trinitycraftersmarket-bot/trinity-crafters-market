// Floor-plan attachments for the setup instructions email.
//
// The completed floor plan (the saved layout image WITH each assigned
// vendor's name pinned at their spot) can only be drawn client-side —
// the editor composes it on a canvas at send time and ships the result
// in the setup-email payload as `area_images`, keyed by area_key. The
// server prefers that composed image for an area and falls back to the
// raw saved image when no composed image was supplied (older clients,
// a failed compose). These helpers are the pure, testable seam for
// that selection plus the recipient guard; netlify/functions/api.mjs
// wires them to the database and the outbox.

// Same ceiling the client's upload pipeline already enforces.
export const MAX_PLAN_IMAGE_CHARS = 2800000;

// One data URL -> one Resend-ready attachment ({filename, content}),
// or null when the value is not a usable plan image. Mirrors the
// acceptance rule the area store has always used (png/jpeg/webp data
// URL), plus the size ceiling.
export function floorPlanDataUrlAttachment(dataUrl, baseName) {
  const value = String(dataUrl || '');
  if (!value || value.length > MAX_PLAN_IMAGE_CHARS) return null;
  const m = value.match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { filename: String(baseName) + '.' + ext, content: m[2] };
}

// The attachment for one area: the client's composed named plan when a
// valid one was supplied for the area, otherwise the raw saved image.
// Filename keeps the "<Area>-Floor-Plan" convention vendors already see.
export function pickAreaAttachment(area, composedDataUrl) {
  const base = String(area?.title || 'Floor Plan').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '-Floor-Plan';
  return floorPlanDataUrlAttachment(composedDataUrl, base) || floorPlanDataUrlAttachment(area?.image_data_url, base);
}

// Every area's attachment, deduped by filename, in area order — the
// set the CC copy and the organizer's test email receive.
export function allAreaAttachments(areaAttachments) {
  const seen = new Set(), out = [];
  for (const att of areaAttachments || []) {
    if (!att || seen.has(att.filename)) continue;
    seen.add(att.filename);
    out.push(att);
  }
  return out;
}

// The send guard. A recipient blocks the send ONLY when they end up
// with no attachment at all while at least one area they are assigned
// to HAS a plan image available (a saved image, or a composed named
// plan supplied for it) — that combination means an attachment was
// lost on the way, which is worth surfacing. Recipients whose areas
// have no image (an outdoor area with no uploaded plan, say), and
// recipients not placed on any plan yet, never block the send; they
// simply receive the instructions without a map.
// Input: the byEmail packages map built by eventAreaMailPackages —
// each package carries `attachments` (what the recipient will get)
// and `available_areas` (titles of their assigned areas that have an
// image available).
export function blockedRecipients(byEmail) {
  const blocked = [];
  for (const [email, pkg] of byEmail || []) {
    if (pkg && (pkg.available_areas || []).length && !(pkg.attachments || []).length) blocked.push(email);
  }
  return blocked;
}
