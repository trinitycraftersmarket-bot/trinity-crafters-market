// Vendor My Profile (AUDIT.md §13.7) + imported-vendor claiming (§13.5).
// Rendered into the account page next to My Bookings by public/app.js via
// window.renderMyProfile(container, categories). All state lives in
// market.vendor_profiles through /.netlify/functions/vendor-profile.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const token = () => sessionStorage.getItem('market-token') || '';
  async function post(body) {
    const r = await fetch('/.netlify/functions/vendor-profile', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token()}, body: JSON.stringify(body)});
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(v.error || 'Request failed');
    return v;
  }
  const MISSING_LABEL = {business: 'your business name', name: 'your contact name', category_id: 'your category', description: 'your products', phone: 'your phone number', space_preference: 'your space preference', website: 'your website', social_links: 'your social links'};
  const SPACE_LABEL = {indoor: 'Indoor', outdoor: 'Outdoor', none: 'No preference'};

  function hint(completeness) {
    if (!completeness) return '';
    if (completeness.percent >= 100) return '<p class="small">Your profile is complete — applying takes seconds.</p>';
    const first = (completeness.missing || [])[0];
    return `<p class="small">Your profile is ${completeness.percent}% complete${first ? ` — add ${MISSING_LABEL[first] || first} so applying takes seconds` : ''}.</p>`;
  }

  function render(el, categories, profile, note) {
    const p = profile || {};
    const cats = [{id: '', name: 'Choose a category…'}, ...(categories || [])];
    el.innerHTML = `<div class="card" style="margin-bottom:14px"><h3 style="margin-top:0">My profile</h3>
      ${hint(p.completeness)}
      ${note ? `<p class="small" style="color:var(--green)">${esc(note)}</p>` : ''}
      ${(p.linked_imported_ids || []).length ? '<p class="small">Your past market bookings from our records are linked to this account.</p>' : ''}
      <form class="form" data-profile-save>
        <label>Business name<input name="business" value="${esc(p.business || '')}" maxlength="200"></label>
        <label>Contact name<input name="name" value="${esc(p.name || '')}" maxlength="200"></label>
        <label>Category<select name="category_id">${cats.map(c => `<option value="${esc(c.id)}" ${String(p.category_id || '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Phone<input name="phone" value="${esc(p.phone || '')}" maxlength="30"></label>
        <label>What you sell<textarea name="description" rows="3" maxlength="5000">${esc(p.description || '')}</textarea></label>
        <label>Space preference<select name="space_preference">
          <option value="" ${!p.space_preference ? 'selected' : ''}>Not set</option>
          ${Object.entries(SPACE_LABEL).map(([v, l]) => `<option value="${v}" ${p.space_preference === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>Website<input name="website" value="${esc(p.website || '')}" maxlength="500" placeholder="https://…"></label>
        <label>Social links<input name="social_links" value="${esc(p.social_links || '')}" maxlength="1000" placeholder="Instagram, Facebook…"></label>
        <button class="btn primary">Save profile</button>
      </form>
      <p class="small">These details pre-fill your next application — update them once here and every future application starts filled in.</p></div>`;
    const form = el.querySelector('[data-profile-save]');
    form.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(form), body = {action: 'save'};
      for (const k of ['business', 'name', 'category_id', 'phone', 'description', 'space_preference', 'website', 'social_links']) body[k] = fd.get(k) ?? '';
      try {
        const v = await post(body);
        render(el, categories, v.profile, 'Profile saved.');
      } catch (err) {
        render(el, categories, profile, '');
        const card = el.querySelector('.card');
        if (card) card.insertAdjacentHTML('afterbegin', `<p class="small" style="color:var(--red)">${esc(err.message)}</p>`);
      }
    };
  }

  window.renderMyProfile = async function (el, categories) {
    if (!el) return;
    try {
      const v = await post({action: 'get'});
      render(el, categories, v.profile, '');
    } catch (e) {
      el.innerHTML = `<div class="card" style="margin-bottom:14px"><h3 style="margin-top:0">My profile</h3><p class="small">We couldn't load your profile just now. ${esc(e.message || '')}</p></div>`;
    }
  };
})();
