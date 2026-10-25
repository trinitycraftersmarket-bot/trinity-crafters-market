// Application Recovery: vendor application attempts that failed
// validation, stopped during photo upload or submission, or sat
// unfinished for at least 10 minutes — with the captured form, the
// error log, a category-fit alert, and the organizer override that
// turns a usable attempt into a real approved application. Native v2
// port of the classic applicationRecoveryPanel: same admin-payload
// attempts, same status rules (failed / stale draft = abandoned /
// overridden = recovered / dismissed), same server actions
// ('application-attempt-dismiss', 'recover-application',
// 'attempt-photo'), and the same category-fit analysis (mirrors
// public/category-conflicts.js — kept in step deliberately). The
// server still blocks banned vendors, duplicates, closed areas,
// sold-out markets and full physical inventory on recovery.
// §22 additions: dismissed attempts can be reinstated to the working
// queue ('application-attempt-reinstate'), any unfinished attempt can
// be emailed a completion link ('application-attempt-email'), and
// attempts hit by the Oct 22–23 agreements form bug carry an
// "Our bug — fixed Oct 23" badge.
import { api, esc, nice, marketName } from './api.js?v=20261024-25';

// --- category fit (ported from public/category-conflicts.js) ---
const cleanText = v => String(v || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9&/' -]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set(['art', 'goods', 'good', 'product', 'products', 'item', 'items', 'business', 'service', 'services', 'handmade', 'artist', 'practical', 'other', 'category', 'non', 'profit', 'mlm', 'no', 'not', 'the', 'and', 'or', 'etc', 'do', 'use', 'for', 'a', 'an', 'sold', 'out']);
function wordVariants(word) {
  const w = cleanText(word), out = [w];
  if (/ies$/.test(w)) out.push(w.replace(/ies$/, 'y'));
  else if (/s$/.test(w) && !/(ss|us)$/.test(w)) out.push(w.slice(0, -1));
  return [...new Set(out.filter(Boolean))];
}
function categoryTerms(name) {
  const words = cleanText(String(name || '').replace(/\([^)]*\)/g, ' ')).split(' ').filter(w => w.length > 2 && !GENERIC.has(w));
  const terms = [];
  if (words.length) terms.push(words.join(' '));
  for (const w of words) terms.push(...wordVariants(w));
  return [...new Set(terms.filter(t => t.length > 2))];
}
const containsTerm = (text, term) => (' ' + cleanText(text) + ' ').includes(' ' + cleanText(term) + ' ');
export function analyzeCategoryFit(description, selectedCategory = '', categories = []) {
  const text = cleanText(description), selected = cleanText(selectedCategory);
  if (!text) return { matched: [], overlaps: [], likelyMismatch: false, unverifiedSelection: false, needsReview: false };
  const names = (categories || []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean);
  const matched = [...new Set(names.filter(name => categoryTerms(name).some(term => containsTerm(text, term))))];
  const selectedMatched = matched.some(name => cleanText(name) === selected);
  const overlaps = matched.filter(name => cleanText(name) !== selected);
  const selectedIsOther = selected.startsWith('other ');
  const unverifiedSelection = !!selected && !selectedMatched;
  const likelyMismatch = !!selected && matched.length > 0 && (!selectedMatched || selectedIsOther);
  return { matched, overlaps, likelyMismatch, unverifiedSelection, needsReview: unverifiedSelection || selectedIsOther || overlaps.length > 0 };
}
// --- end category fit ---

// §22: the agreements error is the signature of the Oct 22–23 v2
// 'nolm'/'nomlm' form bug — attempts carrying it in their technical
// history failed through no fault of the vendor. Same test the server
// uses for the completion-email apology (api.mjs attemptHasAgreementsError).
const AGREEMENTS_ERROR_TEXT = 'Read and accept every required agreement';
export const attemptOurBug = x => String(x.error_message || '').includes(AGREEMENTS_ERROR_TEXT)
  || (Array.isArray(x.error_log) ? x.error_log : []).some(e => String(e?.message || '').includes(AGREEMENTS_ERROR_TEXT));
