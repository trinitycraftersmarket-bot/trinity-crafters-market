// server/vendor-payments.mjs — complete per-vendor payment history +
// organizer manual entry for past payments.
//
// Why this exists: the vendor profile (vendor-list payload, shared by the
// legacy Vendors panel and the v2 Vendor Directory) used to total each
// vendor from exactly ONE record set per source:
//  - application vendors: only the bookings/payments of the single
//    "representative" application (latest per email, picked by the
//    vendor-list distinct-on). Bookings attached to a vendor's earlier
//    applications silently vanished from their profile.
//  - PDF/imported vendors: only the imported rows inside one identity
//    partition (lower(email-or-name) of the representative row), with the
//    amount read from invoice_amount — a column that stays 0 unless a
//    payment was recorded through the Record-payment flow, so paid dates
//    showed "$0" and anything outside the partition never appeared.
// The aggregation below gathers every payment-bearing record for the
// vendor's identity — bookings across ALL their applications, imported
// attendee rows, the vendor_payments ledger (including credit traces) —
// and dedupes booking/imported twins the same way server/counts.mjs does
// (shared identity keys; the booking is the system of record and wins).
// Totals are computed FROM the resulting lines, so the card totals can
// never disagree with the history they sit above.
import {audit} from './core.mjs';
import {vendorIdentityKey,normalizeSpace} from './counts.mjs';

const cleanEmail=v=>String(v||'').trim().toLowerCase().replace(/,+$/,'');
const spaceLabel=s=>{const n=normalizeSpace(s);return n==='indoor'?'Inside':n==='outdoor'?'Outside':String(s||'').trim()||'Booth';};
const fmtDay=d=>{const s=String(d||'').slice(0,10);const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s;return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(+m[1],+m[2]-1,+m[3],12)));};
const isCreditMethod=v=>String(v||'').trim().toLowerCase()==='credit';

// vendor_payments gains two columns for manual past entries (event link +
// manual flag) and the receipt timestamp that historically existed only in
// the live DB. Lazy DDL, same pattern as vendor-credit.mjs; the fresh
// shape also lives in database/codify-live-schema.sql. Memoized per sql
// handle so vendor-list can call the history builder once per vendor.
const ensured=new WeakSet();
export async function ensureVendorPaymentColumns(sql){
 if(ensured.has(sql))return;
 await sql`alter table market.vendor_payments add column if not exists event_id uuid references market.events(id)`;
 await sql`alter table market.vendor_payments add column if not exists manual_entry boolean not null default false`;
 await sql`alter table market.vendor_payments add column if not exists receipt_sent_at timestamptz`;
 ensured.add(sql);
}

