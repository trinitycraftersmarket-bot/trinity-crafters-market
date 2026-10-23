// Setup-email floor-plan attachments (Oct 23, 2026 fixes):
//  1. Vendors must receive the COMPLETED floor plan — the saved layout
//     with vendor names pinned at their spots. Only the client can
//     draw names, so the editor composes each area's named plan at
//     send time and ships it in the payload as area_images[area_key];
//     the server prefers it and falls back to the raw saved image.
//  2. The old guard blocked the whole send when ANY recipient lacked
//     an attachment (outdoor vendors in an image-less area, vendors
//     not placed yet). Only a recipient whose assigned area HAS an
//     image available yet who ends up with no attachment may block.
//  3. Test mode: one email to the organizer, '[TEST] ' subject, every
//     area's plan attached, no vendor mail, no setup bookkeeping.
// The pure selection/guard logic lives in server/floorplan-mail.mjs
// and is behavior-tested here; the handler wiring is pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  floorPlanDataUrlAttachment, pickAreaAttachment, allAreaAttachments, blockedRecipients
} from '../server/floorplan-mail.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiSrc = readFileSync(join(root, 'netlify/functions/api.mjs'), 'utf8');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const WEBP = 'data:image/webp;base64,UklGRg==';

test('data-url attachment: ext mapping and content follow the saved-image convention', () => {
  assert.deepEqual(floorPlanDataUrlAttachment(PNG, 'Indoor-Room-Floor-Plan'), { filename: 'Indoor-Room-Floor-Plan.png', content: 'iVBORw0KGgo=' });
  assert.deepEqual(floorPlanDataUrlAttachment(JPG, 'Indoor-Room-Floor-Plan'), { filename: 'Indoor-Room-Floor-Plan.jpg', content: '/9j/4AAQSkZJRg==' });
  assert.deepEqual(floorPlanDataUrlAttachment(WEBP, 'Indoor-Room-Floor-Plan'), { filename: 'Indoor-Room-Floor-Plan.webp', content: 'UklGRg==' });
});

test('data-url attachment: unusable values are rejected, not attached', () => {
  for (const bad of ['', null, undefined, 'https://example.com/plan.png', 'data:image/gif;base64,AAAA', 'data:image/png;base64,', 'data:text/html;base64,AAAA']) {
    assert.equal(floorPlanDataUrlAttachment(bad, 'X-Floor-Plan'), null, JSON.stringify(bad));
  }
  const oversized = 'data:image/jpeg;base64,' + 'A'.repeat(2800000);
  assert.equal(floorPlanDataUrlAttachment(oversized, 'X-Floor-Plan'), null, 'over the 2.8M-char ceiling');
});

test('pickAreaAttachment: the composed named plan wins over the raw saved image', () => {
  const area = { title: 'Indoor Room', image_data_url: PNG };
  const picked = pickAreaAttachment(area, JPG);
  assert.equal(picked.filename, 'Indoor-Room-Floor-Plan.jpg');
  assert.equal(picked.content, '/9j/4AAQSkZJRg==', 'attachment bytes are the composed image, not the raw upload');
});

test('pickAreaAttachment: falls back to the raw saved image when no composed image was supplied', () => {
  const area = { title: 'Indoor Room', image_data_url: PNG };
  assert.deepEqual(pickAreaAttachment(area, ''), { filename: 'Indoor-Room-Floor-Plan.png', content: 'iVBORw0KGgo=' });
  assert.deepEqual(pickAreaAttachment(area, 'not-a-data-url'), { filename: 'Indoor-Room-Floor-Plan.png', content: 'iVBORw0KGgo=' }, 'an invalid composed value must not sink the raw fallback');
  assert.equal(pickAreaAttachment({ title: 'Outside', image_data_url: '' }, ''), null, 'no image anywhere -> no attachment');
  assert.equal(pickAreaAttachment({ title: 'Outside', image_data_url: '' }, JPG).filename, 'Outside-Floor-Plan.jpg', 'a composed plan alone is enough');
});

