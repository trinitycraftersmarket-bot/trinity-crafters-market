import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {staffActionAllowed} from '../server/permissions.mjs';
test('Manager has only application and attendance permissions',()=>{
 const manager={manager:true,admin:false};
 for(const a of ['manager','booking','photo','rsvp-list'])assert.equal(staffActionAllowed(manager,a),true);
 for(const a of ['admin','expense','event','location','category','ban','sync','staff-list','staff-save','review','post'])assert.equal(staffActionAllowed(manager,a),false,a);
 assert.equal(staffActionAllowed({},'manager'),false);
});
test('API rejects direct Manager configuration and financial calls before SQL',async()=>{
 let source=await readFile('netlify/functions/api.mjs','utf8');
 source=source.replace(/^import .*;\n/gm,'');
 const mock=`const staffActionAllowed=${staffActionAllowed.toString()}; const ready=()=>true; const identity=async()=>({admin:false,manager:true,email:'manager@example.test'}); const db=()=>()=>{throw Error('Unexpected database access');};\n`;
 const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(mock+source).toString('base64'));
 for(const action of ['admin','expense','staff-save','event','location','ban','sync']){
 const response=await handler(new Request('https://market.test/.netlify/functions/api?action='+action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));assert.equal(response.status,403,action);
 }
 for(const payload of [{status:'paid'},{status:'held'},{status:'cancelled'},{status:'approved',exception:true}]){
 const response=await handler(new Request('https://market.test/.netlify/functions/api?action=booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));assert.equal(response.status,403);
 }
});