// Mirror of the server's attemptMissingItems (api.mjs): what the
// completion email will list as still missing for this attempt.
export function attemptMissingItems(x) {
  const s = x.snapshot || {}, missing = [];
  if (!s.name) missing.push('your name');
  if (!s.business) missing.push('your business name');
  if (String(s.phone || '').replace(/[^0-9]/g, '').length < 10) missing.push('a valid phone number');
  if (!s.description) missing.push('a description of what you sell');
  if (!s.category) missing.push('your product category');
  if (!(s.dates || []).length) missing.push('at least one market date');
  if (!(s.photos || []).length) missing.push('at least one product photo');
  const ag = s.agreements || {};
  if (!['nonrefundable', 'rain', 'nomlm', 'facebook', 'stayuntil3', 'hurricane', 'paymentready', 'contract'].every(k => ag[k] === true)) missing.push('reviewing and accepting the vendor agreements');
  if (!String(s.signature || '').trim()) missing.push('typing your full legal name as your signature');
  return missing;
}

const staleOf = x => ['draft', 'submitting'].includes(x.status) && Date.now() - new Date(x.last_seen_at).getTime() > 600000;
export const attemptStatusOf = x => x.status === 'overridden' ? 'Recovered' : x.status === 'dismissed' ? 'Dismissed' : x.status === 'failed' ? 'Failed' : staleOf(x) ? 'Abandoned' : 'In progress';
const activeOf = x => x.status === 'failed' || staleOf(x);

let view = { filter: 'active', q: '' };

