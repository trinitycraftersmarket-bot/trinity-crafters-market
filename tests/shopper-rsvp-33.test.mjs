// §33 — Public Shopper RSVP port (Oct 24, 2026). The rebuild carried
// over only the ORGANIZER side of RSVPs (v2 rsvps.js list + manager
// mrsvps); the shopper-facing form at classic #rsvp (shopperForm) was
// never ported, so a shopper on the new app hit the sign-in screen
// with no explanation and no way to RSVP without becoming a vendor.
// The fix mirrors the vtrucks public-form precedent exactly: 'rsvp' is
// a known route, boot renders it signed-out under publicHead(), route
// dispatches it before role dispatch, and shopper.js renders classic's
// card + form on the unchanged server 'rsvp' action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2js = join(root, 'public', 'v2', 'js');
const read = p => readFileSync(join(root, p), 'utf8');
const readV2 = f => readFileSync(join(v2js, f), 'utf8');

test('§33: shopper.js exists and app.js wires the rsvp route end to end', () => {
  assert.ok(existsSync(join(v2js, 'shopper.js')), 'missing shopper.js');
  const app = readV2('app.js');
  assert.ok(app.includes('renderShopperRsvp'), 'app.js must import/dispatch renderShopperRsvp');
  assert.ok(app.includes("from './shopper.js?v="), 'the shopper import must carry the version stamp');
});

test('§33: parseHash knows the rsvp route name', () => {
  const app = readV2('app.js');
  const parse = app.slice(app.indexOf('function parseHash()'), app.indexOf('function bindGo'));
  assert.ok(parse.includes("'rsvp'"), "parseHash's known-route list must include 'rsvp'");
  // The organizer list route stays a distinct name — no prefix collision.
  assert.ok(parse.includes("'rsvps'"), "parseHash must still know the organizer 'rsvps' route");
});

test('§33: boot renders the shopper page signed-out instead of the sign-in screen', () => {
  const app = readV2('app.js');
  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('window.addEventListener'));
  assert.ok(boot.includes("parseHash().name === 'rsvp'"), 'boot must special-case the public shopper route');
  assert.ok(boot.includes('publicHead(); renderShopperRsvp(ctx, root); return;'), 'the signed-out rsvp branch must render under publicHead');
  // The branch sits in the no-token path, before the generic sign-in.
  assert.ok(boot.indexOf("parseHash().name === 'rsvp'") < boot.indexOf('signInScreen(root); return;'), 'the rsvp branch must precede the sign-in fallback');
});

test('§33: route dispatches rsvp before role dispatch, beside vtrucks', () => {
  const app = readV2('app.js');
  const route = app.slice(app.indexOf('async function route()'), app.indexOf('function threadApps'));
  const rsvpAt = route.indexOf("r.name === 'rsvp'");
  assert.ok(rsvpAt > -1, 'route must handle the rsvp route');
  assert.ok(route.includes("if (r.name === 'rsvp') { renderShopperRsvp(ctx, root);"), 'route must render the shopper page');
  assert.ok(rsvpAt < route.indexOf('routeManager'), 'rsvp must dispatch before the manager role dispatch');
  assert.ok(rsvpAt < route.indexOf('routeVendor'), 'rsvp must dispatch before the vendor role dispatch');
  // Same public position as vtrucks: adjacent, both before role dispatch.
  const trucksAt = route.indexOf("r.name === 'vtrucks'");
  assert.ok(trucksAt > -1 && trucksAt < rsvpAt && rsvpAt - trucksAt < 400, 'rsvp must sit with vtrucks at the top of route()');
});