test('allAreaAttachments: every area once, in order, nulls dropped', () => {
  const a = { filename: 'Indoor-Room-Floor-Plan.jpg', content: 'AAA' };
  const b = { filename: 'Hallway-Floor-Plan.jpg', content: 'BBB' };
  assert.deepEqual(allAreaAttachments([a, null, b, a, undefined]), [a, b]);
  assert.deepEqual(allAreaAttachments([]), []);
  assert.deepEqual(allAreaAttachments(undefined), []);
});

test('blockedRecipients: image-less areas and unplaced vendors never block', () => {
  const byEmail = new Map([
    // Assigned only to an outdoor area with no uploaded image.
    ['outdoor@example.com', { attachments: [], notes: ['Outside: OUT-01'], available_areas: [] }],
    // Assigned to an imaged area and receiving its plan.
    ['indoor@example.com', { attachments: [{ filename: 'Indoor-Room-Floor-Plan.jpg', content: 'AAA' }], notes: ['Indoor Room: HI-01'], available_areas: ['Indoor Room'] }],
    // In both an image-less and an imaged area; the imaged one attaches.
    ['both@example.com', { attachments: [{ filename: 'Hallway-Floor-Plan.jpg', content: 'BBB' }], notes: ['Outside: OUT-02', 'Hallway: HW-01'], available_areas: ['Hallway'] }]
  ]);
  assert.deepEqual(blockedRecipients(byEmail), []);
  assert.deepEqual(blockedRecipients(new Map()), []);
  assert.deepEqual(blockedRecipients(null), []);
});

test('blockedRecipients: an imaged area with a lost attachment still blocks', () => {
  const byEmail = new Map([
    ['lost@example.com', { attachments: [], notes: ['Indoor Room: HI-03'], available_areas: ['Indoor Room'] }],
    ['fine@example.com', { attachments: [], notes: [], available_areas: [] }]
  ]);
  assert.deepEqual(blockedRecipients(byEmail), ['lost@example.com']);
});

test('setup-email wiring: composed payload, guard and CC/test assembly go through the shared helpers', () => {
  assert.ok(apiSrc.includes("await eventAreaMailPackages(sql,event.id,rows,p.area_images&&typeof p.area_images==='object'?p.area_images:{})"), 'the handler must pass the client-composed area_images into the package builder');
  assert.ok(apiSrc.includes('pickAreaAttachment(area,composed)'), 'package builder selects composed-first per area');
  assert.ok(apiSrc.includes('const blocked=blockedRecipients(customFloor.byEmail)'), 'the send guard is the shared blockedRecipients decision');
  assert.ok(!apiSrc.includes('do not yet have an assigned spot with an uploaded area map'), 'the old block-everyone guard text is gone');
  assert.ok(apiSrc.includes('allAreaAttachments(customFloor.area_attachments)'), 'CC copy and test email assemble every area attachment');
});

test('setup-email wiring: test mode is a single organizer email with no bookkeeping', () => {
  const start = apiSrc.indexOf("if(action==='setup-email'){");
  const block = apiSrc.slice(start, apiSrc.indexOf("if(action==='floor-plan-save'){", start));
  const testAt = block.indexOf('if(testMode){');
  const bookkeepingAt = block.indexOf('setup_sent_at=now()');
  assert.ok(testAt > -1, 'test branch exists');
  assert.ok(bookkeepingAt > -1 && testAt < bookkeepingAt, 'the test branch returns before the setup_sent_at / snapshot update');
  const testReturnAt = block.indexOf('return json({ok:true,test:true', testAt);
  assert.ok(testReturnAt > testAt, 'test branch returns its own response');
  const testBlock = block.slice(testAt, testReturnAt + 120);
  assert.ok(testBlock.includes("queue(tx,u.email,'[TEST] '+subject,body,null,"), 'one email to the organizer with the [TEST] subject prefix and the composed body');
  assert.ok(testBlock.includes("audit(tx,u,'setup instructions email (test)'"), 'test sends audit-log distinctly');
  assert.ok(testBlock.includes('sent_to:u.email'), 'the response names the address the test went to');
  assert.ok(!/queue\(tx,r\.email/.test(testBlock), 'test mode queues no vendor email');
  assert.ok(block.includes('testMode=p.test===true'), 'test mode is driven by the payload test flag');
  assert.ok(block.includes('if(!testMode&&!recipients.length)'), 'a test send is not blocked by an empty vendor list');
});
