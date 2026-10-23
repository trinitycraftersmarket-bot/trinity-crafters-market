// Food Trucks: organizer review of food truck applications — one $35
// spot per market date. Native v2 port of the classic Food Trucks admin
// tab (food-trucks.js): same food-trucks function (GET ?admin=1 lists,
// PATCH decides), same rules — approving requires naming what the truck
// is approved to sell (and anything it may not), declining requires a
// reason, and Mark Paid settles the $35. The classic prompt() dialogs
// become bottom sheets here. The public application form stays on the
// classic public page; this screen is the organizer side.
import { esc, getToken, nice } from './api.js?v=20261023-8';

async function ftCall(method, body) {
  const r = await fetch('/.netlify/functions/food-trucks' + (method === 'GET' ? '?admin=1' : ''), {
    method,
    headers: { Authorization: 'Bearer ' + getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Food truck request failed.');
  return v;
}

export function renderFoodTrucks(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Food Trucks</h2>
    <p class="lede">One $35 food truck spot is available per market date. Approving names what the truck may sell; declining needs a reason and reopens the date.</p>
    <div id="v2-ft-slot"><div class="card empty-card">Loading food truck applications…</div></div>`;

  const slot = root.querySelector('#v2-ft-slot');
  let apps = [];

  const load = async () => {
    const d = await ftCall('GET');
    apps = d.applications || [];
    draw();
  };
  const decide = async (patch, okMsg) => {
    try {
      await ftCall('PATCH', patch);
      await load();
      ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function approveSheet(x) {
    ctx.openSheet(`
      <h3 class="sheet-title">Approve food truck</h3>
      <p><strong>${esc(x.name)}</strong> · ${esc(nice(x.date))} · ${esc(x.market_name || x.title || x.location || '')}</p>
      <form id="v2-ft-approve-form">
        <label class="sheet-field">Approved for — confirm or edit what this truck may sell<textarea name="approved" rows="3" required>${esc(x.approved_products || x.food_type || '')}</textarea></label>
        <label class="sheet-field">Not approved for — anything they may NOT sell (blank if none)<textarea name="declined" rows="2">${esc(x.declined_products || '')}</textarea></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Approve application</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-ft-approve-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const approved = String(f.get('approved') || '').trim();
      if (!approved) { ctx.toast('Enter what this food truck is approved to sell.', true); return; }
      ctx.closeSheet();
      decide({ id: x.id, status: 'approved', approved_products: approved, declined_products: String(f.get('declined') || '') }, 'Food truck approved.');
    };
  }
  function declineSheet(x) {
    ctx.openSheet(`
      <h3 class="sheet-title">Decline food truck</h3>
      <p><strong>${esc(x.name)}</strong> · ${esc(nice(x.date))} · ${esc(x.market_name || x.title || x.location || '')}</p>
      <form id="v2-ft-decline-form">
        <label class="sheet-field">Reason for declining<textarea name="reason" rows="3" required></textarea></label>
        <p class="note">Declining releases the date — it becomes available for another truck.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn danger">Decline application</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-ft-decline-form').onsubmit = e => {
      e.preventDefault();
      const reason = String(new FormData(e.target).get('reason') || '').trim();
      if (!reason) { ctx.toast('A decline reason is required.', true); return; }
      ctx.closeSheet();
      decide({ id: x.id, status: 'declined', reason }, 'Food truck declined — the date is open again.');
    };
  }

  function draw() {
    slot.innerHTML = `<div class="vendor-list">${apps.map(x => `
      <article class="card vendor">
        <div class="vendor-top">
          <div><h3>${esc(x.name)}</h3>
          <div class="contact">${esc(nice(x.date))} · ${esc(x.market_name || x.title || x.location || '')}</div></div>
          <span class="status ${x.status === 'approved' || x.status === 'paid' ? 'ok' : x.status === 'declined' ? 'bad' : 'warn'}">${esc(x.status)}${x.payment_status === 'paid' ? ' · paid' : ''}</span>
        </div>
        <p class="note"><strong>Food:</strong> ${esc(x.food_type || '')}</p>
        ${x.approved_products ? `<p class="note"><strong>Approved for:</strong> ${esc(x.approved_products)}<br><strong>Not approved for:</strong> ${esc(x.declined_products || 'None')}</p>` : ''}
        ${x.decision_reason ? `<p class="note"><strong>Decline reason:</strong> ${esc(x.decision_reason)}</p>` : ''}
        <p class="note"><strong>Phone:</strong> ${esc(x.phone || '')} · <strong>Email:</strong> ${esc(x.email || '')}<br>
        <strong>Billing:</strong> ${esc(x.billing_address || '')}<br>
        <strong>Rig:</strong> ${esc(x.rig_size || '')} · Wrapped: ${x.wrapped ? 'Yes' : 'No'} · Propane: ${x.propane ? 'Yes' : 'No'}<br>
        Permits: ${x.permits ? 'Yes' : 'No'} · Insurance: ${x.insurance ? 'Yes' : 'No'} · Photos: ${(x.photos || []).length}</p>
        <div class="vendor-actions">
          <button class="btn primary small" data-ft-act="approved" data-id="${esc(x.id)}">Approve</button>
          <button class="btn small" data-ft-act="declined" data-id="${esc(x.id)}">Decline</button>
          <button class="btn small" data-ft-act="paid" data-id="${esc(x.id)}">Mark Paid $35</button>
        </div>
      </article>`).join('') || '<div class="card empty-card">No food truck applications yet.</div>'}</div>`;
    slot.querySelectorAll('[data-ft-act]').forEach(btn => btn.onclick = () => {
      const x = apps.find(a => String(a.id) === btn.dataset.id);
      if (!x) return;
      if (btn.dataset.ftAct === 'approved') approveSheet(x);
      else if (btn.dataset.ftAct === 'declined') declineSheet(x);
      else decide({ id: x.id, status: 'paid' }, 'Marked paid — $35.');
    });
  }

  load().catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Food Trucks couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
