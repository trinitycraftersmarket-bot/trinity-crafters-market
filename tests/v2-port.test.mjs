// Full-port program (audit §20): each stage gives a classic-only tool a
// native v2 screen on the SAME server endpoints and rules. These static
// checks pin the wiring per stage, in the style of tests/v2-frontend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2js = join(root, 'public', 'v2', 'js');
const read = (base, m) => readFileSync(join(base, m), 'utf8');

test('stage A: manual booking module exists and app.js routes to it', () => {
  assert.ok(existsSync(join(v2js, 'manualbooking.js')), 'missing manualbooking.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'manualbooking'"), 'section registry must wire live: manualbooking');
  assert.ok(app.includes("'manualbooking'"), 'router must accept the manualbooking route');
  assert.ok(app.includes('renderManualBooking'), 'app.js must dispatch to renderManualBooking');
});

test('stage A: manual booking uses the same endpoint and multi-date rules as legacy', () => {
  const mb = read(v2js, 'manualbooking.js');
  assert.ok(mb.includes("/.netlify/functions/manual-booking"), 'must call the manual-booking function');
  assert.ok(mb.includes("'?q=' + encodeURIComponent(q)"), 'vendor search must use the ?q= GET like the legacy panel');
  // Multi-date: one POST per ticked date, sequential, per-date amounts.
  assert.ok(mb.includes('event_id: r.check.value'), 'each ticked date posts its own booking');
  assert.ok(mb.includes('(rowCents(r) / 100).toFixed(2)'), 'multi-date amounts are the per-row rate');
  assert.ok(mb.includes('singleAmount'), 'single-date amount override stays editable');
  assert.ok(mb.includes('amount.readOnly = sel.length > 1'), 'combined total is read-only for several dates');
  // Credit card = one date at a time (GoDaddy amount must match).
  assert.ok(mb.includes('Credit card bookings are one date at a time'), 'card multi-date guard copy must be present');
  assert.ok(mb.includes('payment_reference'), 'the GoDaddy Txn ID flow must be ported');
  assert.ok(mb.includes('monthly billing'), 'monthly billing must be a payment option');
  // Partial failure reporting: failed dates stay ticked.
  assert.ok(mb.includes('still ticked'), 'failures must be reported with dates left ticked');
  assert.ok(mb.includes('done.forEach(r => { r.check.checked = false; })'), 'only successful dates are unticked');
  const css = readFileSync(join(root, 'public', 'v2', 'css', 'app.css'), 'utf8');
  for (const cls of ['.mb-list', '.mb-row', '.mb-rate'])
    assert.ok(css.includes(cls), `app.css must style ${cls} (stage A components)`);
});

test('stage B: credit issuance lives in the vendor directory sheet flow', () => {
  const v = read(v2js, 'vendors.js');
  assert.ok(v.includes("'admin-sources'"), 'directory must load creditable records via admin-sources');
  assert.ok(v.includes("'preview'"), 'issuance must preview the stored paid amount first');
  assert.ok(v.includes("action: 'issue'"), 'issuance must call the vendor-credit issue action');
  assert.ok(v.includes('Cancellation credits'), 'the directory must render the Cancellation credits section');
  assert.ok(v.includes('Credit issued'), 'already-issued records must show their remaining balance');
  assert.ok(v.includes('data-imported'), 'issuance must distinguish imported vs booking sources');
});

test('stage B: application review flags credits and offers Approve & apply credit (§19)', () => {
  const a = read(v2js, 'applications.js');
  assert.ok(a.includes("'applicant-credits'"), 'review must load applicant credits');
  assert.ok(a.includes("'application-conflicts'"), 'review must load the who-sells-what conflicts');
  assert.ok(a.includes('Holds a '), 'the credit flag line must render');
  assert.ok(a.includes('credit from '), 'the flag must name the credit source date');
  assert.ok(a.includes("'redeem-for-application'"), 'the override must settle via redeem-for-application');
  assert.ok(a.includes('Approve &amp; apply '), 'the Approve & apply credit button must render');
  assert.ok(a.includes('products not listed'), 'conflict lines must use the no-invention fallback');
  assert.ok(a.includes('sells '), 'conflict lines must use the "<Business> sells <products>" format');
});

test('stage C: cancelled vendors screen reinstates via the existing action', () => {
  assert.ok(existsSync(join(v2js, 'cancelled.js')), 'missing cancelled.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'cancelled'"), 'section registry must wire live: cancelled');
  assert.ok(app.includes('renderCancelled'), 'app.js must dispatch to renderCancelled');
  const c = read(v2js, 'cancelled.js');
  assert.ok(c.includes("'reinstate-cancelled'"), 'reinstatement must use the reinstate-cancelled action');
  assert.ok(c.includes('cancelledRows'), 'rows must be shaped from the admin payload');
  assert.ok(c.includes("x.status === 'cancelled'"), 'booking rows come from cancelled bookings');
  assert.ok(c.includes('cancellation_reason'), 'the cancellation reason must be shown');
  assert.ok(c.includes('Past market date'), 'past dates must not offer reinstatement');
});

test('stage C: banned vendors screen toggles bans via the existing action', () => {
  assert.ok(existsSync(join(v2js, 'banned.js')), 'missing banned.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'banned'"), 'section registry must wire live: banned');
  assert.ok(app.includes('renderBanned'), 'app.js must dispatch to renderBanned');
  const b = read(v2js, 'banned.js');
  assert.ok(b.includes("'ban'"), 'the screen must use the ban action');
  assert.ok(b.includes('active: !b.active'), 'unban / reapply must flip the active flag');
  assert.ok(b.includes('Add banned vendor'), 'the add-ban form must exist');
});

test('stage D: monthly billing screen uses the monthly-invoices function actions', () => {
  assert.ok(existsSync(join(v2js, 'billing.js')), 'missing billing.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'billing'"), 'section registry must wire live: billing');
  assert.ok(app.includes('renderBilling'), 'app.js must dispatch to renderBilling');
  const b = read(v2js, 'billing.js');
  assert.ok(b.includes("/.netlify/functions/monthly-invoices"), 'must call the monthly-invoices function');
  for (const s of ["'add-bill'", "'update'", "'cancel'", "'edit-item'", "'email'", "'godaddy-sent'", 'token='])
    assert.ok(b.includes(s), `billing.js must use the ${s} action`);
  assert.ok(b.includes('dueOf'), 'the due math helper must exist');
  assert.ok(b.includes("i.status === 'cancelled' ? 0"), 'cancelled invoices must be due $0');
});

test('stage D: expenses screen keeps the log, tumbler report and itemized report', () => {
  assert.ok(existsSync(join(v2js, 'expenses.js')), 'missing expenses.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'expenses'"), 'section registry must wire live: expenses');
  assert.ok(app.includes('renderExpenses'), 'app.js must dispatch to renderExpenses');
  const e = read(v2js, 'expenses.js');
  assert.ok(e.includes("'expense'"), 'the log must use the expense action');
  assert.ok(e.includes('isTumblerRow'), 'tumbler detection must be shared');
  assert.ok(e.includes('tumbler credit'), 'tumbler detection must match the classic rule');
  assert.ok(e.includes('Tumbler Credit Report'), 'the tumbler reconciliation section must exist');
  assert.ok(e.includes('printExpenseReport'), 'printing must go through the shared print builder');
  assert.ok(e.includes('csvDownload'), 'CSV export must exist');
});

test('stage D: reports screen keeps P&L, A/R and the payment report math', () => {
  assert.ok(existsSync(join(v2js, 'reports.js')), 'missing reports.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'reports'"), 'section registry must wire live: reports');
  assert.ok(app.includes('renderReports'), 'app.js must dispatch to renderReports');
  const r = read(v2js, 'reports.js');
  assert.ok(r.includes('plRows') && r.includes('arRows'), 'P&L and A/R row builders must exist');
  assert.ok(r.includes('Profit & Loss'), 'the P&L report must exist');
  assert.ok(r.includes('Accounts Receivable'), 'the A/R report must exist');
  assert.ok(r.includes('printTable'), 'reports must print via the shared printTable builder');
  assert.ok(r.includes('payment-report.csv'), 'the payment CSV export must exist');
  const p = read(v2js, 'print.js');
  assert.ok(p.includes('export function printTable') && p.includes('export function printExpenseReport'), 'print.js must export both classic print builders');
});

test('stage E: food trucks organizer screen uses the food-trucks function contract', () => {
  assert.ok(existsSync(join(v2js, 'foodtrucks.js')), 'missing foodtrucks.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'foodtrucks'"), 'section registry must wire live: foodtrucks');
  assert.ok(app.includes('renderFoodTrucks'), 'app.js must dispatch to renderFoodTrucks');
  const f = read(v2js, 'foodtrucks.js');
  assert.ok(f.includes("/.netlify/functions/food-trucks"), 'must call the food-trucks function');
  assert.ok(f.includes("'?admin=1'"), 'the organizer list must use the admin view');
  assert.ok(f.includes("'PATCH'"), 'decisions must PATCH');
  assert.ok(f.includes('approved_products'), 'approving must name approved products (server requires it)');
  assert.ok(f.includes('decline reason is required') || f.includes('decline reason is required.'), 'declining must require a reason (server requires it)');
  assert.ok(f.includes("status: 'paid'"), 'mark-paid must use the paid status');
});

test('stage F: online check-in organizer screen uses the setup-checkin function', () => {
  assert.ok(existsSync(join(v2js, 'checkin.js')), 'missing checkin.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'checkin'"), 'section registry must wire live: checkin');
  assert.ok(app.includes('renderCheckin'), 'app.js must dispatch to renderCheckin');
  const c = read(v2js, 'checkin.js');
  assert.ok(c.includes('/.netlify/functions/setup-checkin'), 'must call the setup-checkin function');
  assert.ok(c.includes("action: 'remind'"), 'the reminder must use the remind action');
  assert.ok(c.includes("'08:15'") && c.includes("'09:00'"), 'the arrival slots must match the classic ones');
});

test('stage F: application recovery screen keeps status rules and override actions', () => {
  assert.ok(existsSync(join(v2js, 'apprecovery.js')), 'missing apprecovery.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'apprecovery'"), 'section registry must wire live: apprecovery');
  assert.ok(app.includes('renderAppRecovery'), 'app.js must dispatch to renderAppRecovery');
  const r = read(v2js, 'apprecovery.js');
  assert.ok(r.includes('600000'), 'staleness must use the classic 10-minute rule');
  assert.ok(r.includes("'application-attempt-dismiss'"), 'dismiss must use the existing action');
  assert.ok(r.includes("'recover-application'"), 'recovery must use the existing action');
  assert.ok(r.includes("'attempt-photo'"), 'photo viewing must use the existing action');
  assert.ok(r.includes('analyzeCategoryFit'), 'the category-fit alert must be ported');
  assert.ok(r.includes('confirm_override'), 'the override confirmation checkbox is required');
  // The duplicate placeholder food-trucks entry from Stage 3b must be gone.
  const keys = [...app.matchAll(/key: 'food-trucks'/g)];
  assert.equal(keys.length, 1, 'exactly one food-trucks section entry');
});

test('stage H: public food-truck application form lives in v2 on the same contract', () => {
  assert.ok(existsSync(join(v2js, 'trucksapply.js')), 'missing trucksapply.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("'vtrucks'"), 'router must accept the vtrucks route');
  assert.ok(app.includes('renderFoodTruckApply'), 'app.js must dispatch to renderFoodTruckApply');
  // Signed-out reachability: boot renders the public form without a token.
  assert.ok(app.includes("parseHash().name === 'vtrucks'"), 'boot must special-case the public trucks route');
  const t = read(v2js, 'trucksapply.js');
  assert.ok(t.includes("/.netlify/functions/food-trucks"), 'must call the food-trucks function');
  // The classic field/payload contract, mirrored exactly.
  for (const s of ['name="event_id"', 'name="name"', 'name="email"', 'name="phone"', 'name="billing_address"',
    'name="food_type"', 'name="wrapped"', 'name="propane"', 'name="rig_size"', 'name="permits"', 'name="insurance"',
    'name="rig_photo"', 'name="food_photos"'])
    assert.ok(t.includes(s), `trucksapply.js must render the classic field ${s}`);
  for (const s of ['event_ids', 'p.photos = photos', 'x.rig = i === 0', '10485760', "p.wrapped = p.wrapped === 'yes'",
    "p.permits = F('permits').checked", 'delete p.rig_photo', 'Submit Food Truck Application', 'Estimated invoice total',
    'SOLD OUT', 'Application Received', 'submitted for review. Check your email for confirmation.'])
    assert.ok(t.includes(s), `trucksapply.js must include ${s}`);
});

test('§22: recovery reinstate + completion-link email actions are organizer-only in api.mjs', () => {
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  for (const action of ['application-attempt-reinstate', 'application-attempt-email', 'application-attempt-mine']) {
    const idx = apiSrc.indexOf(`action==='${action}'`);
    assert.ok(idx > 0, `api.mjs must implement ${action}`);
  }
  const reinstate = apiSrc.slice(apiSrc.indexOf("action==='application-attempt-reinstate'"), apiSrc.indexOf("action==='application-attempt-email'"));
  assert.ok(reinstate.includes("if(!u.admin)return json({error:'Organizer access only'},403)"), 'reinstate must be organizer-only');
  assert.ok(reinstate.includes("attempt.status!=='dismissed'"), 'reinstate must only accept dismissed attempts');
  assert.ok(reinstate.includes('reviewed_at=null'), 'reinstate must clear the review stamp');
  assert.ok(reinstate.includes("'application attempt reinstated'"), 'reinstate must be audit-logged');
  const email = apiSrc.slice(apiSrc.indexOf("action==='application-attempt-email'"), apiSrc.indexOf("action==='recover-application'"));
  assert.ok(email.includes("if(!u.admin)return json({error:'Organizer access only'},403)"), 'email must be organizer-only');
  assert.ok(email.includes("'Complete your Trinity Crafters Market application'"), 'email subject must be the completion subject');
  assert.ok(email.includes('https://trinitylutzmarkets.com/v2/#apply'), 'email must link the apply form (direct /v2/ path since §24, so the #apply fragment survives)');
  assert.ok(email.includes('attemptMissingItems(snap)'), 'the missing list must be computed server-side from the snapshot');
  assert.ok(email.includes('attemptHasAgreementsError(attempt)'), 'the apology must key off the agreements-error test');
  assert.ok(email.includes('emailed_at=now()'), 'the send must stamp emailed_at on the attempt');
  assert.ok(email.includes('email_delivery'), 'the response must report delivery honestly');
  assert.ok(apiSrc.includes('add column if not exists emailed_at timestamptz'), 'ensureApplicationAttempts must add emailed_at');
  // The vendor-self restore read: own rows only, unfinished only.
  const mine = apiSrc.slice(apiSrc.indexOf("action==='application-attempt-mine'"), apiSrc.indexOf('if(!staffActionAllowed'));
  assert.ok(mine.includes('user_id=${u.id}'), 'mine must scope to the signed-in vendor');
  assert.ok(mine.includes("status in ('draft','submitting','failed')"), 'mine must only return unfinished attempts');
  assert.ok(mine.includes("snap.signature=''"), 'mine must not carry the signature over');
});

test('§22: recovery UI gains reinstate, completion-link email, and our-bug badges', () => {
  const r = read(v2js, 'apprecovery.js');
  assert.ok(r.includes("'application-attempt-reinstate'"), 'UI must call the reinstate action');
  assert.ok(r.includes('data-reinstate-attempt'), 'dismissed cards must get a Reinstate button');
  assert.ok(r.includes("'application-attempt-email'"), 'UI must call the completion-email action');
  assert.ok(r.includes('data-email-attempt'), 'unfinished cards must get an Email completion link button');
  assert.ok(r.includes('Email completion link'), 'the email sheet must be present');
  assert.ok(r.includes('Our bug — fixed Oct 23'), 'the fault badge must render');
  assert.ok(r.includes('attemptOurBug'), 'the badge must use the shared fault test');
  assert.ok(r.includes('Read and accept every required agreement'), 'the fault test must match the agreements error text');
  assert.ok(r.includes('Completion link emailed:'), 'cards must show when the link was emailed');
  assert.ok(r.includes('attemptMissingItems'), 'the email sheet must preview the missing-items list');
});

test('§22: apply form restores the vendor\'s own unfinished attempt', () => {
  const v = read(v2js, 'vendor.js');
  assert.ok(v.includes("'application-attempt-mine'"), 'the form must fetch its own latest attempt');
  assert.ok(v.includes('attemptId = att.id'), 'the form must adopt the restored attempt id');
  assert.ok(v.includes('category: categoryId'), 'the attempt snapshot must send the category under the server key');
  assert.ok(v.includes('thumb-saved'), 'restored photos without a display URL must still render a chip');
  const css = readFileSync(join(root, 'public', 'v2', 'css', 'app.css'), 'utf8');
  assert.ok(css.includes('.thumb-saved'), 'app.css must style the saved-photo chip');
});

test('§24: completion email reopens dismissed attempts; restore honors emailed dismissed attempts', () => {
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  const email = apiSrc.slice(apiSrc.indexOf("action==='application-attempt-email'"), apiSrc.indexOf("action==='recover-application'"));
  // Emailing a dismissed attempt reopens it in the same transaction,
  // mirroring the reinstate rule, so the emailed link restores the form.
  assert.ok(email.includes("attempt.status==='dismissed'"), 'email must detect a dismissed attempt');
  assert.ok(email.includes("?'failed':'draft'"), 'reopen must reuse the reinstate state rule (failure → failed, quiet → draft)');
  assert.ok(email.includes('reviewed_at=null,reviewed_by=null'), 'reopen must clear the review stamp');
  assert.ok(email.includes('reopened_from_dismissed:true'), 'the audit entry must record the reopening');
  assert.ok(email.includes('https://trinitylutzmarkets.com/v2/#apply'), 'the link must go straight to /v2/ so the fragment survives');
  assert.ok(!email.includes('trinitylutzmarkets.com/#apply'), 'the root-redirect link must be gone');
  // Restore: a dismissed attempt the organizer already emailed (links
  // sent before the reopen-on-send fix) must come back; a dismissed
  // attempt that was never emailed stays invisible.
  const mine = apiSrc.slice(apiSrc.indexOf("action==='application-attempt-mine'"), apiSrc.indexOf('if(!staffActionAllowed'));
  assert.ok(mine.includes("status='dismissed' and emailed_at is not null"), 'mine must include dismissed attempts whose completion link was emailed');
  assert.ok(mine.includes('order by last_seen_at desc'), 'mine must keep latest-activity ordering');
});

test('§25: invite-back email can go to the whole shown group, not just ticked vendors', () => {
  const v = read(v2js, 'vendors.js');
  // Audience control in the invite card: ticked-only stays the default,
  // group mode targets the rows on screen.
  assert.ok(v.includes('name="v2-return-audience"'), 'the invite card must offer the audience choice');
  assert.ok(v.includes('Ticked vendors only'), 'ticked mode must be offered');
  assert.ok(v.includes('Everyone in the group below'), 'group mode must be offered');
  assert.ok(v.includes("let audience = 'selected'"), 'ticked-only must be the default audience');
  assert.ok(v.includes('id="v2-return-group"'), 'the group option must carry the live group label/count');
  // The label names the Show filter group (same words as the picker) and
  // counts how many of the shown rows have a usable email.
  assert.ok(v.includes('FILTER_LABELS'), 'group names must come from the filter label map');
  assert.ok(v.includes("inactive: \"Haven't attended recently\""), 'the inactive group must use the picker wording');
  assert.ok(v.includes("' have an email'"), 'the group label must report the emailable count');
  assert.ok(v.includes('usableEmail'), 'emailable rows must be decided by the shared usable-email test');
  assert.ok(v.includes('shownRows = shown'), 'draw() must publish the on-screen rows for the send');
  assert.ok(v.includes('syncInvite()'), 'the audience label/count and button must refresh as the list changes');
  // Group send: ids come from the shown rows with a usable email only,
  // through the unchanged vendor-reengage action, after a confirm that
  // names the group and promises nobody outside it is emailed.
  assert.ok(v.includes('shownRows.filter(v => usableEmail(v))'), 'group mode must collect the shown emailable rows');
  assert.ok(v.includes('targets.map(v => String(v.id))'), 'group mode must send those rows\' ids');
  assert.ok(v.includes('Nobody outside this group will get it'), 'the confirm must scope the send to the group');
  assert.ok(v.includes("'Email this group'"), 'the send button must name group mode');
  assert.ok(v.includes("audience === 'group'"), 'the send handler must branch on the chosen audience');
  // Ticked mode is untouched: same selection set, same call, same toast.
  assert.ok(v.includes('const ids = [...selected];'), 'ticked mode must keep sending the tick set');
  assert.ok(v.includes("'Return invitation emailed to the selected vendor(s).'"), 'ticked mode toast must be unchanged');
});

test('§26: tapping send with nothing ticked offers the shown group instead of a dead end', () => {
  const v = read(v2js, 'vendors.js');
  // The dead-end toast is gone from the v2 directory (the legacy classic
  // app keeps its own copy — out of scope here).
  assert.ok(!v.includes('Select at least one vendor first.'), 'the empty-selection dead end must be removed');
  // The empty-selection branch lives in the ticked path, after the tick
  // set is read, and offers the group on screen.
  const tickAt = v.indexOf('const ids = [...selected];');
  const offerAt = v.indexOf("'No vendors ticked'");
  assert.ok(tickAt >= 0 && offerAt > tickAt, 'the nothing-ticked offer must sit in the ticked path');
  assert.ok(v.includes('if (!ids.length)'), 'the offer must trigger on an empty tick selection');
  // The confirm names the current view (Show-filter group label) and the
  // search narrowing, with exact counts, and asks the question.
  assert.ok(v.includes("shownRows.length + ' vendor(s) shown in ' + groupName"), 'the confirm must state how many vendors are shown, in the named group');
  assert.ok(v.includes("' with an email address. Email all '"), 'the confirm must state the emailable count and ask to email them all');
  assert.ok(v.includes('narrowed by your search'), 'the confirm must say when the search narrows the list');
  assert.ok(v.includes("'Email the group'"), 'the fallback confirm button must be Email the group');
  // The fallback runs the SAME group send as §25's group audience: one
  // shared path collecting the shown rows' ids for vendor-reengage.
  assert.ok(v.includes('const sendGroup = async'), 'both entry points must share the one group-send path');
  assert.ok(v.includes('shownRows.filter(v => usableEmail(v))'), 'the shared path must collect the shown emailable rows');
  assert.ok(v.includes('targets.map(v => String(v.id))'), 'the shared path must send the shown rows\' ids');
  // Empty views stay explanatory toasts, never a confirm to nobody.
  assert.ok(v.includes('No vendors are shown right now'), 'an empty view must explain itself');
  assert.ok(v.includes('Nobody in the group on screen has an email address.'), 'a group with no emailable rows must explain itself');
  // §25 group mode is unchanged: its confirm keeps its own wording and
  // button, still reached through the audience branch.
  assert.ok(v.includes('Nobody outside this group will get it'), 'the group-mode confirm must keep its scoping promise');
  assert.ok(v.includes("'Email this group'"), 'the group-mode confirm button must be unchanged');
  assert.ok(v.includes("audience === 'group'"), 'the audience branch must still come first');
});

test('stage H: legacy hash aliases deep-link into v2 (permanent)', () => {
  const app = read(v2js, 'app.js');
  assert.ok(app.includes('HASH_ALIASES'), 'app.js must define the legacy hash aliases');
  assert.ok(app.includes("admin: 'home'"), '#admin must land on the v2 home');
  assert.ok(app.includes("account: 'vbookings'"), '#account must land on vendor bookings');
  assert.ok(app.includes("apply: 'vapply'"), '#apply must land on the vendor application');
});

test('stage H: the four public paths redirect to v2; classic routing untouched', () => {
  const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
  for (const s of ['to = "/v2/#vapply"', 'to = "/v2/#vtrucks"'])
    assert.ok(toml.includes(s), `netlify.toml must redirect ${s}`);
  for (const p of ['/market-dates', '/vendor-opportunities-1', '/about-lutz-market', '/food-trucks'])
    assert.ok(toml.includes(`from = "${p}"`), `netlify.toml must keep a rule for ${p}`);
  for (const s of ['/market-dates/index.html', '/vendor-opportunities-1/index.html', '/about-lutz-market/index.html', '/food-trucks/index.html'])
    assert.ok(!toml.includes(s), `netlify.toml must no longer serve the classic shell at ${s}`);
  // The soak posture: /classic stays exactly as it was.
  assert.ok(toml.includes('from = "/classic"') && toml.includes('to = "/classic/index.html"'), '/classic must stay reachable during the soak');
  const sitemap = readFileSync(join(root, 'public', 'sitemap.xml'), 'utf8');
  for (const p of ['market-dates', 'vendor-opportunities-1', 'about-lutz-market', 'food-trucks'])
    assert.ok(sitemap.includes(`https://trinitylutzmarkets.com/${p}<`), `sitemap must keep the public URL ${p}`);
});

test('§27: registered-users action is organizer-only and shaped in api.mjs', () => {
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  const idx = apiSrc.indexOf("action==='registered-users'");
  assert.ok(idx > 0, 'api.mjs must implement registered-users');
  const block = apiSrc.slice(idx, apiSrc.indexOf("action==='survey-report'"));
  assert.ok(block.includes("if(!u.admin)return json({error:'Organizer access only'},403)"), 'registered-users must be organizer-only');
  // Accounts come from Supabase Auth via the service-role client,
  // paginated until a short page, with a sane cap.
  assert.ok(block.includes('supa().auth.admin.listUsers'), 'accounts must come from Supabase Auth admin');
  assert.ok(block.includes('perPage:PER_PAGE'), 'listUsers must paginate');
  assert.ok(block.includes('CAP=1000'), 'the account scan must be capped');
  assert.ok(block.includes('batch.length<PER_PAGE'), 'pagination must stop at a short page');
  // Exact user_id links beat email fallbacks; the flip side is built
  // from the directory universe and excludes account holders.
  assert.ok(block.includes('appByUser'), 'matching must try applications.user_id first');
  assert.ok(block.includes('profileByUser'), 'matching must try vendor_profiles.user_id');
  assert.ok(block.includes("via='application'"), 'the match source must be reported');
  assert.ok(block.includes('importedByEmail'), 'imported attendees match by email (they have no user_id)');
  assert.ok(block.includes('has_vendor_record:!!link'), 'unmatched accounts must be flagged');
  assert.ok(block.includes('organizer:'), 'the organizer account must be flagged');
  assert.ok(block.includes('process.env.ADMIN_EMAIL'), 'the organizer flag must key off ADMIN_EMAIL');
  assert.ok(block.includes('staff:'), 'staff accounts must be flagged');
  assert.ok(block.includes('from market.staff where active'), 'the staff flag must come from the staff table');
  assert.ok(block.includes('last_sign_in_at:acct.last_sign_in_at'), 'last sign-in must pass through unparsed (it is a sign-in, not "last active")');
  assert.ok(block.includes('not_registered'), 'the flip side (vendors with no account) must be returned');
  assert.ok(block.includes('counts:{registered:'), 'the response must carry counts');
  assert.ok(!block.includes('last_active'), 'nothing may relabel sign-in data as activity');
});

test('§27: Registered Users section is registered in the Vendors group and renders both lists', () => {
  assert.ok(existsSync(join(v2js, 'registered.js')), 'missing registered.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("label: 'Registered Users'"), 'section registry must carry the Registered Users label');
  assert.ok(app.includes("live: 'registered'"), 'section registry must wire live: registered');
  assert.ok(app.includes("'registered'"), 'router must accept the registered route');
  assert.ok(app.includes('renderRegistered'), 'app.js must dispatch to renderRegistered');
  const r = read(v2js, 'registered.js');
  assert.ok(r.includes("api('registered-users')"), 'the section must load the registered-users action');
  assert.ok(r.includes('Registered'), 'the registered list toggle must render');
  assert.ok(r.includes('Not registered yet'), 'the not-registered toggle must render');
  assert.ok(r.includes('Last sign-in'), 'registered rows must show the last sign-in');
  assert.ok(r.includes("'Never'"), 'accounts that never signed in must say Never');
  assert.ok(r.includes('No vendor record'), 'unmatched accounts must carry the No vendor record badge');
  assert.ok(r.includes('Organizer'), 'organizer accounts must be badged');
  assert.ok(r.includes('Staff'), 'staff accounts must be badged');
  assert.ok(!r.includes('Last active'), 'the UI must not relabel last sign-in as last active');
});

test('§28: app-usage-ping stamps signed-in Android app use in api.mjs', () => {
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  const idx = apiSrc.indexOf("action==='app-usage-ping'");
  assert.ok(idx > 0, 'api.mjs must implement app-usage-ping');
  // Any signed-in role may ping: the action sits before the staff gate.
  assert.ok(idx < apiSrc.indexOf('staffActionAllowed(u,action)'), 'the ping must not be staff-gated — vendors stamp their own accounts');
  const block = apiSrc.slice(idx, apiSrc.indexOf("if(action==='category-scan'"));
  assert.ok(block.includes("req.method==='POST'"), 'the ping must be POST-only');
  assert.ok(block.includes('ensureAppUsage'), 'the ping must ensure the app_usage table');
  assert.ok(block.includes('insert into market.app_usage'), 'the ping must upsert into market.app_usage');
  assert.ok(block.includes("'android-app'"), 'the stamp must record the android-app platform');
  assert.ok(block.includes('on conflict (user_id) do update set platform=excluded.platform,last_seen_at=now()'), 'repeat pings must move last_seen_at (and platform) only — first_seen_at never moves');
  assert.ok(block.includes("at time zone 'America/New_York'"), 'the write must be day-bounded in the market timezone — at most one stamp move per market day');
  assert.ok(apiSrc.includes('create table if not exists market.app_usage'), 'ensureAppUsage must create the table in the ensure pattern');
  // Registered Users carries the stamp per account.
  const regBlock = apiSrc.slice(apiSrc.indexOf("action==='registered-users'"), apiSrc.indexOf("action==='survey-report'"));
  assert.ok(regBlock.includes('from market.app_usage'), 'registered-users must read market.app_usage');
  assert.ok(regBlock.includes('app_usage:'), 'registered rows must carry app_usage');
  assert.ok(regBlock.includes('usageByUser.get(String(acct.id))||null'), 'accounts never seen in the app must carry app_usage: null');
});

test('§28: the v2 shell pings from inside the Android app; Registered Users shows use, never downloads', () => {
  const app = read(v2js, 'app.js');
  assert.ok(app.includes('function insideAndroidApp()'), 'app.js must define the Android-shell detection');
  assert.ok(app.includes('window.Capacitor'), 'detection must use the Capacitor bridge first');
  assert.ok(app.includes('isNativePlatform'), 'detection must check isNativePlatform()');
  assert.ok(app.includes("getPlatform() === 'android'"), 'detection must confirm the android platform');
  assert.ok(app.includes('/;\\s*wv\\)/'), 'detection must keep the WebView user-agent fallback');
  assert.ok(app.includes("api('app-usage-ping', {})"), 'boot must ping the app-usage-ping action');
  assert.ok(app.includes('pingAppUsage();'), 'boot must call the ping once the session exists');
  assert.ok(app.includes('APP_USAGE_PING_KEY'), 'the ping must be throttled per day per device');
  assert.ok(app.includes('sessionStorage'), 'the throttle must live in sessionStorage (v2 keeps nothing in localStorage)');
  assert.ok(!app.includes('localStorage'), 'v2 must never reference localStorage (frontend rule)');
  const r = read(v2js, 'registered.js');
  assert.ok(r.includes('use the Android app'), 'the header stat must say "use the Android app"');
  assert.ok(r.includes('data-reg-tab="app"'), 'the Android app list needs its own toggle chip');
  assert.ok(r.includes('First used'), 'Android rows must show when the account was first seen in the app');
  assert.ok(r.includes('Last used'), 'Android rows must show when the account was last seen in the app');
  assert.ok(r.includes("'<span class=\"badge inside\">Android app</span>'"), 'registered rows must badge app users');
  assert.ok(!r.includes('downloaded'), 'the UI observes use — it must never claim a download');
});

test('stage G: attendees gains the PDF import and the printable attendance list', () => {
  assert.ok(existsSync(join(v2js, 'pdfimport.js')), 'missing pdfimport.js');
  const p = read(v2js, 'pdfimport.js');
  assert.ok(p.includes('export async function parseAttendeePdf'), 'the PDF parser must be ported');
  assert.ok(p.includes('pdfjs-dist@6.3.289'), 'the parser must use the same pdf.js build as classic');
  assert.ok(p.includes('headerMap'), 'the parser must keep the classic header detection');
  const at = read(v2js, 'attendees.js');
  assert.ok(!at.includes('still live in the current app'), 'the classic-fallback note must be removed');
  assert.ok(at.includes("'import-attendees'"), 'import must post to the existing import-attendees action');
  assert.ok(at.includes('source_file'), 'import must carry the source file name like classic');
  assert.ok(at.includes('printAttendance'), 'the attendance list must print via the shared builder');
  const pr = read(v2js, 'print.js');
  assert.ok(pr.includes('export function printAttendance'), 'print.js must export the attendance print builder');
  assert.ok(pr.includes('break-before:page'), 'floor plans must print one per page');
});

test('§29: vendor screens use the body-action transport for vendor-profile / move-requests / vendor-credit', () => {
  // The three sibling functions are POST-only and read their action from
  // the JSON body; the fnq query-action transport against them 405s (GET)
  // or falls through to "Unknown action" (POST without an action key).
  // Pin the server contracts so the mismatch can never silently return.
  const vp = readFileSync(join(root, 'netlify', 'functions', 'vendor-profile.mjs'), 'utf8');
  assert.ok(vp.includes("req.method !== 'POST'"), 'vendor-profile must stay POST-only');
  assert.ok(vp.includes("p.action === 'get'"), 'vendor-profile must read the action from the body');
  const mr = readFileSync(join(root, 'netlify', 'functions', 'move-requests.mjs'), 'utf8');
  assert.ok(mr.includes("req.method !== 'POST'"), 'move-requests must stay POST-only');
  assert.ok(mr.includes("p.action === 'options'"), 'move-requests must read the action from the body');
  const vc = readFileSync(join(root, 'netlify', 'functions', 'vendor-credit.mjs'), 'utf8');
  assert.ok(vc.includes('action=clean(p.action,60)'), 'vendor-credit must read the action from the body');

  const v = read(v2js, 'vendor.js');
  assert.ok(!v.includes('fnq('), 'vendor.js must not use the query-action transport at all');
  assert.ok(v.includes("fn('vendor-profile', { action: 'get' })"), 'profile reads must post {action:get} in the body');
  assert.equal(v.split("fn('vendor-profile', { action: 'get' })").length - 1, 2, 'both profile reads (apply prefill + My Profile) must use fn');
  assert.ok(v.includes("fn('vendor-profile', body)"), 'profile save must post its {action:save,...} body via fn');
  assert.ok(v.includes("fn('move-requests', { action: 'options'"), 'move options must ride fn with the action in the body');
  assert.ok(v.includes("fn('move-requests', { action: 'create'"), 'move create must ride fn with the action in the body');
  assert.ok(v.includes("fn('move-requests', { action: 'cancel'"), 'move cancel must ride fn with the action in the body');
  assert.ok(v.includes("fn('vendor-credit', { action: 'redeem'"), 'credit redeem must ride fn with the action in the body');
  assert.ok(v.includes("api('application-attempt-mine')"), 'draft restore is an api action, not a function call');
});

test('§29: fnq remains only on the query-action functions (communications, live-chat)', () => {
  // Those two functions genuinely read ?action= from the query string.
  const comms = readFileSync(join(root, 'netlify', 'functions', 'communications.mjs'), 'utf8');
  assert.ok(comms.includes("url.searchParams.get('action')"), 'communications must keep the query-action contract');
  const chat = readFileSync(join(root, 'netlify', 'functions', 'live-chat.mjs'), 'utf8');
  assert.ok(chat.includes("url.searchParams.get('action')"), 'live-chat must keep the query-action contract');
  for (const f of readdirSync(v2js).filter(x => x.endsWith('.js') && x !== 'api.js')) {
    const src = read(v2js, f);
    if (src.includes('fnq(')) assert.ok(['chat.js', 'comms.js'].includes(f), `fnq( found in ${f} — only chat.js/comms.js may use the query-action transport`);
  }
  // Recovery's attempt photo is an api action (GET with a path param),
  // not a sibling function — it rides api() with query params.
  const rec = read(v2js, 'apprecovery.js');
  assert.ok(!rec.includes('fnq('), 'apprecovery.js must not use fnq');
  assert.ok(rec.includes("api('attempt-photo', undefined, { path:"), 'attempt photos must load through the api action');
});

test("§29: 'mine' parity — v2 and classic share the one bookings payload, imported rows included by email match", () => {
  // Classic is the spec: its account page loads the same api('mine').
  const classic = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  assert.ok(classic.includes("api('mine')"), 'classic account page must load api mine');
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  const mine = apiSrc.slice(apiSrc.indexOf("action==='mine'"), apiSrc.indexOf("action==='vendor-setup-checkin'"));
  assert.ok(mine.includes('from market.bookings b'), 'mine must include the vendor\'s own bookings');
  assert.ok(mine.includes('from market.imported_attendees i'), 'mine must include imported attendee rows');
  assert.ok(mine.includes("lower(trim(both ' ,' from i.email))=lower("), 'imported inclusion must key on the verified account email');
  // Claiming annotates the rows (profile_linked); it never gates them.
  assert.ok(mine.includes('claimImported'), 'mine must still run the §13.5 claim annotation');
  assert.ok(mine.indexOf('from market.imported_attendees i') < mine.indexOf('claimImported'), 'imported rows must be selected before/regardless of the claim');
});

test('§30: the vendor header carries a Refresh button, wired to the shell refresh path', () => {
  const app = read(v2js, 'app.js');
  // The button renders only for the vendor role, next to Sign out in the
  // shared header — the organizer and manager shells never get it.
  assert.ok(app.includes('id="v2-refresh"'), 'the vendor header must render a Refresh button');
  assert.ok(app.includes("role === 'vendor' ? `<button class=\"btn small ghost-light\" id=\"v2-refresh\""), 'the Refresh button must be gated on the vendor role');
  assert.ok(app.includes("refreshBtn.onclick = onVendorRefresh"), 'the header must wire the Refresh button');
  // The handler re-runs the existing vendor refresh path — no new fetch
  // plumbing, no page reload, no session or navigation side effects.
  // (Slice bounded to the handler itself: route()'s error card further
  // down legitimately carries a Reload button.)
  const handler = app.slice(app.indexOf('async function onVendorRefresh()'), app.indexOf('const ctx = {'));
  assert.ok(handler.includes('if (vendorRefreshBusy) return;'), 'double-taps must not stack refreshes');
  assert.ok(handler.includes('await refreshVendor();'), 'the refresh must re-run refreshVendor (mine / moves / credits)');
  assert.ok(!handler.includes('location.reload'), 'the refresh must never reload the page');
  assert.ok(!handler.includes('resetSession'), 'the refresh must never sign anyone out');
  assert.ok(!handler.includes('navigate('), 'the refresh must never change navigation');
  // Busy state: the button disables and relabels while a refresh is in
  // flight, and the state survives renderChrome (which rebuilds the
  // header on every route) because the markup renders from the flag.
  assert.ok(app.includes('let vendorRefreshBusy = false;'), 'the busy flag must be module state');
  assert.ok(app.includes("b.textContent = vendorRefreshBusy ? 'Refreshing…' : 'Refresh';"), 'the button must show a busy label');
  assert.ok(handler.includes('vendorRefreshBusy = false;'), 'the handler must always clear the busy flag');
  // Failures are toasted, never swallowed (§29 lesson).
  assert.ok(handler.includes('toast(e.message'), 'a failed refresh must toast the error');
  assert.ok(handler.includes("toast('Refreshed · '"), 'a successful refresh must confirm with a toast');
});

test('§30: on the Apply screen the refresh updates data without re-rendering the form', () => {
  const app = read(v2js, 'app.js');
  const handler = app.slice(app.indexOf('async function onVendorRefresh()'), app.indexOf('const ctx = {'));
  const applyBranch = handler.slice(handler.indexOf("state.route.name === 'vapply'"), handler.indexOf('} else {'));
  // The apply branch refreshes the underlying payloads and the chrome,
  // and says the in-progress application was left alone.
  assert.ok(applyBranch.includes("state.publicData = await api('public')"), 'the apply refresh must freshen the public catalog for the next render');
  assert.ok(applyBranch.includes('renderChrome();'), 'the apply refresh must still refresh the header (next-market subtitle)');
  assert.ok(applyBranch.includes('left as-is'), 'the apply refresh toast must say the in-progress form was left as-is');
  assert.ok(!applyBranch.includes('route()'), 'the apply refresh must NOT re-route — re-rendering would wipe the in-progress form');
  assert.ok(!applyBranch.includes('renderVendorApply'), 'the apply refresh must NOT re-render the application form');
  // Every other vendor screen takes the re-render path.
  const otherBranch = handler.slice(handler.indexOf('} else {'), handler.indexOf('} catch (e)'));
  assert.ok(otherBranch.includes('await route();'), 'non-apply screens must re-render through route()');
  // renderVendorApply holds typed input only in the DOM: the wipe the
  // exception protects against is real (fields are read back from
  // form.elements at submit/scan time).
  const v = read(v2js, 'vendor.js');
  assert.ok(v.includes('form.elements.namedItem'), 'the apply form reads its fields from the DOM — re-render would destroy them');
});
