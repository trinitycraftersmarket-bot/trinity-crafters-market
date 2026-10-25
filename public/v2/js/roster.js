// §48 — Monthly billing roster: the pure computation behind the Monthly
// Billing screen's roster dropdown, extracted from billing.js so the
// roster rules are testable without a DOM. No imports, no side effects.
//
// Roster criterion (documented choice): a vendor is on the monthly
// billing roster when their monthly_billing_amount is set and > 0.
// That amount is the §46/§47 approval flag as it exists in the flag
// store today — there is no separate "approved" boolean; Scott sets the
// amount in Vendors → Edit information, and it round-trips for everyone
// (market.applications for application vendors, market.vendor_profiles
// for imported ones; vendor-list surfaces it uniformly). The amount is
// integer cents.
//
// Billed rule: a non-cancelled monthly invoice exists for the vendor
// (matched by normalized email) in the selected billing period. One
// roster entry per email even if the vendor-list carries the vendor
// twice (application row + imported row).

export const cleanEmail = e => String(e || '').replace(/,+\s*$/, '').trim().toLowerCase();

// One roster entry per monthly-billing vendor:
// { vendor, email, name, amountCents, billed, status, invoice }
export function monthlyRoster(vendors, invoices, period) {
  const p = String(period || '');
  const seen = new Set();
  const entries = [];
  for (const v of vendors || []) {
    if (!(Number(v && v.monthly_billing_amount) > 0)) continue;
    const email = cleanEmail(v.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const invoice = (invoices || []).find(i =>
      cleanEmail(i.vendor_email) === email &&
      String(i.billing_period || '') === p &&
      String(i.status || 'draft').toLowerCase() !== 'cancelled') || null;
    entries.push({
      vendor: v,
      email,
      name: v.business || v.name || email,
      amountCents: Number(v.monthly_billing_amount),
      billed: !!invoice,
      status: invoice ? String(invoice.status || 'draft').toLowerCase() : '',
      invoice
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// The Add Bill prefill for a not-yet-billed roster entry. The stored
// flag is cents; the form's amount field is a dollar string.
export function rosterPrefill(entry, period) {
  return {
    vendor_email: entry.email,
    vendor_name: entry.vendor.name || '',
    business: entry.vendor.business || '',
    amount: (entry.amountCents / 100).toFixed(2),
    billing_period: String(period || '')
  };
}
