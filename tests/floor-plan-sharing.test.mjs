// Floor-plan sharing (owner decision, Oct 22, 2026): the venue gate is
// gone. Saved floor plans render on the public market-date page at every
// venue (Hilton Garden Inn included), the floor-area-plans read is public,
// and setup emails may attach plans everywhere. These are wiring checks
// over the shipped sources, matching the style of the other suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = readFileSync(join(root, 'netlify/functions/api.mjs'), 'utf8');
const app = readFileSync(join(root, 'public/app.js'), 'utf8');
const floorAreas = readFileSync(join(root, 'public/floor-areas.js'), 'utf8');

test('market-details page wires the saved floor plan in', () => {
  assert.ok(app.includes('id="market-floorplan"'), 'date page needs the floor plan host element');
  assert.ok(
    app.includes('showSavedFloorPlans({host:fpHost,eventId:e.id,api,esc,hideWhenEmpty:true})'),
    'date page must render the saved plans, and render nothing when none are saved'
  );
});

test('floor-area-plans is publicly readable ahead of the identity wall', () => {
  const branch = api.indexOf("if(action==='floor-area-plans'){");
  const wall = api.indexOf('const u=await identity(req),sql=db();');
  assert.ok(branch > -1 && wall > -1 && branch < wall, 'the public read branch must run before identity(req) is required');
  const getAreaPlans = api.slice(api.indexOf('async function getAreaPlans'), api.indexOf('async function saveAreaPlans'));
  assert.ok(getAreaPlans.includes("hasStaffPermission(u,'floor_plans')"), 'staff callers keep the full editor payload');
  assert.ok(!getAreaPlans.includes("if(!hasStaffPermission(u,'floor_plans'))return json({error:'Access denied'},403);"), 'non-staff readers must not be hard-denied');
  assert.ok(getAreaPlans.includes('vendor_names'), 'public payload carries pin display names (floor-attendees stays staff-only)');
});

test('no venue gate remains in setup-email or the setup sharing UI', () => {
  assert.ok(api.includes('const floorPlanSharingAllowed=true;'), 'setup-email floor-plan sharing is always allowed');
  assert.ok(!/floorPlanSharingAllowed=\//.test(api), 'setup-email must not regex-gate attachments by venue');
  const start = app.indexOf('const updateFloorSharePolicy');
  const policy = app.slice(start, app.indexOf('const draw=', start));
  assert.ok(policy.includes('option.disabled=false'), 'attach-floor option is enabled for every venue');
  assert.ok(policy.includes("'Send Setup Instructions + Floor Plan'"), 'send button always offers the floor plan');
  assert.ok(!policy.includes('canSendMaps'), 'the venue name check is removed');
  assert.ok(!policy.includes('organizer-only'), 'the Hilton organizer-only wording is removed');
});

test('saved-plan renderer tolerates the staff-only attendee fetch', () => {
  assert.ok(
    floorAreas.includes("api('floor-attendees&event_id='+encodeURIComponent(eventId)).catch(()=>null)"),
    'a denied attendee fetch must not sink the public render'
  );
  assert.ok(floorAreas.includes('result.vendor_names'), 'pin names fall back to the plans payload');
  assert.ok(floorAreas.includes('hideWhenEmpty'), 'public hosts can suppress the empty/error cards');
});
