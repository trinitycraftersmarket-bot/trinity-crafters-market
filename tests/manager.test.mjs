import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {staffActionAllowed,hasStaffPermission} from '../server/permissions.mjs';

const manager={manager:true,admin:false,permissions:['applications','attendees','waitlist','shopper_rsvps','vendor_messages']};

test('Manager permissions are enforced by feature',()=>{
 assert.equal(hasStaffPermission(manager,'applications'),true);
 assert.equal(hasStaffPermission(manager,'live_chat'),false);
 for(const a of ['manager','booking','photo','rsvp-list','floor-attendees','attendance','imported-attendance','inspection'])assert.equal(staffActionAllowed(manager,a),true,a);
 for(const a of ['admin','expense','event','location','category','ban','sync','staff-list','staff-save','review','post'])assert.equal(staffActionAllowed(manager,a),false,a);
 const chatOnly={manager:true,admin:false,permissions:['live_chat']};
 assert.equal(staffActionAllowed(chatOnly,'manager'),true);
 assert.equal(staffActionAllowed(chatOnly,'booking'),false);
 assert.equal(staffActionAllowed({},'manager'),false);
});

test('API rejects direct Manager configuration and financial calls before SQL',async()=>{
 let source=await readFile('netlify/functions/api.mjs','utf8');
 source=source.replace(/^import .*;\n/gm,'');
 // Inline the REAL permissions module (audit 7.4.3): stringifying the two
 // exported functions (the old harness) silently drops the module-scope
 // ACTION_PERMISSION map, so staffActionAllowed threw ReferenceError inside
 // the handler and the api catch-all masked it as 400 instead of 403.
 const permissions=(await readFile('server/permissions.mjs','utf8')).replace(/^export /gm,'');
 const mock=permissions+`const ready=()=>true; const identity=async()=>({admin:false,manager:true,permissions:['applications','attendees','waitlist','shopper_rsvps','vendor_messages'],email:'manager@example.test'}); const db=()=>()=>{throw Error('Unexpected database access');};\n`;
 const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(mock+source).toString('base64'));
 for(const action of ['admin','expense','staff-save','event','location','ban','sync']){
  const response=await handler(new Request('https://market.test/.netlify/functions/api?action='+action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));assert.equal(response.status,403,action);
 }
 for(const payload of [{status:'paid'},{status:'held'},{status:'cancelled'},{status:'approved',exception:true}]){
  const response=await handler(new Request('https://market.test/.netlify/functions/api?action=booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));assert.equal(response.status,403);
 }
});