// Gather every record that belongs to one vendor-list row's identity.
// ref: {source:'application'|'pdf', id, email, phone, business, name, vendor_id?}
async function gather(sql,ref){
 const email=cleanEmail(ref?.email);
 let apps=email?await sql`select id,vendor_id,email,phone,business,name from market.applications where lower(trim(email))=${email}`:[];
 if(ref?.source==='application'&&ref?.id&&!apps.some(a=>String(a.id)===String(ref.id))){
  const [a]=await sql`select id,vendor_id,email,phone,business,name from market.applications where id=${ref.id}`;
  if(a)apps=[a,...apps];
 }
 const masterIds=new Set(apps.map(a=>a.vendor_id).filter(Boolean).map(String));
 if(ref?.vendor_id)masterIds.add(String(ref.vendor_id));
 let anchorImports=[];
 if(ref?.source==='pdf'&&ref?.id){
  const [i]=await sql`select id,vendor_id,email,phone,business,name from market.imported_attendees where id=${ref.id}`;
  if(i){anchorImports=[i];if(i.vendor_id)masterIds.add(String(i.vendor_id));}
 }
 // The same master vendor may have applied under a changed email — pull
 // those applications in too so their bookings are not orphaned.
 if(masterIds.size){
  const ids=[...masterIds];
  const more=await sql`select id,vendor_id,email,phone,business,name from market.applications where vendor_id=any(${ids}::uuid[])`;
  for(const a of more)if(!apps.some(x=>String(x.id)===String(a.id)))apps.push(a);
 }
 const keys=new Set();
 const addKeys=r=>{if(r)keys.add(vendorIdentityKey({vendor_id:r.vendor_id,email:r.email,phone:r.phone,business:r.business,name:r.name,id:r.id}));};
 addKeys(ref);apps.forEach(addKeys);anchorImports.forEach(addKeys);
 const appIds=apps.map(a=>a.id);
 const bookings=appIds.length?await sql`select b.id,b.application_id,b.event_id,b.space,b.price,b.status,b.payment_method,b.payment_reference,b.paid_at,to_char(e.date,'YYYY-MM-DD') event_date from market.bookings b join market.events e on e.id=b.event_id where b.application_id=any(${appIds}::uuid[])`:[];
 // Imported candidates: scoped by master vendor, email, or the anchor
 // row's identity partition, then filtered by the shared identity keys so
 // a different vendor who merely shares a name is never merged in.
 const cand=new Map();
 const addCand=rows=>{for(const r of rows)if(!cand.has(String(r.id)))cand.set(String(r.id),r);};
 if(masterIds.size){
  const ids=[...masterIds];
  addCand(await sql`select i.id,i.event_id,i.space,i.invoice_amount,i.payment_status,i.payment_method,i.payment_reference,i.paid_at,i.cancelled,i.vendor_id,i.email,i.phone,i.business,i.name,to_char(e.date,'YYYY-MM-DD') event_date from market.imported_attendees i join market.events e on e.id=i.event_id where i.vendor_id=any(${ids}::uuid[])`);
 }
 if(email){
  addCand(await sql`select i.id,i.event_id,i.space,i.invoice_amount,i.payment_status,i.payment_method,i.payment_reference,i.paid_at,i.cancelled,i.vendor_id,i.email,i.phone,i.business,i.name,to_char(e.date,'YYYY-MM-DD') event_date from market.imported_attendees i join market.events e on e.id=i.event_id where lower(trim(both ' ,' from coalesce(i.email,'')))=${email}`);
 }
 for(const a of anchorImports){
  const part=String(a.email||a.name||'').trim().toLowerCase();
  if(part)addCand(await sql`select i.id,i.event_id,i.space,i.invoice_amount,i.payment_status,i.payment_method,i.payment_reference,i.paid_at,i.cancelled,i.vendor_id,i.email,i.phone,i.business,i.name,to_char(e.date,'YYYY-MM-DD') event_date from market.imported_attendees i join market.events e on e.id=i.event_id where lower(coalesce(nullif(i.email,''),i.name))=${part}`);
 }
 const imported=[...cand.values()].filter(r=>keys.has(vendorIdentityKey({vendor_id:r.vendor_id,email:r.email,phone:r.phone,business:r.business,name:r.name,id:r.id})));
 const bookingIds=bookings.map(b=>b.id),importIds=imported.map(i=>i.id);
 const payments=new Map();
 const addPay=rows=>{for(const r of rows)if(!payments.has(String(r.id)))payments.set(String(r.id),r);};
 if(appIds.length)addPay(await sql`select vp.id,vp.application_id,vp.booking_id,vp.imported_attendee_id,vp.vendor_id,vp.event_id,vp.amount,vp.payment_method,vp.paid_at,vp.note,vp.recorded_by,vp.manual_entry,vp.receipt_sent_at,vp.created_at from market.vendor_payments vp where vp.application_id=any(${appIds}::uuid[])`);
 if(bookingIds.length)addPay(await sql`select vp.id,vp.application_id,vp.booking_id,vp.imported_attendee_id,vp.vendor_id,vp.event_id,vp.amount,vp.payment_method,vp.paid_at,vp.note,vp.recorded_by,vp.manual_entry,vp.receipt_sent_at,vp.created_at from market.vendor_payments vp where vp.booking_id=any(${bookingIds}::uuid[])`);
 if(importIds.length)addPay(await sql`select vp.id,vp.application_id,vp.booking_id,vp.imported_attendee_id,vp.vendor_id,vp.event_id,vp.amount,vp.payment_method,vp.paid_at,vp.note,vp.recorded_by,vp.manual_entry,vp.receipt_sent_at,vp.created_at from market.vendor_payments vp where vp.imported_attendee_id=any(${importIds}::uuid[])`);
 if(masterIds.size)addPay(await sql`select vp.id,vp.application_id,vp.booking_id,vp.imported_attendee_id,vp.vendor_id,vp.event_id,vp.amount,vp.payment_method,vp.paid_at,vp.note,vp.recorded_by,vp.manual_entry,vp.receipt_sent_at,vp.created_at from market.vendor_payments vp where vp.vendor_id=any(${[...masterIds]}::uuid[])`);
 return {apps,bookings,imported,payments:[...payments.values()]};
}

