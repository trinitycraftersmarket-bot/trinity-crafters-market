// Manual Booking: book a vendor by hand (paper / PDF sign-ups, or a vendor
// whose online application failed). Native v2 port of the legacy Manual
// Booking panel — same endpoint (/.netlify/functions/manual-booking), same
// payloads, same rules:
//   - Search fills the form from a returning vendor's saved records;
//     otherwise the vendor is created on first save.
//   - Tick ANY number of upcoming dates; each row carries its own
//     Inside/Outside space and rate. One submit books every ticked date
//     (one POST per date, sequentially) and reports per date: failures
//     stay ticked with the server's reason so they can be fixed and
//     re-saved without re-doing the successes.
//   - Cash and credit card bookings are recorded as paid; Monthly Billing
//     records an amount due. Each booked date gets its own confirmation
//     email from the server.
//   - Credit card is ONE date at a time: the server verifies the GoDaddy
//     charge against the booking amount, so a combined multi-date charge
//     can never match. The amount override is editable only for a single
//     date; for several dates it shows the combined total, read-only.
import { esc, getToken, nice } from './api.js?v=20261023-9';

// The legacy panel shows cents ($45.00); keep that exact formatting here.
const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);

// Transport for the manual-booking function: GET (base data / vendor
// search) and POST (one booking), token-authenticated, exactly the calls
// the legacy panel makes.
async function mbCall(method, body, query = '') {
  const r = await fetch('/.netlify/functions/manual-booking' + query, {
    method,
    headers: { Authorization: 'Bearer ' + getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Could not complete request.');
  return v;
}

export function renderManualBooking(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Manual Booking</h2>
    <p class="lede">Use this when a vendor books directly with you — at a market, from a paper or PDF sign-up, or when their online application won't go through. Search for a returning vendor or add a new one below.</p>
    <div id="v2-mb-slot"><div class="card empty-card">Loading market dates…</div></div>`;

  const slot = root.querySelector('#v2-mb-slot');
  mbCall('GET').then(d => drawForm(d)).catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Manual Booking couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });

  function drawForm(d) {
    slot.innerHTML = `
    <section class="card">
      <p class="note">Cash and credit card bookings are recorded as paid; Monthly Billing records an amount due. Tick every market date to book — saving books them all and sends a booking confirmation email for each date.</p>
      <div id="v2-mb-result"></div>
      <form id="v2-mb-form">
        <label class="sheet-field">Search existing vendors<input id="v2-mb-search" type="search" autocomplete="off" placeholder="Name, business, email or phone"></label>
        <p class="note" id="v2-mb-search-status" role="status">Type at least 2 characters to search.</p>
        <div id="v2-mb-results" class="mb-results"></div>
        <div class="vendor-actions"><button type="button" class="btn small" id="v2-mb-new">Add new vendor</button></div>
        <p class="note" id="v2-mb-selection"></p>
        <label class="sheet-field">Vendor name<input name="name" required></label>
        <label class="sheet-field">Business name (optional)<input name="business"></label>
        <label class="sheet-field">Email address<input name="email" type="email" required></label>
        <label class="sheet-field">Phone number<input name="phone" type="tel" required></label>
        <label class="sheet-field">What do they sell?<textarea name="selling" rows="4" required></textarea></label>
        <label class="sheet-field">Product category<select name="category_id"><option value="">Other / choose automatically</option>${(d.categories || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <fieldset class="mb-fieldset">
          <legend>Market dates — tick every date to book</legend>
          <div class="mb-list">${(d.events || []).map(e => `
            <div class="mb-row">
              <label class="mb-pick"><input type="checkbox" class="mb-check" value="${esc(e.id)}" data-label="${esc(nice(e.date))}" data-inside="${e.indoor_price}" data-outside="${e.outdoor_price}"><span>${esc(nice(e.date))} — ${esc(e.market_name || e.title || e.location || 'Crafters Market')}</span></label>
              <select class="mb-space" aria-label="Space"><option value="Inside">Inside</option><option value="Outside">Outside</option></select>
              <span class="mb-rate"></span>
            </div>`).join('') || '<p class="note">No upcoming market dates.</p>'}
          </div>
          <p class="note" id="v2-mb-summary">No dates ticked yet.</p>
        </fieldset>
        <label class="sheet-field">Payment method<select name="payment_method" required><option value="cash">Cash</option><option value="credit card">Credit card</option><option value="monthly billing">Monthly Billing</option></select></label>
        <label class="sheet-field">Amount paid ($)<input name="amount" type="number" min="0" step="0.01" required></label>
        <div id="v2-mb-cardbox" class="card content-card" hidden>
          <h3 class="section-title first">Credit card payment</h3>
          <p class="note" id="v2-mb-card-amount">Process this card securely with GoDaddy Payments. Card details are never entered or stored on this website.</p>
          <div class="vendor-actions"><a class="btn small" href="https://spa.commerce.godaddy.com/" target="_blank" rel="noopener">Open GoDaddy Virtual Terminal</a></div>
          <label class="sheet-field">GoDaddy Txn ID<input name="payment_reference" autocomplete="off" placeholder="Example: 92892acb"></label>
        </div>
        <p class="note" id="v2-mb-price-note"></p>
        <div class="sheet-actions"><button class="btn primary" id="v2-mb-save">Save booking &amp; email confirmation</button></div>
      </form>
    </section>`;

    const form = slot.querySelector('#v2-mb-form');
    const amount = form.elements.namedItem('amount');
    const note = slot.querySelector('#v2-mb-price-note');
    const cardBox = slot.querySelector('#v2-mb-cardbox');
    const cardAmount = slot.querySelector('#v2-mb-card-amount');
    const cardRef = form.elements.namedItem('payment_reference');
    const summary = slot.querySelector('#v2-mb-summary');
    const result = slot.querySelector('#v2-mb-result');
    const search = slot.querySelector('#v2-mb-search');
    const results = slot.querySelector('#v2-mb-results');
    const status = slot.querySelector('#v2-mb-search-status');
    const selection = slot.querySelector('#v2-mb-selection');
    const newVendor = slot.querySelector('#v2-mb-new');
    const save = slot.querySelector('#v2-mb-save');
    const rows = [...form.querySelectorAll('.mb-row')].map(row => ({
      row,
      check: row.querySelector('.mb-check'),
      space: row.querySelector('.mb-space'),
      rate: row.querySelector('.mb-rate')
    }));
    const rowCents = r => r.space.value === 'Inside' ? Number(r.check.dataset.inside || 0) : Number(r.check.dataset.outside || 0);
    const picked = () => rows.filter(r => r.check.checked);
    const fields = ['name', 'business', 'email', 'phone', 'selling', 'category_id'];
    let searchVersion = 0, timer = null, busy = false;

    const clearSearch = () => {
      clearTimeout(timer); searchVersion++;
      search.value = ''; results.replaceChildren();
      status.textContent = 'Type at least 2 characters to search.';
    };
    const selectVendor = v => {
      fields.forEach(key => { form.elements.namedItem(key).value = v[key] || ''; });
      const missing = ['email', 'phone'].filter(key => !String(v[key] || '').trim());
      clearSearch();
      selection.textContent = 'Using ' + (v.business || v.name || v.email) + '. ' + (missing.length
        ? 'No saved ' + missing.join(' or ') + ' found. Enter the missing details below.'
        : 'Email and phone filled from saved records. Review before saving.');
      form.elements.namedItem('name').focus();
    };
    newVendor.onclick = () => {
      if (busy) return;
      clearSearch();
      fields.forEach(key => { form.elements.namedItem(key).value = ''; });
      selection.textContent = 'New vendor — enter their details below. They will be added when you save the booking.';
      form.elements.namedItem('name').focus();
    };
    search.oninput = () => {
      clearTimeout(timer);
      const version = ++searchVersion, q = search.value.trim();
      results.replaceChildren();
      if (q.length < 2) { status.textContent = 'Type at least 2 characters to search.'; return; }
      status.textContent = 'Searching vendors…';
      timer = setTimeout(async () => {
        try {
          const response = await mbCall('GET', undefined, '?q=' + encodeURIComponent(q));
          if (version !== searchVersion || !form.isConnected) return;
          const vendors = response.vendors || [];
          status.textContent = vendors.length
            ? vendors.length + ' match' + (vendors.length === 1 ? '' : 'es') + '. Select a vendor to fill in their details.' + (vendors.length === 25 ? ' Refine your search if needed.' : '')
            : 'No matching vendors. Choose Add new vendor to enter their details.';
          vendors.forEach(v => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn small mb-result-btn';
            b.textContent = [v.business || v.name, v.business ? v.name : '', v.email || 'No saved email', v.phone || 'No saved phone'].filter(Boolean).join(' · ');
            b.onclick = () => { if (!busy) selectVendor(v); };
            results.appendChild(b);
          });
        } catch (err) {
          if (version === searchVersion && form.isConnected)
            status.textContent = 'Vendor search unavailable: ' + err.message + ' Try searching again, or enter the vendor details below.';
        }
      }, 250);
    };

    const price = () => {
      rows.forEach(r => { r.rate.textContent = usd(rowCents(r)); });
      const sel = picked(), total = sel.reduce((s, r) => s + rowCents(r), 0);
      const isCard = form.elements.namedItem('payment_method').value === 'credit card';
      amount.value = (total / 100).toFixed(2);
      amount.readOnly = sel.length > 1;
      cardBox.hidden = !isCard;
      cardRef.required = isCard && sel.length === 1;
      cardAmount.textContent = 'Process ' + usd(total) + ' securely with GoDaddy Payments. Card details are never entered or stored on this website. After approval, return here and enter the GoDaddy Txn ID shown on the receipt (for example, 92892acb).';
      summary.textContent = sel.length ? sel.length + ' date' + (sel.length === 1 ? '' : 's') + ' ticked — total ' + usd(total) + '.' : 'No dates ticked yet.';
      note.textContent = !sel.length ? 'Tick at least one market date.'
        : sel.length > 1 ? 'Each ticked date is booked at its own rate for the space picked on its row; the amount above is the combined total.'
          + (form.elements.namedItem('payment_method').value === 'monthly billing' ? ' Monthly Billing selected — an amount due is recorded per date.' : isCard ? ' Credit card bookings are one date at a time so the GoDaddy charge matches the booking.' : '')
        : 'Current ' + sel[0].space.value.toLowerCase() + ' rate: ' + usd(rowCents(sel[0])) + '. '
          + (form.elements.namedItem('payment_method').value === 'monthly billing' ? 'Monthly Billing selected — an invoice will go out; this is the amount due.' : isCard ? 'Credit card selected — process the payment above before saving.' : 'You can change the amount if needed.');
    };
    rows.forEach(r => { r.check.onchange = price; r.space.onchange = price; });
    form.elements.namedItem('payment_method').onchange = price;
    price();

    form.onsubmit = async e => {
      e.preventDefault();
      if (busy) return;
      const sel = picked();
      if (!sel.length) { result.innerHTML = '<p class="note flag-note">Tick at least one market date to book.</p>'; return; }
      const base = Object.fromEntries(new FormData(form).entries());
      if (base.payment_method === 'credit card') {
        if (sel.length > 1) {
          result.innerHTML = '<p class="note flag-note">Credit card bookings are one date at a time, so the GoDaddy charge matches the booking amount. Untick all but one date, or choose Cash / Monthly Billing to book several dates at once.</p>';
          return;
        }
        if (!String(base.payment_reference || '').trim()) {
          result.innerHTML = '<p class="note flag-note">Process the card in GoDaddy first, then enter the GoDaddy Txn ID shown on the receipt.</p>';
          cardRef.focus();
          return;
        }
      }
      const singleAmount = amount.value;
      busy = true; save.disabled = true; newVendor.disabled = true; search.disabled = true;
      clearSearch();
      const done = [], failed = [];
      try {
        for (const r of sel) {
          const payload = { ...base, event_id: r.check.value, space: r.space.value, amount: sel.length === 1 ? singleAmount : (rowCents(r) / 100).toFixed(2) };
          try { await mbCall('POST', payload); done.push(r); }
          catch (err) { failed.push({ r, err }); }
        }
      } finally {
        busy = false; save.disabled = false; newVendor.disabled = false; search.disabled = false;
      }
      done.forEach(r => { r.check.checked = false; });
      if (!failed.length) {
        result.innerHTML = `<p class="note"><strong>Booked ${done.length} date${done.length === 1 ? '' : 's'}.</strong> Confirmation${done.length === 1 ? '' : 's'} queued for ${esc(base.email)}.</p>`;
        ctx.toast('Manual booking saved for ' + done.length + ' date' + (done.length === 1 ? '' : 's') + '.');
        form.reset();
        selection.textContent = '';
      } else {
        result.innerHTML = `<p class="note flag-note"><strong>Booked ${done.length} of ${sel.length} dates for ${esc(base.email)}.</strong><br>Not booked: ${failed.map(f => esc(f.r.check.dataset.label) + ' (' + esc(f.err.message) + ')').join('; ')}.<br>The failed dates are still ticked — fix and save again.</p>`;
        ctx.toast('Booked ' + done.length + ' of ' + sel.length + ' dates — see the notes on the form.', failed.length === sel.length);
      }
      price();
      result.scrollIntoView({ block: 'nearest' });
    };
  }
}
