// v2 money shaping: the ONE unified invoice list and the payment-log
// grouping, shared by the Payment Log and Invoice Center screens so the two
// can never disagree (audit §2.4/§4 — the legacy UI had three payment views
// with three totals). Pure functions over the admin payload, ported from the
// legacy invoiceCenter() math: same rows, same amounts, same due rules.
// No fetching, no DOM, no mutation of the payload.
import { dateOf } from './api.js?v=20261023-5';

// One invoice row per owed/payable record, across the three legacy sources:
// regular bookings (approved/held/paid), imported-attendee invoices, and
// monthly-billing invoices. `paystatus` is 'paid' | 'unpaid'; `due` is a
// date/datetime string or null; `event` resolves against allEvents/events.
export function invoiceRows(admin) {
  const findEvent = id => (admin.allEvents || []).find(e => String(e.id) === String(id)) || (admin.events || []).find(e => String(e.id) === String(id));
  const regular = (admin.applications || [])
    .filter(x => ['approved', 'held', 'paid'].includes(x.status))
    .map(x => ({ ...x, kind: 'regular', amount: Number(x.price || 0), paystatus: x.status === 'paid' ? 'paid' : 'unpaid', due: x.hold_until || null, event: findEvent(x.event_id) }));
  const imported = (admin.importedAttendees || [])
    .filter(x => x.invoice_amount != null && String(x.payment_method || '').toLowerCase() !== 'monthly billing')
    .map(x => ({ ...x, kind: 'imported', amount: Number(x.invoice_amount || 0), paystatus: x.payment_status || 'unpaid', due: x.invoice_due_date || null, event: findEvent(x.event_id) }));
  const monthly = (admin.monthlyInvoices || [])
    .map(x => ({ ...x, kind: 'monthly', amount: Math.max(0, Number(x.amount || 0) - Number(x.discount || 0) + Number(x.late_fee || 0)), paystatus: x.status === 'paid' ? 'paid' : 'unpaid', due: x.due_date || null, event: null }));
  return [...regular, ...imported, ...monthly];
}

// Due-date math in the market timezone, matching the legacy Invoice Center:
// overdue = unpaid and the due day has fully passed; dueSoon = due within
// the next 7 days (and not already overdue).
function etToday() {
  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  t.setHours(0, 0, 0, 0);
  return t;
}
export function isOverdue(row) {
  if (row.paystatus === 'paid' || !row.due) return false;
  return dateOf(row.due).getTime() + 86399999 < etToday().getTime();
}
export function isDueSoon(row) {
  if (row.paystatus === 'paid' || !row.due || isOverdue(row)) return false;
  return dateOf(row.due).getTime() + 86399999 <= etToday().getTime() + 7 * 86400000;
}
export function overdueDays(row) {
  if (!row.due) return 0;
  return Math.max(0, Math.floor((etToday().getTime() - dateOf(row.due).getTime()) / 86400000));
}

// The Invoice Center summary numbers, computed once from the unified rows.
export function invoiceStats(rows) {
  const unpaid = rows.filter(x => x.paystatus !== 'paid');
  const overdue = rows.filter(isOverdue);
  const soon = rows.filter(isDueSoon);
  const monthKey = new Date().toISOString().slice(0, 7);
  const paidMonth = rows.filter(x => x.paystatus === 'paid' && ((x.paid_at && String(x.paid_at).slice(0, 7) === monthKey) || (!x.paid_at && x.kind !== 'monthly')));
  const sum = list => list.reduce((s, x) => s + x.amount, 0);
  return {
    outstanding: sum(unpaid), outstandingCount: unpaid.length,
    overdue: sum(overdue), overdueCount: overdue.length,
    dueSoon: sum(soon), dueSoonCount: soon.length,
    paidMonth: sum(paidMonth),
    monthlyUnsent: rows.filter(x => x.kind === 'monthly' && x.paystatus !== 'paid' && !x.sent_at).length
  };
}

// Payment Log grouping (audit §4.3): payments grouped by MARKET date,
// newest first; each group carries its total and per-method subtotals.
// Rows without a market date (monthly billing) collect in a trailing group.
// `range` optionally filters by the row's effective date (market date,
// falling back to when the payment was recorded): {from, to} as YYYY-MM-DD.
export function paymentGroups(rows, range) {
  const effective = r => String(r.market_date || r.recorded_at || '').slice(0, 10);
  const inRange = r => {
    if (!range || (!range.from && !range.to)) return true;
    const d = effective(r);
    if (!d) return false;
    if (range.from && d < range.from) return false;
    if (range.to && d > range.to) return false;
    return true;
  };
  const byDate = new Map();
  for (const r of (rows || []).filter(inRange)) {
    const key = r.market_date ? String(r.market_date).slice(0, 10) : '';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }
  const groups = [...byDate.entries()].map(([date, list]) => {
    const methods = new Map();
    for (const r of list) {
      const m = r.payment_method || '—';
      methods.set(m, (methods.get(m) || 0) + Number(r.amount || 0));
    }
    return {
      date: date || null,
      rows: list,
      total: list.reduce((s, r) => s + Number(r.amount || 0), 0),
      methods: [...methods.entries()].map(([method, total]) => ({ method, total })).sort((a, b) => b.total - a.total)
    };
  });
  // Dated groups newest-first; the no-market-date group always last.
  return groups.sort((a, b) => (a.date === null) - (b.date === null) || String(b.date).localeCompare(String(a.date)));
}
