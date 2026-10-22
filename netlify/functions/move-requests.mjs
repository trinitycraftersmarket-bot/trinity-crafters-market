// Vendor date-move requests (AUDIT.md §9). Vendors request a move from
// My Bookings; organizers (admin, or staff with the `moves:approve`
// permission, §13.3) approve or decline. All logic lives in
// server/moves.mjs; capacity/category math in server/counts.mjs.
import {db, ready, json, identity, banned, flushMail, isUserError} from '../../server/core.mjs';
import {hasStaffPermission, MOVE_REQUEST_PERMISSION} from '../../server/permissions.mjs';
import {approveMoveRequest, cancelMoveRequest, createMoveRequest, declineMoveRequest, eligibleTargets, ensureMoveSchema, loadMoveSource} from '../../server/moves.mjs';

const lock = tx => tx`select pg_advisory_xact_lock(708821)`;
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const canDecide = u => u.admin || hasStaffPermission(u, MOVE_REQUEST_PERMISSION);

function presentRequest(r, from, to) {
  return {...r, from_date: from?.date ?? null, from_location: from?.location ?? null, to_date: to?.date ?? null, to_location: to?.location ?? null};
}

export default async req => {
  if (req.method !== 'POST') return json({error: 'Method not allowed'}, 405);
  try {
    await ready();
    const sql = db(), u = await identity(req);
    if (!u) return json({error: 'Sign in first'}, 401);
    const p = await req.json().catch(() => ({}));
    await ensureMoveSchema(sql);

    if (p.action === 'options') {
      const source = await loadMoveSource(sql, clean(p.source_type, 20), clean(p.source_id, 40));
      if (!source) return json({error: 'That booking could not be found.'}, 404);
      if (source.source_type === 'booking' ? source.user_id !== u.id : String(source.email || '').trim().toLowerCase() !== String(u.email || '').trim().toLowerCase())
        return json({error: 'That booking is not yours.'}, 403);
      const {eligible, excluded} = await sql.begin(async tx => { await lock(tx); return eligibleTargets(tx, source); });
      return json({ok: true, space: source.space, eligible, excluded: excluded.map(x => ({event: x.event, problems: x.problems}))});
    }

    if (p.action === 'create') {
      if (await banned(sql, u)) return json({error: 'This account cannot request a date move.'}, 403);
      const out = await sql.begin(async tx => {
        await lock(tx);
        const source = await loadMoveSource(tx, clean(p.source_type, 20), clean(p.source_id, 40));
        if (!source) throw Error('That booking could not be found.');
        return createMoveRequest(tx, {source, targetEventId: clean(p.to_event_id, 40), reason: clean(p.reason, 500), user: u});
      });
      await flushMail();
      return json({ok: true, request: presentRequest(out.request, out.from, out.to)});
    }

    if (p.action === 'mine') {
      const rows = await sql`select mr.*, fe.date as from_date, fe_loc.name as from_location, te.date as to_date, te_loc.name as to_location
        from market.move_requests mr
        join market.events fe on fe.id = mr.from_event_id join market.locations fe_loc on fe_loc.id = fe.location_id
        join market.events te on te.id = mr.to_event_id join market.locations te_loc on te_loc.id = te.location_id
        where (mr.source_type = 'booking' and mr.source_id in (select b.id from market.bookings b join market.applications a on a.id = b.application_id where a.user_id = ${u.id}))
           or (mr.source_type = 'imported' and lower(mr.vendor_email) = ${String(u.email || '').trim().toLowerCase()})
        order by mr.requested_at desc limit 100`;
      return json({ok: true, requests: rows});
    }

    if (p.action === 'cancel') {
      const out = await sql.begin(async tx => { await lock(tx); return cancelMoveRequest(tx, {requestId: clean(p.id, 40), user: u}); });
      return json({ok: true, request: out.request});
    }

    if (p.action === 'list') {
      if (!canDecide(u)) return json({error: 'Move-request access has not been assigned.'}, 403);
      const rows = await sql`select mr.* from market.move_requests mr order by (mr.status = 'pending') desc, mr.requested_at desc limit 200`;
      const items = [];
      for (const r of rows) {
        const source = await loadMoveSource(sql, r.source_type, r.source_id);
        const [fe] = await sql`select e.*, l.name as location from market.events e join market.locations l on l.id = e.location_id where e.id = ${r.from_event_id}`;
        const [te] = await sql`select e.*, l.name as location from market.events e join market.locations l on l.id = e.location_id where e.id = ${r.to_event_id}`;
        const [srcEv] = await sql`select ((date + coalesce(start_time, time '10:00')) <= ((now() at time zone 'America/New_York') + interval '48 hours')) as within_cutoff from market.events where id = ${r.from_event_id}`;
        items.push({request: r, source: source ? {name: source.name, business: source.business, email: source.email, category: source.category, space: source.space, status: source.status, amount_due: source.amount_due, amount_paid: Number(source.amount_paid || 0), monthly: source.monthly, current_event_id: source.event_id} : null,
          from: fe || null, to: te || null, from_within_cutoff: !!srcEv?.within_cutoff});
      }
      return json({ok: true, items, pending: rows.filter(r => r.status === 'pending').length});
    }

    if (p.action === 'approve' || p.action === 'decline') {
      if (!canDecide(u)) return json({error: 'Move-request approval has not been assigned.'}, 403);
      const out = await sql.begin(async tx => {
        await lock(tx);
        return p.action === 'approve'
          ? approveMoveRequest(tx, {requestId: clean(p.id, 40), actor: u, overrideCutoff: p.override_cutoff === true})
          : declineMoveRequest(tx, {requestId: clean(p.id, 40), actor: u, note: clean(p.note, 500)});
      });
      await flushMail();
      return json({ok: true, request: presentRequest(out.request, out.from, out.to)});
    }

    return json({error: 'Unknown action'}, 400);
  } catch (e) {
    if (isUserError(e)) return json({error: e.message}, 400);
    console.error(e);
    return json({error: 'Server error'}, 500);
  }
};