// Build the unified, deduped, newest-first payment history for one vendor
// plus the card totals derived from those exact lines.
// Line: {kind, label, event_id, event_date, space, amount (cents|null),
// amount_recorded, method, reference, paid_at, note, payment_id,
// receipt_sent_at, sort_date}
export async function vendorPaymentHistory(sql,ref){
 await ensureVendorPaymentColumns(sql);
 const {bookings,imported,payments}=await gather(sql,ref);
 const lines=[];
 const boothByRecord=new Map(); // 'booking:<id>' / 'imported:<id>' -> line
 const addBooth=(rec,source)=>{
  const credit=isCreditMethod(rec.payment_method);
  const raw=source==='booking'?rec.price:rec.invoice_amount;
  const amount=raw!=null&&Number(raw)>0?Number(raw):null;
  const line={kind:credit?'Credit':source==='booking'?'Booking':'Import',
   label:`Booth — ${fmtDay(rec.event_date)} · ${spaceLabel(rec.space)}`,
   event_id:rec.event_id,event_date:rec.event_date,space:spaceLabel(rec.space),
   amount,amount_recorded:amount!=null,
   method:rec.payment_method?String(rec.payment_method):null,
   reference:rec.payment_reference||null,
   paid_at:rec.paid_at||null,note:null,payment_id:null,receipt_sent_at:null,
   sort_date:rec.event_date};
  lines.push(line);boothByRecord.set(source+':'+rec.id,line);
  return line;
 };
 // Twin dedupe per event + space, mirroring counts.mjs: a booking and an
 // imported row for the same vendor/event/space are ONE booth — the
 // booking (system of record) wins. Different spaces on the same date are
 // genuinely two booths and both stand.
 const taken=new Set();
 for(const b of bookings){
  if(b.status!=='paid')continue;
  const k=String(b.event_id)+'|'+(normalizeSpace(b.space)||'');
  if(taken.has(k))continue;
  taken.add(k);addBooth(b,'booking');
 }
 for(const i of imported){
  if(i.cancelled||String(i.payment_status||'').toLowerCase()!=='paid')continue;
  const k=String(i.event_id)+'|'+(normalizeSpace(i.space)||'');
  if(taken.has(k))continue;
  taken.add(k);addBooth(i,'imported');
 }
 // Ledger rows: a non-manual row that settles a booth line above is that
 // line's receipt (attach, never a second line — no double counting).
 // Manual entries always stand alone, as do ledger rows whose record is
 // not a paid booth line (e.g. the booking was later cancelled).
 const standalone=[];
 const byPaidDesc=[...payments].sort((a,b)=>String(b.paid_at||b.created_at||'').localeCompare(String(a.paid_at||a.created_at||'')));
 for(const vp of byPaidDesc){
  if(!vp.manual_entry){
   const target=(vp.booking_id&&boothByRecord.get('booking:'+vp.booking_id))||(vp.imported_attendee_id&&boothByRecord.get('imported:'+vp.imported_attendee_id));
   if(target&&!target.payment_id){target.payment_id=vp.id;target.receipt_sent_at=vp.receipt_sent_at||null;continue;}
  }
  standalone.push(vp);
 }
 const eventDates=new Map();
 const needEvents=standalone.filter(vp=>vp.event_id).map(vp=>vp.event_id);
 if(needEvents.length){
  for(const e of await sql`select id,to_char(date,'YYYY-MM-DD') event_date from market.events where id=any(${needEvents}::uuid[])`)eventDates.set(String(e.id),e.event_date);
 }
 for(const vp of standalone){
  const evDate=vp.event_id?eventDates.get(String(vp.event_id))||null:null;
  const note=vp.note?String(vp.note):null;
  lines.push({kind:vp.manual_entry?'Manual entry':'Recorded payment',
   label:evDate?`Booth — ${fmtDay(evDate)}`:(note||(vp.manual_entry?'Manual payment':'Recorded payment')),
   event_id:vp.event_id||null,event_date:evDate,space:null,
   amount:Number(vp.amount)>0?Number(vp.amount):null,amount_recorded:Number(vp.amount)>0,
   method:vp.payment_method?String(vp.payment_method):null,reference:null,
   paid_at:vp.paid_at||null,note,payment_id:vp.id,receipt_sent_at:vp.receipt_sent_at||null,
   sort_date:evDate||String(vp.paid_at||'').slice(0,10)||null});
 }
 const boothKinds=new Set(['Booking','Import','Credit']);
 lines.sort((a,b)=>String(b.sort_date||'').localeCompare(String(a.sort_date||''))||((boothKinds.has(a.kind)?0:1)-(boothKinds.has(b.kind)?0:1))||String(b.paid_at||'').localeCompare(String(a.paid_at||'')));
 const booth=lines.filter(l=>boothKinds.has(l.kind));
 const totals={
  shows:new Set(booth.map(l=>String(l.event_id))).size,
  booking_spend:booth.reduce((n,l)=>n+(l.amount||0),0),
  recorded_payments:lines.filter(l=>!boothKinds.has(l.kind)).reduce((n,l)=>n+(l.amount||0),0)
 };
 return {lines,totals};
}

