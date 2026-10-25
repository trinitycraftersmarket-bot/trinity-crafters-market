// §48 — Monthly billing roster: the pure computation behind the Monthly
// Billing screen's roster dropdown, extracted from billing.js so the
// roster rules are testable without a DOM. No imports, no side effects.
//
// Roster criterion (Scott's refinement): the roster IS the regular
// vendors — every vendor flagged regular_vendor in the unified §47 flag
// store (market.applications for application vendors,
// market.vendor_profiles for imported ones; vendor-list surfaces the
// flag for everyone). A vendor with a monthly amount but no regular
// flag is NOT on the roster.
//
// The monthly_billing_amount (integer cents, also on the flag store)
// is secondary: when set it prefills the bill; when a regular vendor
// has none, the entry is flagged hasAmount=false and the bill starts
// with the amount left blank for the organizer to enter.
//
// Billed rule: a non-cancelled monthly invoice exists for the vendor
// (matched by normalized email) in the selected billing period. One
// roster entry per email even if the vendor-list carries the vendor
// twice (application row + imported row).

export const cleanEmail = e => String(e || '').replace(/,+\s*$/, '').trim().toLowerCase();

// One roster entry per regular vendor:
// { vendor, email, name, amountCents, hasAmount, billed, status, invoice }
export function monthlyRoster(vendors, invoices, period) {
  const p = String(period || '');
  const seen = new Set();
  const entries = [];
  for (const v of vendors || []) {
    if (!v || !v.regular_vendor) continue;
    const email = cleanEmail(v.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const invoice = (invoices || []).find(i =>
      cleanEmail(i.vendor_email) === email &&
      String(i.billing_period || '') === p &&
      String(i.status || 'draft').toLowerCase() !== 'cancelled') || null;
    const amountCents = Number(v.monthly_billing_amount) || 0;
    entries.push({
      vendor: v,
      email,
      name: v.business || v.name || email,
      amountCents,
      hasAmount: amountCents > 0,
      billed: !!invoice,
      status: invoice ? String(invoice.status || 'draft').toLowerCase() : '',
      invoice
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// The Add Bill prefill for a not-yet-billed roster entry. The stored
// amount is cents; the form's amount field is a dollar string — or ''
// when the vendor has no monthly amount set, leaving the field blank
// for the organizer to enter.
export function rosterPrefill(entry, period) {
  return {
    vendor_email: entry.email,
    vendor_name: entry.vendor.name || '',
    business: entry.vendor.business || '',
    amount: entry.hasAmount ? (entry.amountCents / 100).toFixed(2) : '',
    billing_period: String(period || '')
  };
}
