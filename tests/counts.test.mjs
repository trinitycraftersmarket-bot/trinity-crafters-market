import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {normalizeSpace,vendorIdentityKey,eventInventory,publicCounts,categoryCountRows,assertCapacity} from '../server/counts.mjs';
import {syncInspection,syncSpace,syncCancellation} from '../server/twins.mjs';
import {isUserError} from '../server/core.mjs';

// counts.mjs / twins.mjs speak the postgres.js tagged-template protocol;
// adapt PGlite's query(text, params) to it (scalar parameters only).
function pgliteSql(db){
 return async(strings,...values)=>{
  let text='',params=[];
  strings.forEach((s,i)=>{text+=s;if(i<values.length){params.push(values[i]);text+='$'+params.length;}});
  return (await db.query(text,params)).rows;
 };
}

async function seededDb(){
 const db=new PGlite();
 await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
 await db.exec(await readFile('database/setup.sql','utf8'));
 await db.exec(await readFile('database/codify-live-schema.sql','utf8'));
 const sql=pgliteSql(db);
 const [loc]=await sql`insert into market.locations(name,address) values('Test Hall','1 Test Way') returning id`;
 const [event]=await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity) values(${loc.id},'2027-01-09',2,1) returning id,indoor_capacity,outdoor_capacity`;
 const cats={};
 for(const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`)cats[row.name]=row.id;
 async function booking({email,business,category,status,space,holdUntil=null}){
  const [app]=await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(gen_random_uuid(),'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning id`;
  const [b]=await sql`insert into market.bookings(application_id,event_id,space,price,status,hold_until) values(${app.id},${event.id},${space},4500,${status},${holdUntil}) returning id`;
  return b.id;
 }
 async function imported({email,business,category,space,cancelled=false}){
  const [i]=await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category_id,space,cancelled) values(${event.id},'Vendor',${business},${email},'7275550100',${category},${space},${cancelled}) returning id`;
  return i.id;
 }
 return {db,sql,event,cats,booking,imported};
}

test('space vocabulary is normalized in one place',()=>{
 assert.equal(normalizeSpace(' Inside '),'indoor');
 assert.equal(normalizeSpace('INDOOR'),'indoor');
 assert.equal(normalizeSpace('outside'),'outdoor');
 assert.equal(normalizeSpace('Outdoor'),'outdoor');
 assert.equal(normalizeSpace('patio'),null);
 assert.equal(normalizeSpace(null),null);
});

test('identity keys mirror the client dedupe order',()=>{
 assert.equal(vendorIdentityKey({vendor_id:'v1',email:'a@b.c'}),'vendor:v1');
 assert.equal(vendorIdentityKey({email:' Foo@Bar.com, '}),'email:foo@bar.com');
 assert.equal(vendorIdentityKey({email:'',phone:'(727) 555-1234'}),'phone:7275551234');
 assert.equal(vendorIdentityKey({business:"Joe's Crafts!",name:'Joe'}),'name:joescrafts');
});

test('user errors are plain Errors; faults are not',()=>{
 assert.equal(isUserError(new Error('This space is sold out.')),true);
 assert.equal(isUserError(new TypeError('x is not a function')),false);
 assert.equal(isUserError(new ReferenceError('x is not defined')),false);
 const dbErr=new Error('duplicate key');dbErr.code='23505';
 assert.equal(isUserError(dbErr),false);
 assert.equal(isUserError(null),false);
});

test('counts: twin dedupe, pending excluded, expired holds excluded, cancelled imports excluded',async()=>{
 const {db,sql,event,cats,booking,imported}=await seededDb();
 // Vendor A: approved booking + imported twin (messy email/space spellings) — counts ONCE.
 await booking({email:'a@example.com',business:'Alpha',category:cats.Bags,status:'approved',space:'indoor'});
 await imported({email:'A@example.com,',business:'Alpha',category:cats.Bags,space:' Inside '});
 // Vendor B: pending — does not reserve (owner decision).
 await booking({email:'b@example.com',business:'Beta',category:cats.Bags,status:'pending',space:'indoor'});
 // Vendor C: expired hold — does not reserve. Vendor C2: live hold — reserves.
 await booking({email:'c@example.com',business:'Gamma',category:cats.Candles,status:'held',space:'indoor',holdUntil:new Date(Date.now()-60000)});
 await booking({email:'c2@example.com',business:'Gamma Two',category:cats.Candles,status:'held',space:'indoor',holdUntil:new Date(Date.now()+3600000)});
 // Vendor D: imported only, outdoor. Vendor E: imported but cancelled.
 await imported({email:'d@example.com',business:'Delta',category:cats.Candles,space:'Outside'});
 await imported({email:'e@example.com',business:'Epsilon',category:cats.Bags,space:'Inside',cancelled:true});
 const inv=await eventInventory(sql,event.id);
 assert.equal(inv.indoor,2);   // A (deduped) + C2
 assert.equal(inv.outdoor,1);  // D
 assert.equal(inv.categories.get(String(cats.Bags)),1);   // A only
 assert.equal(inv.categories.get(String(cats.Candles)),2); // C2 + D
 assert.equal(inv.vendors.length,3);
 await db.close();
});

test('category rows carry the per-event override limit',async()=>{
 const {db,sql,event,cats,booking}=await seededDb();
 await booking({email:'a@example.com',business:'Alpha',category:cats.Bags,status:'paid',space:'indoor'});
 await sql`insert into market.event_category_limits(event_id,category_id,vendor_limit) values(${event.id},${cats.Bags},3)`;
 const counts=await publicCounts(sql);
 const allCats=await sql`select id,vendor_limit from market.categories`;
 const limits=await sql`select event_id,category_id,vendor_limit from market.event_category_limits`;
 const rows=categoryCountRows(counts,allCats,limits);
 const bags=rows.find(r=>String(r.event_id)===String(event.id)&&String(r.category_id)===String(cats.Bags));
 assert.equal(bags.used,1);
 assert.equal(bags.vendor_limit,3); // override wins over the category default (1)
 await db.close();
});

test('assertCapacity: full space, full category, exception, and twin self-key',async()=>{
 const {db,sql,event,cats,booking,imported}=await seededDb();
 await booking({email:'a@example.com',business:'Alpha',category:cats.Bags,status:'approved',space:'indoor'});
 await imported({email:'a@example.com',business:'Alpha',category:cats.Bags,space:'Inside'});
 await booking({email:'c2@example.com',business:'Gamma Two',category:cats.Candles,status:'paid',space:'indoor'});
 const ev={id:event.id,indoor_capacity:2,outdoor_capacity:1};
 // Indoor is full (2/2) for a new vendor.
 await assert.rejects(assertCapacity(sql,ev,{space:'indoor',categoryId:cats.Candles,limit:5}),/sold out/);
 // Bags is full (limit 1) even in the outdoor space (category spans spaces).
 await assert.rejects(assertCapacity(sql,ev,{space:'outdoor',categoryId:cats.Bags,limit:1}),/Category is full/);
 // ...unless an exception is approved.
 await assert.doesNotReject(assertCapacity(sql,ev,{space:'outdoor',categoryId:cats.Bags,limit:1,exception:true}));
 // Vendor A approving against their own imported twin does not double-consume.
 const selfKey=vendorIdentityKey({email:'a@example.com'});
 await assert.doesNotReject(assertCapacity(sql,ev,{space:'indoor',categoryId:cats.Bags,limit:1,selfKey}));
 await db.close();
});

test('twin sync: inspection, space, and cancellation fan out to the other record',async()=>{
 const {db,sql,event,cats,booking,imported}=await seededDb();
 const bookingId=await booking({email:'a@example.com',business:'Alpha',category:cats.Bags,status:'approved',space:'indoor'});
 const importedId=await imported({email:'a@example.com',business:'Alpha',category:cats.Bags,space:'Inside'});
 const key=vendorIdentityKey({email:'a@example.com'});
 // Inspection recorded on the booking reaches the imported twin.
 assert.equal(await syncInspection(sql,{eventId:event.id,key,exclude:{source:'booking',id:bookingId},status:'approved',notes:null,at:new Date().toISOString(),by:'staff@test'}),1);
 const [imp1]=await sql`select inspection_status from market.imported_attendees where id=${importedId}`;
 assert.equal(imp1.inspection_status,'approved');
 // Space move on the booking moves the imported twin (in its own vocabulary).
 assert.equal(await syncSpace(sql,{eventId:event.id,key,exclude:{source:'booking',id:bookingId},space:'outdoor'}),1);
 const [imp2]=await sql`select space from market.imported_attendees where id=${importedId}`;
 assert.equal(imp2.space,'Outside');
 // Cancellation of the imported record cancels the booking twin.
 assert.equal(await syncCancellation(sql,{eventId:event.id,key,exclude:{source:'imported',id:importedId}}),1);
 const [bk]=await sql`select status from market.bookings where id=${bookingId}`;
 assert.equal(bk.status,'cancelled');
 await db.close();
});
