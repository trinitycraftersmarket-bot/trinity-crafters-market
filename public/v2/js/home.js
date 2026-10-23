// Market Day home screen: the next market, its live numbers, and the
// daily-driver quick actions. Everything renders from the freshly fetched
// admin payload (ctx.state.admin) — no cached copies (audit §5 state rule).
import { esc, money, nice, niceShort, clock, marketName, isToday, dateOf } from './api.js?v=20261023-5';
import { eventStats } from './data.js?v=20261023-5';

// Standing setup rule from the market's vendor setup instructions (the
// current app's setup email template states the same times for every date).
const SETUP_FROM = '8:30 AM';

export function renderHome(ctx, root) {
  const admin = ctx.state.admin;
  const events = admin.events || [];
  const next = events[0];
  if (!next) {
    root.innerHTML = `
      <p class="eyebrow">Market Day</p>
      <h2 class="display">No upcoming markets</h2>
      <p class="lede">There are no market dates on the calendar yet. Add the next date in Dates &amp; Locations — it will show up here automatically.</p>
      <div class="card empty-card">Nothing scheduled. The current app still has every tool under Setup.</div>`;
    return;
  }
  const stats = eventStats(admin, next);
  const today = isToday(next);
  const soldOut = next.sold_out || (stats.indoorOpen === 0 && stats.outdoorOpen === 0);
  const moves = ctx.state.pendingMoves;
  const loc = (admin.locations || []).find(l => String(l.id) === String(next.location_id));

  const statCards = [
    `<button class="stat stat-btn" data-go="event-day" data-event="${esc(next.id)}"><b>${stats.vendors}</b><span>Vendors booked — ${stats.indoor} indoor · ${stats.outdoor} outdoor</span></button>`,
    `<button class="stat stat-btn ${stats.inspectionsPending ? 'warn' : ''}" data-go="event-day" data-event="${esc(next.id)}"><b>${stats.inspectionsPending} pending</b><span>Inspections waiting on you — tap to clear them</span></button>`,
    `<button class="stat stat-btn ${stats.unpaidCount ? 'warn' : ''}" data-go="section" data-section="payment-log"><b>${stats.unpaidCount} unpaid</b><span>${stats.unpaidCount ? money(stats.unpaidDue) + ' still owed for this market' : 'Everyone is paid up for this market'}</span></button>`,
    `<button class="stat stat-btn" data-go="section" data-section="waitlist"><b>${stats.waitlist}</b><span>On the wait list for this date</span></button>`,
    ...(moves != null ? [`<button class="stat stat-btn ${moves ? 'gold' : ''}" data-go="section" data-section="move-requests"><b>${moves} request${moves === 1 ? '' : 's'}</b><span>Date-move${moves === 1 ? '' : 's'} waiting for your approval</span></button>`] : [])
  ].join('');

  root.innerHTML = `
    <p class="eyebrow">${today ? 'Today is market day' : 'Market Day'}</p>
    <h2 class="display">${today ? 'Today is market day.' : 'Your next market'}</h2>
    <p class="lede">Everything for ${niceShort(next.date)} in one place — what you see is what's saved on the server.</p>

    ${today ? `<button class="today-banner" data-go="event-day" data-event="${esc(next.id)}"><span class="ic">🎪</span><span><strong>Open Event Day</strong><br><small>${stats.checkedIn} of ${stats.vendors} vendors checked in · ${stats.inspectionsPending} inspections pending</small></span><span class="chev">›</span></button>` : ''}

    <div class="card next-market">
      <div class="next-market-inner">
        <div class="label">${today ? "Today's market" : 'Next market'}</div>
        <h3>${nice(next.date)}</h3>
        <p>${esc(marketName(next))} · ${clock(next.start_time)}–${clock(next.end_time)}<br>${esc(next.location || loc?.name || '')}${next.address || loc?.address ? ' · ' + esc(next.address || loc?.address) : ''}</p>
        <div class="venue">
          <span class="venue-pill">Setup from ${SETUP_FROM}</span>
          <span class="venue-pill">${stats.indoorOpen} indoor · ${stats.outdoorOpen} outdoor open</span>
          ${soldOut ? '<span class="venue-pill pill-gold">Sold out</span>' : next.open === false ? '<span class="venue-pill">Applications closed</span>' : '<span class="venue-pill">Applications open</span>'}
        </div>
      </div>
    </div>

    <div class="stat-grid">${statCards}</div>

    <h3 class="section-title">Quick actions</h3>
    <div class="quick-grid">
      <button class="quick primary" data-go="event-day" data-event="${esc(next.id)}"><span class="ic">✓</span><span><strong>Event Day</strong><br><small>Check-ins, inspections &amp; floor plan</small></span></button>
      <button class="quick light" data-go="event-day" data-event="${esc(next.id)}"><span class="ic">☰</span><span><strong>Attendees</strong><br><small>${stats.vendors} vendors · search the list</small></span></button>
      <button class="quick goldb" data-go="section" data-section="payment-log"><span class="ic">$</span><span><strong>Record Payment</strong><br><small>Card, cash or PayPal in seconds</small></span></button>
      <button class="quick light" data-go="section" data-section="move-requests"><span class="ic">⇄</span><span><strong>Move Requests</strong><br><small>${moves ? moves + ' waiting · needs your OK first' : 'Date changes, approved by you'}</small></span></button>
    </div>

    ${events.length > 1 ? `<h3 class="section-title">Coming up</h3><div class="upcoming-list">${events.slice(1, 4).map(e => {
      const s = eventStats(admin, e);
      return `<button class="upcoming-row" data-go="event-day" data-event="${esc(e.id)}"><span class="up-date"><small>${esc(dateOf(e.date).toLocaleDateString('en-US', { weekday: 'short' }))}</small><strong>${esc(dateOf(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</strong></span><span class="up-main"><b>${esc(marketName(e))}</b><span>${s.vendors} vendors · ${s.indoorOpen + s.outdoorOpen} spots open</span></span><span class="chev">›</span></button>`;
    }).join('')}</div>` : ''}
  `;
  ctx.bindGo(root);
}