export function renderAppRecovery(ctx, root) {
  const admin = () => ctx.state.admin;
  const attempts = () => admin().applicationAttempts || [];
  const eventLabel = id => {
    const e = (admin().events || []).find(v => String(v.id) === String(id)) || (admin().allEvents || []).find(v => String(v.id) === String(id));
    return e ? nice(e.date) + ' — ' + (e.location || marketName(e)) : String(id || 'Unknown date');
  };

  function dismissSheet(x) {
    ctx.openSheet(`
      <h3 class="sheet-title">Dismiss this attempt?</h3>
      <p><strong>${esc(x.business || x.name || x.email || 'Incomplete application')}</strong></p>
      <p class="note">It will stay in recovery history but leave the Needs review list.</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Keep</button><button class="btn danger" id="v2-rec-dismiss-go">Dismiss attempt</button></div>`);
    ctx.sheetEl.querySelector('#v2-rec-dismiss-go').onclick = async () => {
      ctx.closeSheet();
      try {
        await api('application-attempt-dismiss', { id: x.id });
        x.status = 'dismissed';
        x.reviewed_at = new Date().toISOString();
        draw();
        ctx.toast('Application attempt dismissed.');
      } catch (e) { ctx.toast(e.message, true); }
    };
  }

  function emailSheet(x) {
    const missing = attemptMissingItems(x);
    ctx.openSheet(`
      <p class="eyebrow">Application recovery</p>
      <h3 class="sheet-title">Email completion link</h3>
      <p><strong>${esc(x.business || x.name || 'Incomplete application')}</strong><br><span class="note">${esc(x.email || '')}</span></p>
      ${attemptOurBug(x) ? '<p class="note"><strong>Our bug — fixed Oct 23:</strong> this attempt hit the agreements error, so the email will include an apology — the form bug was on our end, not theirs.</p>' : ''}
      <p class="note">The email tells them their application never came through, links them to the application form (which reloads what they already entered), and lists what is still missing:</p>
      ${missing.length ? `<ul class="note">${missing.map(m => `<li>${esc(m[0].toUpperCase() + m.slice(1))}</li>`).join('')}</ul>` : '<p class="note">Nothing is missing — the email will ask them to review, re-check the agreements, sign, and submit.</p>'}
      <form id="v2-rec-email-form">
        <label class="sheet-field">Note to include (optional)<textarea name="note" rows="3" maxlength="1000" placeholder="Anything personal to add — it appears in the email as a note from you"></textarea></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-rec-email-send">Send email</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-rec-email-form').onsubmit = async e => {
      e.preventDefault();
      const note = new FormData(e.target).get('note');
      const btn = ctx.sheetEl.querySelector('#v2-rec-email-send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await api('application-attempt-email', { id: x.id, note: note || '' });
        x.emailed_at = r.emailed_at || new Date().toISOString();
        x.emailed_by = r.emailed_by || '';
        ctx.closeSheet();
        draw();
        if (r.email_delivery && !r.email_delivery.sent) ctx.toast('Email queued but not confirmed delivered' + (r.email_delivery.error ? ': ' + r.email_delivery.error : '.'), true);
        else ctx.toast('Completion link emailed to ' + (x.email || 'the vendor') + '.');
      } catch (err) { ctx.toast(err.message, true); btn.disabled = false; btn.textContent = 'Send email'; }
    };
  }

  async function reinstate(x) {
    try {
      const r = await api('application-attempt-reinstate', { id: x.id });
      x.status = r.status || 'draft';
      x.reviewed_at = null; x.reviewed_by = null;
      draw();
      ctx.toast('Attempt reinstated to the working queue as ' + (r.status === 'failed' ? 'Failed' : 'a draft') + '.');
    } catch (e) { ctx.toast(e.message, true); }
  }

  function recoverSheet(x) {
    const a = admin(), s = x.snapshot || {};
    const captured = Array.isArray(s.dates) && s.dates.length ? s.dates : [{ id: '', space: '' }];
    const eventOptions = sel => '<option value="">Choose market date</option>' + (a.events || []).map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(sel) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(e.location || marketName(e))}</option>`).join('');
    ctx.openSheet(`
      <p class="eyebrow">Application recovery</p>
      <h3 class="sheet-title">Approve Override</h3>
      <p><strong>${esc(x.email || '')}</strong></p>
      <p class="note">This creates a real approved application and emails the normal approval notice. It can bypass missing photos/agreements and category limits, but it cannot overbook physical booth capacity or bypass a vendor ban.</p>
      <form id="v2-rec-form">
        <label class="sheet-field">Vendor name<input name="name" value="${esc(s.name || x.name || '')}" required></label>
        <label class="sheet-field">Business<input name="business" value="${esc(s.business || x.business || '')}" required></label>
        <label class="sheet-field">Phone<input name="phone" value="${esc(s.phone || x.phone || '')}" required></label>
        <label class="sheet-field">Billing address<input name="billing_address" value="${esc(s.billing_address || '')}"></label>
        <label class="sheet-field">What they sell<textarea name="description" rows="4">${esc(s.description || '')}</textarea></label>
        <label class="sheet-field">Category<select name="category" required><option value="">Choose category</option>${(a.categories || []).map(cat => `<option value="${esc(cat.id)}" ${String(cat.id) === String(s.category || x.category_id) ? 'selected' : ''}>${esc(cat.name)}</option>`).join('')}</select></label>
        ${captured.map((d, n) => `
          <div class="card recover-date">
            <strong>Market date ${n + 1}</strong>
            <label class="sheet-field">Date<select data-recover-event required>${eventOptions(d.id)}</select></label>
            <label class="sheet-field">Space<select data-recover-space required><option value="">Choose space</option><option value="indoor" ${d.space === 'indoor' ? 'selected' : ''}>Indoor</option><option value="outdoor" ${d.space === 'outdoor' ? 'selected' : ''}>Outdoor</option></select></label>
          </div>`).join('')}
        <label class="checkline"><input type="checkbox" name="confirm_override" required> I understand this is an administrator recovery override and I have reviewed the captured information.</label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Approve &amp; Recover Application</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-rec-form').onsubmit = async e => {
      e.preventDefault();
      const form = e.target, fd = new FormData(form);
      const dates = [...form.querySelectorAll('.recover-date')].map(row => ({
        id: row.querySelector('[data-recover-event]').value,
        space: row.querySelector('[data-recover-space]').value
      }));
      try {
        const r = await api('recover-application', { id: x.id, data: { name: fd.get('name'), business: fd.get('business'), phone: fd.get('phone'), billing_address: fd.get('billing_address'), description: fd.get('description'), category: fd.get('category'), dates } });
        ctx.closeSheet();
        await ctx.refreshAdmin();
        draw();
        ctx.toast('Application recovered and approved for ' + (r.bookings?.length || dates.length) + ' market date' + ((r.bookings?.length || dates.length) === 1 ? '' : 's') + '.');
      } catch (err) { ctx.toast(err.message, true); }
    };
  }

  function card(x) {
    const a = admin(), s = x.snapshot || {};
    const dates = (s.dates || []).map(d => esc(eventLabel(d.id)) + ' · ' + esc(d.space || 'space not chosen')).join('<br>') || 'No market date was captured';
    const errors = Array.isArray(x.error_log) ? x.error_log : [];
    const photos = Array.isArray(s.photos) ? s.photos : [];
    const missing = [!s.name && 'name', !s.business && 'business', !s.phone && 'phone', !s.category && 'category', !(s.dates || []).length && 'market date'].filter(Boolean);
    const savedScan = s.category_scan && Array.isArray(s.category_scan.matched_categories) ? s.category_scan : null;
    const localReview = analyzeCategoryFit(s.description || '', x.category_name || '', a.categories || []);
    const matched = savedScan?.matched_categories?.length ? savedScan.matched_categories : localReview.matched;
    const matchedCats = (a.categories || []).filter(c => matched.includes(c.name));
    const selectedDateIds = (s.dates || []).map(d => String(d.id));
    const filled = [...new Set(matchedCats.filter(c => Number(c.vendor_limit) > 0 && selectedDateIds.some(eventId => {
      const used = (a.counts || []).find(v => String(v.event_id) === eventId && String(v.category_id) === String(c.id))?.used || 0;
      return used >= Number(c.vendor_limit);
    })).map(c => c.name))];
    const mismatch = (savedScan ? savedScan.selected_category_match === false : localReview.likelyMismatch) || matched.some(name => name !== x.category_name);
    const categoryAlert = (filled.length || mismatch) ? `<div class="note cat-alert"><strong>⚠ Category review needed</strong><br>Selected: ${esc(x.category_name || 'Not selected')}${matched.length ? '<br>Description matches: ' + matched.map(esc).join(' · ') : ''}${filled.length ? '<br><strong>Filled/sold-out conflict: ' + filled.map(esc).join(' · ') + '</strong>' : ''}</div>` : '';
    const uniqueErrors = [...new Map(errors.map(e => [(e.step || '') + '|' + (e.message || ''), e])).values()].slice(-8);
    const problem = x.step === 'validation' ? 'Application was incomplete. The vendor did not finish all required fields, agreements, photos, or space selections.' : (x.error_message || '');
    const st = attemptStatusOf(x);
    return `<article class="card vendor">
      <div class="vendor-top">
        <div><h3>${esc(x.business || x.name || x.email || 'Incomplete application')}</h3>
        <div class="contact">${esc(x.email || '')}${x.phone ? ' · ' + esc(x.phone) : ''}</div></div>
        <span class="status ${x.status === 'failed' ? 'bad' : x.status === 'overridden' ? 'ok' : 'warn'}">${esc(st)}</span>
      </div>
      ${attemptOurBug(x) ? '<p class="note"><span class="status bad">Our bug — fixed Oct 23</span> This attempt hit the agreements form bug — the vendor did nothing wrong.</p>' : ''}
      <p class="note"><strong>Last activity:</strong> ${esc(new Date(x.last_seen_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}<br>
      <strong>Last step:</strong> ${esc(x.step || 'form')}${x.category_name ? '<br><strong>Category:</strong> ' + esc(x.category_name) : ''}</p>
      ${x.emailed_at ? `<p class="note"><strong>Completion link emailed:</strong> ${esc(new Date(x.emailed_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}${x.emailed_by ? ' by ' + esc(x.emailed_by) : ''}</p>` : ''}
      <p class="note"><strong>Requested date(s):</strong><br>${dates}</p>
      ${categoryAlert}
      ${problem ? `<p class="note"><strong>What happened:</strong><br>${esc(problem)}</p>` : ''}
      ${missing.length ? `<p class="note"><strong>Missing from captured form:</strong> ${missing.map(esc).join(', ')}</p>` : ''}
      <details class="flag-details"><summary>View captured application details</summary>
        <p class="note"><strong>Description:</strong> ${esc(s.description || 'Not captured')}</p>
        <p class="note"><strong>Photos:</strong> ${photos.length ? photos.length + ' uploaded' : 'No completed photo uploads captured'}</p>
        <p class="note"><strong>Agreements checked:</strong> ${Object.entries(s.agreements || {}).filter(([, v]) => v).map(([k]) => esc(k)).join(' · ') || 'None captured'}</p>
        ${uniqueErrors.length ? `<details class="flag-details"><summary>Technical history (${errors.length} logged event${errors.length === 1 ? '' : 's'})</summary>${uniqueErrors.map(e => `<p class="note"><small>${esc(new Date(e.at).toLocaleString('en-US', { timeZone: 'America/New_York' }))} · ${esc(e.step || '')}</small><br>${esc(e.message || '')}</p>`).join('')}</details>` : ''}
        ${photos.length ? `<div class="vendor-actions">${photos.map(p => `<button class="btn small" data-attempt-photo="${esc(p)}">View uploaded photo</button>`).join('')}</div>` : ''}
      </details>
      <div class="vendor-actions">
        ${activeOf(x) ? `<button class="btn primary small" data-recover-attempt="${esc(x.id)}">Approve Override</button><button class="btn small ghost" data-dismiss-attempt="${esc(x.id)}">Dismiss</button>` : st === 'In progress' ? '<span class="status warn">Vendor is still working on this form</span>' : ''}
        ${x.status === 'dismissed' ? `<button class="btn small" data-reinstate-attempt="${esc(x.id)}">Reinstate</button>` : ''}
        ${x.status !== 'overridden' ? `<button class="btn small" data-email-attempt="${esc(x.id)}">Email completion link</button>` : ''}
        ${x.status === 'overridden' && x.application_id ? '<span class="status ok">Moved to approved applications</span>' : ''}
      </div>
    </article>`;
  }

  function draw() {
    const q = view.q;
    const rows = attempts().filter(x => {
      const st = attemptStatusOf(x);
      const ok = view.filter === 'all' || (view.filter === 'active' && activeOf(x)) || (view.filter === 'failed' && x.status === 'failed')
        || (view.filter === 'abandoned' && st === 'Abandoned') || (view.filter === 'overridden' && x.status === 'overridden') || (view.filter === 'dismissed' && x.status === 'dismissed');
      const hay = [x.name, x.business, x.email, x.phone, x.error_message, x.step, x.category_name, x.snapshot?.description].join(' ').toLowerCase();
      return ok && (!q || hay.includes(q));
    });
    root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Application Recovery</h2>
    <p class="lede">Failed &amp; abandoned applications. This catches vendor forms that fail validation, stop during photo upload or submission, or are left unfinished for at least 10 minutes — recover a usable attempt into an approved application.</p>
    <div class="card">
      <p class="note"><strong>Recovery override:</strong> missing photos or vendor-side agreement checks may be overridden by you. The system will still block banned vendors, duplicate bookings, closed booth areas, sold-out markets, and physically full booth inventory.</p>
      <div class="filter-row">
        <label class="picker-label">Status<select id="v2-rec-filter" class="picker"><option value="active">Needs review</option><option value="failed">Failed</option><option value="abandoned">Abandoned</option><option value="overridden">Recovered</option><option value="dismissed">Dismissed</option><option value="all">All attempts</option></select></label>
        <label class="picker-label grow">Search<input id="v2-rec-search" class="picker" type="search" placeholder="Name, business, email, phone or error" value="${esc(view.q)}"></label>
      </div>
      <p class="note">${rows.length} application attempt${rows.length === 1 ? '' : 's'} shown.</p>
    </div>
    <div class="vendor-list">${rows.map(card).join('') || '<div class="card empty-card">No application attempts match this view.</div>'}</div>`;
    root.querySelector('#v2-rec-filter').value = view.filter;
    root.querySelector('#v2-rec-filter').onchange = e => { view.filter = e.target.value; draw(); };
    const search = root.querySelector('#v2-rec-search');
    search.oninput = () => { view.q = search.value.trim().toLowerCase(); draw(); const s2 = root.querySelector('#v2-rec-search'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); };
    root.querySelectorAll('[data-dismiss-attempt]').forEach(b => b.onclick = () => {
      const x = attempts().find(v => String(v.id) === b.dataset.dismissAttempt);
      if (x) dismissSheet(x);
    });
    root.querySelectorAll('[data-recover-attempt]').forEach(b => b.onclick = () => {
      const x = attempts().find(v => String(v.id) === b.dataset.recoverAttempt);
      if (x) recoverSheet(x);
    });
    root.querySelectorAll('[data-reinstate-attempt]').forEach(b => b.onclick = () => {
      const x = attempts().find(v => String(v.id) === b.dataset.reinstateAttempt);
      if (x) reinstate(x);
    });
    root.querySelectorAll('[data-email-attempt]').forEach(b => b.onclick = () => {
      const x = attempts().find(v => String(v.id) === b.dataset.emailAttempt);
      if (x) emailSheet(x);
    });
    root.querySelectorAll('[data-attempt-photo]').forEach(b => b.onclick = async () => {
      try {
        const v = await api('attempt-photo', undefined, { path: b.dataset.attemptPhoto });
        const img = document.createElement('img');
        img.src = v.url;
        img.alt = 'Recovered vendor product photo';
        img.className = 'attempt-photo-img';
        b.replaceWith(img);
      } catch (e) { ctx.toast(e.message, true); }
    });
  }

  draw();
}
