// Shopper RSVP (public): native v2 port of the classic shopper form
// (classic shopperForm(), audit §33). The port carried over only the
// organizer side of RSVPs (rsvps.js); this is the shopper-facing form
// itself, on the unchanged server contract: POST api action 'rsvp'
// with {event_id, name, party_size, referral_source, referral_group}.
// The server requires a signed-in account and takes the account email
// itself (no email field is sent), upserting on (event_id, user_id) —
// submitting again updates the RSVP for that date. Signed-out visitors
// get the explainer card and the sign-in round trip: the hash
// survives sign-in, so boot()/route() return them to #rsvp with the
// form (the §24 return-to pattern). The events list comes from
// api('public'), the same anonymous-safe payload vapply uses.
import { api, esc, nice } from './api.js?v=20261024-36';

const SOURCES = ['Facebook', 'Instagram', 'Friend or family', 'Hotel', 'Flyer', 'Google', 'Other'];

export function renderShopperRsvp(ctx, root) {
  const user = ctx.state.user;
  if (!user) {
    root.innerHTML = `
      <p class="eyebrow">Shopper RSVP</p>
      <h2 class="display">Let us know you’re coming!</h2>
      <section class="card">
        <p>Shopper RSVPs are free. Verify your email with a sign-in code, then you’ll come right back here to choose your market. This is a shopper headcount, not a vendor application — no vendor account needed.</p>
        <div class="vendor-actions"><button class="btn primary" id="v2-rsvp-signin" type="button">Verify my email</button></div>
      </section>`;
    root.querySelector('#v2-rsvp-signin').onclick = () => ctx.showSignIn();
    return;
  }

  root.innerHTML = `
    <p class="eyebrow">Shopper RSVP</p>
    <h2 class="display">Free shopper RSVP</h2>
    <div class="card empty-card">Loading market dates…</div>`;

  const draw = async () => {
    const d = await api('public');
    const events = d.events || [];
    root.innerHTML = `
      <p class="eyebrow">Shopper RSVP</p>
      <h2 class="display">Free shopper RSVP</h2>
      <p class="lede">Let us know you’re coming! No payment required. This is a shopper headcount, not a vendor application.</p>
      <form id="v2-shopper-form">
        <section class="card">
          <label class="sheet-field">Name<input name="name" autocomplete="name" required></label>
          <p class="note">Email: ${esc(user.email)}</p>
          <label class="sheet-field">Market<select name="event_id" required>${events.map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))} — ${esc(e.location)}</option>`).join('')}</select></label>
          <label class="sheet-field">Number attending, including you<input name="party_size" type="number" min="1" max="20" value="1" required></label>
          <label class="sheet-field">How did you hear about us?<select name="referral_source" required><option value="">Choose one</option>${SOURCES.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
          <label class="sheet-field" id="v2-shopper-group" hidden>Which Facebook group or page?<input name="referral_group" maxlength="200"></label>
          <p class="note">Your details are private and used to plan the market. Submitting again updates your RSVP for that date.</p>
          <div class="vendor-actions"><button class="btn primary" type="submit" ${events.length ? '' : 'disabled'}>RSVP for free</button></div>
        </section>
      </form>`;

    const f = root.querySelector('#v2-shopper-form');
    // Named access (form.name) is shadowed by HTMLFormElement's own
    // properties — always go through elements.namedItem.
    const F = n => f.elements.namedItem(n);
    // The Facebook group field appears — and is required — only for
    // the Facebook source, exactly as in classic.
    F('referral_source').onchange = () => {
      const fb = F('referral_source').value === 'Facebook';
      root.querySelector('#v2-shopper-group').hidden = !fb;
      F('referral_group').required = fb;
    };
    f.onsubmit = async e => {
      e.preventDefault();
      // The classic payload, key for key: the FormData fields plus
      // party_size as a Number (the server requires an integer 1–20).
      const p = { ...Object.fromEntries(new FormData(f)), party_size: Number(F('party_size').value) };
      try {
        await api('rsvp', p);
        ctx.toast('You’re on the list! Your free shopper RSVP is saved.');
      } catch (x) { ctx.toast(x.message, true); }
    };
  };

  draw().catch(e => {
    root.innerHTML = `
      <p class="eyebrow">Shopper RSVP</p>
      <h2 class="display">Free shopper RSVP</h2>
      <div class="card empty-card">${esc(e.message)}</div>`;
  });
}
