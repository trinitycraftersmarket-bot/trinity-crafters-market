// §63 — Coupon codes (Nov 12, 2026). Scott: a coupon code box on the
// vendor application, placed immediately before the submit button; a
// coupon discounts the vendor fee by a percentage. The launch coupon
// is '501C' at 100% off, paired with the new '501c' vendor category
// (active, vendor_limit 1 — only one such vendor per date) so a
// 501(c) nonprofit books free.
//
// Rules, in the §50/§62 data-driven style:
//  - Coupons are DATA in market.coupons (code stored uppercase,
//    matched case-insensitively; percent 0–100; active flag), edited
//    from the organizer panel's Coupons tab through the audited,
//    admin-only 'coupon-save' action. Nothing about a coupon is
//    hardcoded in the pricing paths.
//  - The discount applies AFTER the normal price computation
//    (regularAwarePrice — a regular vendor's rate first, then the
//    coupon % off), per booking, in integer cents, rounded half up.
//    bookings.price always stores the FINAL charged price, and the
//    code used is stored on the application and on each booking.
//  - An unknown or inactive code is a HARD error at submit — never a
//    silent full-price charge.
//  - A booking whose final price is 0 BECAUSE of a coupon never
//    enters the unpaid/invoice flow: approval lands it 'paid' with
//    payment_method 'Coupon <code>' (handled at the approve sites).
//  - The seeds below insert ONLY when absent (the §50 seed rule): a
//    coupon or category Scott later edits is never overwritten.

export async function ensureCoupons(db) {
  await db`create table if not exists market.coupons(
    id uuid primary key default gen_random_uuid(),
    code text unique not null,
    percent integer not null check (percent between 0 and 100),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    created_by text
  )`;
  await db`alter table market.coupons enable row level security`;
  await db`alter table market.applications add column if not exists coupon_code text`;
  await db`alter table market.bookings add column if not exists coupon_code text`;
  // Seeds (insert-only-when-absent): the 501C free-nonprofit coupon
  // and its matching vendor category, one per date.
  await db`insert into market.coupons(code, percent, active)
    select '501C', 100, true
    where not exists (select 1 from market.coupons where code = '501C')`;
  await db`insert into market.categories(name, active, vendor_limit)
    select '501c', true, 1
    where not exists (select 1 from market.categories where lower(name) = '501c')`;
}

// Codes are stored uppercase; every entry point normalizes the same
// way so '501c', ' 501C ' and '501C' are the same coupon.
export const normalizeCouponCode = raw => String(raw || '').trim().toUpperCase().slice(0, 40);

// Resolve a submitted code to its coupon row. Returns null when no
// code was given; throws the vendor-facing hard error when a code was
// given but is unknown or inactive.
export async function resolveCoupon(db, raw) {
  const code = normalizeCouponCode(raw);
  if (!code) return null;
  const [row] = await db`select code, percent, active from market.coupons where code = ${code}`;
  if (!row || !row.active) throw Error("That coupon code isn't valid.");
  return { code: row.code, percent: Number(row.percent) };
}

// The current percent for a code already attached to a record (the
// §60 move-space reprice keeps the booking's coupon applied even if
// the coupon is later deactivated — the vendor booked with it).
// Returns null when the code is unknown.
export async function couponPercentFor(db, raw) {
  const code = normalizeCouponCode(raw);
  if (!code) return null;
  const [row] = await db`select percent from market.coupons where code = ${code}`;
  return row ? Number(row.percent) : null;
}

// final = round-half-up(base * (100 - percent) / 100), integer cents.
// base * (100 - percent) is an exact integer and the only .5 cases
// are exact in binary floating point, so Math.round (half toward
// +infinity) is a true round-half-up for these non-negative amounts.
export function applyCouponPrice(baseCents, percent) {
  const base = Math.max(0, Math.round(Number(baseCents) || 0));
  const pct = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.round(base * (100 - pct) / 100);
}
