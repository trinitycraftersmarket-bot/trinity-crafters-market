// Shopper RSVPs (Market Day): the free shopper headcount per market
// date, from the rsvp-list action — the same rows the legacy Shopper
// RSVPs report shows. Available to the organizer and to managers with
// the shopper_rsvps permission (the server enforces both). Read-only:
// RSVPs are created by shoppers on the public site.
import { api, esc, nice } from './api.js?v=20261023-7';

export function renderRsvps(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Market Day</p>
    <h2 class="display">Shopper RSVPs</h2>
    <p class="lede">Who's coming to shop — a headcount for planning, not a vendor list.</p>
    <div id="v2-rsvp-box"><div class="card empty-card">Loading RSVPs…</div></div>`;
  const box = root.querySelector('#v2-rsvp-box');

  async function load() {
    let rows;
    try {
      rows = await api('rsvp-list');
    } catch (e) {
      box.innerHTML = `<div class="card empty-card"><p><strong>RSVPs couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    rows = rows || [];
    const dates = [...new Map(rows.map(r => [String(r.event_id), r])).values()];
    box.innerHTML = `
      <label class="picker-label">Market date
        <select id="v2-rsvp-date" class="picker"><option value="">All dates</option>${dates.map(r => `<option value="${esc(r.event_id)}">${esc(nice(r.date))} — ${esc(r.location || '')}</option>`).join('')}</select>
      </label>
      <div id="v2-rsvp-list"></div>`;
    const listEl = box.querySelector('#v2-rsvp-list');
    const draw = () => {
      const chosen = box.querySelector('#v2-rsvp-date').value;
      const current = rows.filter(r => !chosen || String(r.event_id) === String(chosen));
      const guests = current.reduce((n, r) => n + Number(r.party_size || 0), 0);
      listEl.innerHTML = `
        <p class="note"><strong>${current.length} RSVP${current.length === 1 ? '' : 's'} · ${guests} guest${guests === 1 ? '' : 's'} expected</strong></p>
        <div class="vendor-list">${current.map(r => `
          <article class="card vendor">
            <div class="vendor-top"><div><h3>${esc(r.name)}</h3>
            <div class="contact">${esc(nice(r.date))} — ${esc(r.location || '')} · ${r.party_size} guest${Number(r.party_size) === 1 ? '' : 's'}</div></div></div>
            <p class="note">${esc(r.email)} · Heard via ${esc(r.referral_source || '—')}${r.referral_group ? ' — ' + esc(r.referral_group) : ''}</p>
          </article>`).join('') || '<div class="card empty-card">No RSVPs for this selection yet.</div>'}</div>`;
    };
    box.querySelector('#v2-rsvp-date').onchange = draw;
    draw();
  }
  load();
}
