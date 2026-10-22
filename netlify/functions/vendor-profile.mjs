// Vendor My Profile (AUDIT.md §13.7) + imported-vendor claiming (§13.5).
// All logic lives in server/profiles.mjs. The vendor reads/saves their own
// profile (keyed by their verified account email — never by typed input);
// organizers read/save any vendor's profile by email from the Vendors panel.
import {db, ready, json, identity, isUserError} from '../../server/core.mjs';
import {applyPrefill, claimImported, ensureProfileSchema, getProfile, organizerSaveProfile, presentProfile, saveProfile} from '../../server/profiles.mjs';

const clean = (v, max = 200) => v == null ? undefined : String(v).slice(0, max);

// Only forward keys the client actually sent, so partial saves never clear
// fields the form didn't include (cleanProfileFields merges server-side).
function fieldsFrom(p) {
  const out = {};
  for (const k of ['name', 'business', 'description', 'phone', 'website', 'social_links', 'space_preference', 'category_id'])
    if (k in p) out[k] = p[k];
  return out;
}

export default async req => {
  if (req.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  try {
    if (!ready()) return json({error: 'The market is being set up.'}, 503);
    const sql = db(), u = await identity(req);
    const p = await req.json().catch(() => ({}));
    await ensureProfileSchema(sql);

    if (p.action === 'get') {
      // Opening My Profile is also the claiming moment (§13.5): any
      // imported records matching the verified email attach to the profile.
      const claim = await claimImported(sql, u);
      const row = await getProfile(sql, {userId: u.id, email: u.email});
      return json({ok: true, profile: presentProfile(row), prefill: applyPrefill(row), imported_matched: claim.matched});
    }

    if (p.action === 'save') {
      const saved = await saveProfile(sql, u, fieldsFrom(p));
      return json({ok: true, profile: presentProfile(saved), prefill: applyPrefill(saved)});
    }

    if (p.action === 'organizer-get') {
      if (!u.admin) return json({error: 'Organizer access only'}, 403);
      const row = await getProfile(sql, {email: clean(p.email, 200)});
      return json({ok: true, profile: presentProfile(row)});
    }

    if (p.action === 'organizer-save') {
      if (!u.admin) return json({error: 'Organizer access only'}, 403);
      const saved = await organizerSaveProfile(sql, {actor: u, email: clean(p.email, 200), fields: fieldsFrom(p)});
      return json({ok: true, profile: presentProfile(saved)});
    }

    return json({error: 'Unknown action'}, 400);
  } catch (e) {
    if (isUserError(e)) return json({error: e.message}, 400);
    console.error(e);
    return json({error: 'Server error'}, 500);
  }
};