test('§33: signed-out card explains the headcount and routes to sign-in', () => {
  const s = readV2('shopper.js');
  assert.ok(s.includes('Let us know you’re coming!'), 'the card must carry the classic greeting');
  assert.ok(s.includes('Shopper RSVPs are free.'), 'the card must say RSVPs are free');
  assert.ok(s.includes('Verify your email with a sign-in code'), 'the card must explain the email-code step');
  assert.ok(s.includes('come right back here to choose your market'), 'the card must promise the return to the form');
  assert.ok(s.includes('This is a shopper headcount, not a vendor application'), 'the card must separate the headcount from a vendor application');
  assert.ok(s.includes('no vendor account needed'), 'the card must say no vendor account is needed');
  assert.ok(s.includes('ctx.showSignIn()'), 'the card button must open the existing sign-in screen (hash survives, §24 return-to)');
  assert.ok(s.includes('ctx.state.user'), 'the module must branch on the signed-in state');
});

test('§33: signed-in form mirrors classic fields and payload on the server contract', () => {
  const s = readV2('shopper.js');
  // The classic field set, name for name.
  for (const f of ['name="event_id"', 'name="name"', 'name="party_size"', 'name="referral_source"', 'name="referral_group"'])
    assert.ok(s.includes(f), `shopper.js must render the classic field ${f}`);
  for (const src of ['Facebook', 'Instagram', 'Friend or family', 'Hotel', 'Flyer', 'Google', 'Other'])
    assert.ok(s.includes(`'${src}'`), `the referral sources must include ${src}`);
  assert.ok(s.includes('Number attending, including you'), 'the party-size label must match classic');
  assert.ok(s.includes('min="1" max="20"'), 'party size must carry the classic 1–20 bounds');
  assert.ok(s.includes('maxlength="200"'), 'the group field must carry the classic 200-char cap');
  // Events come from the public payload; the account email is shown,
  // never sent as a free-text field (the server takes u.email).
  assert.ok(s.includes("api('public')"), 'events must come from api(\'public\')');
  assert.ok(s.includes('Email: ${esc(user.email)}'), 'the form must show the account email like classic');
  assert.ok(!s.includes('name="email"'), 'no free-text email field may be rendered or sent');
  // Submit: the rsvp action with party_size as a Number.
  assert.ok(s.includes("api('rsvp', p)"), 'submit must call the rsvp action');
  assert.ok(s.includes('party_size: Number('), 'party_size must be sent as a Number (server requires an integer)');
  // Payload keys pinned against the server action's own reads.
  const apiSrc = read('netlify/functions/api.mjs');
  const action = apiSrc.slice(apiSrc.indexOf("action==='rsvp'"), apiSrc.indexOf("action==='messages'"));
  for (const k of ['p.event_id', 'p.name', 'p.party_size', 'p.referral_source', 'p.referral_group'])
    assert.ok(action.includes(k), `server rsvp action must read ${k}`);
  assert.ok(action.includes('on conflict(event_id,user_id) do update'), 'server must keep the upsert (resubmit updates the RSVP)');
  // Referral group shown + required only for Facebook, like classic.
  assert.ok(s.includes("value === 'Facebook'"), 'the group field must key off the Facebook source');
  assert.ok(s.includes('.required = fb'), 'the group field must become required only for Facebook');
  assert.ok(s.includes('hidden>Which Facebook group or page?'), 'the group field must start hidden with the classic label');
  // Classic framing + success wording, verbatim.
  assert.ok(s.includes('No payment required. This is a shopper headcount, not a vendor application.'), 'the intro must match classic');
  assert.ok(s.includes('Submitting again updates your RSVP for that date.'), 'the resubmit-updates note must be carried over');
  assert.ok(s.includes('You’re on the list! Your free shopper RSVP is saved.'), 'the success wording must match classic');
  assert.ok(s.includes('RSVP for free'), 'the submit button must match classic');
  // v2 rules: no localStorage, no invented analytics path.
  assert.ok(!s.includes('localStorage'), 'v2 ban: no localStorage');
});

test('§33: sign-in screen carries the quiet shopper entry point', () => {
  const app = readV2('app.js');
  const signin = app.slice(app.indexOf('function signInScreen(root)'), app.indexOf('// --- data loading'));
  assert.ok(signin.includes('Coming as a shopper? Get on the list with a free shopper RSVP →'), 'the sign-in screen must carry the shopper link text');
  assert.ok(signin.includes('href="#rsvp"'), 'the shopper link must point at #rsvp');
});