// --- Manual entry for a past payment -------------------------------------
// The organizer records money that arrived outside the booking flow (cash
// at the door for a past market, a barter offset note, …). It never
// requires — and never creates or mutates — a booking; it is a ledger row
// in market.vendor_payments flagged manual_entry, anchored to the vendor
// by application (application vendors) or by their representative imported
// row (PDF vendors), with an optional market date and a free-text note.
export const MANUAL_PAYMENT_METHODS=['cash','check','GoDaddy Payments','PayPal','other'];

function validDateOnly(v){
 if(v==null||v==='')return new Date().toISOString().slice(0,10);
 const s=String(v).slice(0,10),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(!m)throw Error('Enter a valid date paid.');
 const y=+m[1],mo=+m[2],d=+m[3],dt=new Date(Date.UTC(y,mo-1,d));
 if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)throw Error('Enter a valid date paid.');
 return s;
}

export async function recordManualPayment(sql,u,p={}){
 if(!u?.admin)throw Error('Organizer access only');
 await ensureVendorPaymentColumns(sql);
 const amount=Math.round(Number(p.amount)*100);
 if(!Number.isFinite(amount)||amount<=0)throw Error('Enter a valid payment amount.');
 const method=String(p.payment_method||'cash').trim();
 if(!MANUAL_PAYMENT_METHODS.includes(method))throw Error('Choose a payment method from the list.');
 const dateOnly=validDateOnly(p.paid_at);
 // Mid-afternoon UTC keeps the calendar date stable in US time zones when
 // the receipt/history renders paid_at in America/New_York.
 const paidAt=dateOnly+'T16:00:00.000Z';
 const note=String(p.note||'').trim().slice(0,500)||null;
 let applicationId=null,importedId=null,vendorId=null;
 if(p.application_id){
  const [a]=await sql`select id,vendor_id from market.applications where id=${p.application_id}`;
  if(!a)throw Error('Vendor not found.');
  applicationId=a.id;vendorId=a.vendor_id||null;
 }else if(p.imported_attendee_id){
  const [i]=await sql`select id,vendor_id from market.imported_attendees where id=${p.imported_attendee_id}`;
  if(!i)throw Error('Vendor not found.');
  importedId=i.id;vendorId=i.vendor_id||null;
 }else if(p.vendor_id){
  const [v]=await sql`select id from market.vendors where id=${p.vendor_id}`;
  if(!v)throw Error('Vendor not found.');
  vendorId=v.id;
 }else throw Error('Vendor not found.');
 let eventId=null;
 if(p.event_id){
  const [e]=await sql`select id from market.events where id=${p.event_id}`;
  if(!e)throw Error('Market date not found.');
  eventId=e.id;
 }
 const [saved]=await sql.begin(async tx=>{
  const [row]=await tx`insert into market.vendor_payments(application_id,imported_attendee_id,booking_id,event_id,amount,payment_method,paid_at,note,vendor_id,recorded_by,manual_entry) values(${applicationId},${importedId},null,${eventId},${amount},${method},${paidAt},${note},${vendorId},${u.email},true) returning *`;
  await audit(tx,u,'manual vendor payment recorded',{payment_id:row.id,application_id:applicationId,imported_attendee_id:importedId,vendor_id:vendorId,event_id:eventId,amount,payment_method:method,paid_at:paidAt,note});
  return [row];
 });
 return saved;
}
