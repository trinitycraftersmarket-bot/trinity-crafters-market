// Food Truck Application (public): native v2 port of the classic public
// form (classic food-trucks.js publicPage, audit §20 Stage H). Same
// food-trucks function contract, mirrored exactly: anonymous GET lists
// the upcoming dates with per-date availability; the POST payload is
// {event_ids, name, email, phone, billing_address, food_type, wrapped,
// propane, rig_size, permits, insurance, photos} with photos as
// {name, size, type, data, rig} data-URL objects (rig = the first file).
// The function itself requires a signed-in account at submit (it stores
// user_id and answers "Sign in to continue." without one) — that was
// true on the classic page too, so the form renders publicly here and
// surfaces the same error, with a sign-in path that returns to the form.
import { esc, getToken, money, nice } from './api.js?v=20261024-31';

async function ftCall(method, body) {
  const r = await fetch('/.netlify/functions/food-trucks', {
    method,
    headers: { ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Request failed.');
  return v;
}

export function renderFoodTruckApply(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Food Trucks</p>
    <h2 class="display">Food Truck Application</h2>
    <div class="card empty-card">Loading available dates…</div>`;

  const draw = async () => {
    const d = await ftCall('GET');
    const events = d.events || [];
    const price = Number(d.price ?? 3500);
    root.innerHTML = `
      <p class="eyebrow">Food Trucks</p>
      <h2 class="display">Food Truck Application</h2>
      <p class="lede">Each market date has <strong>one food truck space for ${money(price)}</strong>. As soon as an application is submitted for a date, that date is held and shown as sold out while it is reviewed. If the application is declined, the date automatically reopens.</p>
      ${events.length ? `
      <form id="v2-trucks-form">
        <section class="card">
          <h3 class="section-title">Market dates</h3>
          <p class="note">Select every available date you would like to attend. Sold-out dates cannot be selected.</p>
          ${events.map(e => e.available
            ? `<label class="checkline"><input type="checkbox" name="event_id" value="${esc(e.id)}"><span><strong>${esc(nice(e.date))}</strong><br><span class="note">${esc(e.market_name || e.title || e.location)} · ${money(price)} · Available</span></span></label>`
            : `<div class="apply-date"><div><strong>${esc(nice(e.date))}</strong><br><span class="note">${esc(e.market_name || e.title || e.location)} · <strong>SOLD OUT</strong></span></div></div>`).join('')}
        </section>
        <section class="card">
          <h3 class="section-title">Your details</h3>
          <label class="sheet-field">Name<input name="name" autocomplete="name" required></label>
          <label class="sheet-field">Email<input name="email" type="email" autocomplete="email" required></label>
          <label class="sheet-field">Phone<input name="phone" type="tel" autocomplete="tel" required></label>
          <label class="sheet-field">Billing address<input name="billing_address" autocomplete="street-address" required></label>
        </section>
        <section class="card">
          <h3 class="section-title">Your truck</h3>
          <label class="sheet-field">What type of food do you have?<textarea name="food_type" rows="3" required></textarea></label>
          <label class="sheet-field">Is your rig wrapped? (A wrapped rig helps attract customers.)<select name="wrapped"><option value="yes">Yes</option><option value="no">No</option></select></label>
          <label class="sheet-field">Do you use propane?<select name="propane"><option value="no">No</option><option value="yes">Yes</option></select></label>
          <label class="sheet-field">How big is your rig?<input name="rig_size" placeholder="Example: 20 ft long × 8 ft wide" required></label>
          <label class="checkline"><input type="checkbox" name="permits" required><span>I have the proper permits required to operate.</span></label>
          <label class="checkline"><input type="checkbox" name="insurance" required><span>I have current insurance.</span></label>
        </section>
        <section class="card">
          <h3 class="section-title">Photos</h3>
          <p class="note"><strong>Photos:</strong> Upload 1 required picture of your rig and up to 4 additional food/menu photos. Maximum 10 MB per photo.</p>
          <label class="sheet-field">Rig photo (required)<input name="rig_photo" type="file" accept="image/*" required></label>
          <label class="sheet-field">Food/menu photos (up to 4)<input name="food_photos" type="file" accept="image/*" multiple></label>
          <p class="note" id="v2-trucks-total">Select at least one market date · Estimated invoice total: $0.00</p>
          <p class="note" id="v2-trucks-signin" hidden>You need to sign in before your application can be submitted. Sign in with your email, and you will come right back to this form. <button type="button" class="btn small" id="v2-trucks-signin-btn">Sign in</button></p>
          <div class="vendor-actions"><button class="btn primary" id="v2-trucks-submit" type="submit">Submit Food Truck Application</button></div>
        </section>
      </form>` : '<div class="card empty-card"><strong>All currently listed food truck dates are filled.</strong></div>'}`;

    const f = root.querySelector('#v2-trucks-form');
    if (!f) return;
    // Named access (form.name) is shadowed by HTMLFormElement's own
    // properties — always go through elements.namedItem.
    const F = n => f.elements.namedItem(n);
    const updateTotal = () => {
      const n = f.querySelectorAll('[name="event_id"]:checked').length;
      const box = root.querySelector('#v2-trucks-total');
      if (box) box.textContent = (n ? n + ' market date' + (n === 1 ? '' : 's') + ' selected' : 'Select at least one market date') + ' · Estimated invoice total: $' + (n * price / 100).toFixed(2);
    };
    f.querySelectorAll('[name="event_id"]').forEach(x => x.addEventListener('change', updateTotal));
    updateTotal();

    f.onsubmit = async e => {
      e.preventDefault();
      const event_ids = [...f.querySelectorAll('[name="event_id"]:checked')].map(x => x.value);
      if (!event_ids.length) { ctx.toast('Select at least one market date.', true); return; }
      const rig = F('rig_photo').files[0];
      if (!rig) { ctx.toast('Add a photo of your rig.', true); return; }
      const foods = [...F('food_photos').files];
      if (foods.length > 4) { ctx.toast('Choose no more than 4 food/menu photos.', true); return; }
      const files = [rig, ...foods];
      if (files.some(x => x.size > 10485760)) { ctx.toast('Each photo must be 10 MB or smaller.', true); return; }
      const read = x => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ name: x.name, size: x.size, type: x.type, data: r.result }); r.onerror = rej; r.readAsDataURL(x); });
      const photos = [];
      for (let i = 0; i < files.length; i++) { const x = await read(files[i]); x.rig = i === 0; photos.push(x); }
      const fd = new FormData(f), p = Object.fromEntries(fd.entries());
      p.event_ids = event_ids;
      delete p.event_id; delete p.rig_photo; delete p.food_photos;
      p.wrapped = p.wrapped === 'yes'; p.propane = p.propane === 'yes';
      p.permits = F('permits').checked; p.insurance = F('insurance').checked;
      p.photos = photos;
      const b = root.querySelector('#v2-trucks-submit');
      try {
        b.disabled = true;
        await ftCall('POST', p);
        root.innerHTML = `
          <p class="eyebrow">Food Trucks</p>
          <h2 class="display">Application Received</h2>
          <section class="card"><p>Thank you. Your food truck application has been submitted for review. Check your email for confirmation.</p></section>`;
        window.scrollTo(0, 0);
      } catch (x) {
        ctx.toast(x.message, true);
        // The function requires a signed-in account at submit (same as
        // the classic page): offer the round trip back to this form.
        if (/sign in/i.test(x.message)) {
          const note = root.querySelector('#v2-trucks-signin');
          if (note) { note.hidden = false; note.querySelector('#v2-trucks-signin-btn').onclick = () => ctx.showSignIn(); }
        }
      } finally { if (b.isConnected) b.disabled = false; }
    };
  };

  draw().catch(e => {
    root.innerHTML = `
      <p class="eyebrow">Food Trucks</p>
      <h2 class="display">Food Truck Application</h2>
      <div class="card empty-card">${esc(e.message)}</div>`;
  });
}
