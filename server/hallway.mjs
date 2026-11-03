// §55 — Hallway spaces (Nov 3, 2026). Scott: "I have hallway space
// open, add 2 hallway spaces to every date" — Hampton Inn dates only
// ("Hilton is definitely full"), $45 each.
//
// Hallway is a third bookable space alongside indoor/outdoor, modeled
// exactly like them: capacity + price live as DATA on the location
// (defaults for new dates) and on each event (the date's own numbers),
// plus a hallway_open flag mirroring indoor_open/outdoor_open. No logic
// hard-codes the 2 or the $45 — those are the Hampton seed values the
// one-time backfill below writes into the venue/event rows.
//
// This module owns the lazy heal (same idiom as pricing.mjs's
// ensureLocationRegularPrice and waitlist.mjs's ensureWaitlistSchema):
// the columns are added if missing on first touch, and a one-time
// market.settings watermark ('hallway_schema_v1') gates the pieces that
// must run exactly once against the live DB: widening the bookings /
// move_requests space CHECKs to admit 'hallway', seeding the Hampton
// location row, and backfilling every not-yet-ended Hampton event.
// Hilton rows are never touched (the venue match is Hampton-only,
// mirroring the §50 seed match).
export const HALLWAY_CAPACITY = 2;
export const HALLWAY_PRICE = 4500; // cents — the Hampton seed price.

const hallwayEnsured = new WeakSet();

// Columns only — safe for every satellite path (credit, manual
// booking, reschedule, date moves) whose callers just need to READ
// hallway fields off event/location rows. The one-time data work
// (check widening + Hampton seed/backfill) lives in ensureHallway
// below and runs from the rollout paths (public data, apply, admin,
// waitlist), never as a side effect of an unrelated redemption.
export async function ensureHallwayColumns(sql) {
  await sql`alter table market.locations add column if not exists hallway_capacity int not null default 0`;
  await sql`alter table market.locations add column if not exists hallway_price int not null default 4500`;
  await sql`alter table market.events add column if not exists hallway_capacity int not null default 0`;
  await sql`alter table market.events add column if not exists hallway_price int not null default 4500`;
  await sql`alter table market.events add column if not exists hallway_open boolean not null default true`;
}

export async function ensureHallway(sql) {
  await ensureHallwayColumns(sql);
  if (hallwayEnsured.has(sql)) return;
  const [done] = await sql`select value from market.settings where key = 'hallway_schema_v1'`;
  if (!done) {
    // The live bookings table predates hallway: widen its space CHECK.
    // (Fresh installs get the widened check from database/setup.sql.)
    await sql`alter table market.bookings drop constraint if exists bookings_space_check`;
    await sql`alter table market.bookings add constraint bookings_space_check check (space in ('indoor', 'outdoor', 'hallway'))`;
    await sql`alter table if exists market.move_requests drop constraint if exists move_requests_space_check`;
    await sql`alter table if exists market.move_requests add constraint move_requests_space_check check (space in ('indoor', 'outdoor', 'hallway'))`;
    // Hampton venue defaults: 2 hallway spaces at $45. Only fills rows
    // that have no hallway capacity yet, so an organizer edit is never
    // overwritten.
    await sql`update market.locations set hallway_capacity = ${HALLWAY_CAPACITY}, hallway_price = ${HALLWAY_PRICE}
      where hallway_capacity = 0
        and (lower(name) like '%hampton%' or lower(coalesce(market_name, '')) like '%hampton%')`;
    // Every Hampton date that has not ended yet gets the same 2 / $45
    // (same not-in-the-past predicate the rest of the app uses). Past
    // dates and Hilton dates stay exactly as they are.
    await sql`update market.events e set hallway_capacity = ${HALLWAY_CAPACITY}, hallway_price = ${HALLWAY_PRICE}
      from market.locations l
      where e.location_id = l.id and e.hallway_capacity = 0
        and (lower(l.name) like '%hampton%' or lower(coalesce(l.market_name, '')) like '%hampton%')
        and (e.date + coalesce(e.end_time, time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York')`;
    await sql`insert into market.settings(key, value) values('hallway_schema_v1', ${new Date().toISOString()}) on conflict(key) do nothing`;
  }
  hallwayEnsured.add(sql);
}

// The apply-flow fallback decision (§55): a vendor who picked Indoor
// lands in the hallway — as a normal pending booking at the hallway
// price — only when Indoor itself is the ONLY thing standing in the
// way (the space is full). A sold-out market, a closed indoor area, or
// a full category (§54) never routes anyone into the hallway, and the
// hallway itself must be open with a spot free. Pure function so the
// rule is unit-testable without the api handler.
export function hallwayFallbackSpace({space, soldOut, areaClosed, categoryFull, spaceFull, event, hallwayUsed}) {
  if (space !== 'indoor') return null;
  if (soldOut || areaClosed || categoryFull || !spaceFull) return null;
  if (!event || Number(event.hallway_capacity || 0) <= 0) return null;
  if (event.hallway_open === false) return null;
  if (Number(hallwayUsed || 0) >= Number(event.hallway_capacity)) return null;
  return 'hallway';
}
