import {ready,db,flushMail,queue,audit,supa} from '../../server/core.mjs';
import {syncCalendar} from '../../server/sync.mjs';
import {scanAllFutureWaitlists,scanWaitlist,sweepWaitlist} from '../../server/waitlist.mjs';

const paypalBase=()=>process.env.PAYPAL_ENV==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
async function paypalToken(){
 if(!process.env.PAYPAL_CLIENT_ID||!process.env.PAYPAL_CLIENT_SECRET)return null;
 const auth=Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');
 const r=await fetch(paypalBase()+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(10000)});
 if(!r.ok)return null; const v=await r.json(); return v.access_token||null;
}
async function paypalInvoiceStatus(token,id){
 if(!token||!id)return null;
 try{const r=await fetch(paypalBase()+'/v2/invoicing/invoices/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token,'Accept':'application/json'},signal:AbortSignal.timeout(10000)});if(!r.ok)return null;const v=await r.json();return v.status||null;}catch{return null;}
}
const paidStatuses=new Set(['PAID','MARKED_AS_PAID','PAID_EXTERNAL']);
const dateOnly=v=>{
 const ymd=v instanceof Date?v.toISOString().slice(0,10):(String(v??'').match(/\d{4}-\d{2}-\d{2}/)?.[0]||'');
 return ymd?new Date(ymd+'T12:00:00Z'):null;
};
const displayDate=v=>{
 const d=dateOnly(v);
 return d?d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}):'your scheduled market date';
};

// §45 (Oct 24, 2026) — unpaid manually-invoiced (GoDaddy) holds: a
// reminder ladder + 48-hour close-out, layered ON TOP of the legacy
// 24-hour hold rule in handleHeldPayments below (the inner rule —
// unchanged for everyone else; this ladder runs first each sweep so its
// rungs fire on bookings that are still held when a mark passes).
// Audience: bookings still 'held' with a manually recorded invoice
// reference whose market has not started. PayPal holds are excluded —
// their invoice_reference is a PayPal invoice id, not a GoDaddy
// reference, and their sends/sync live in the legacy path. Vendors
// flagged payment_reminder_exempt are excluded from every rung,
// including the close-out (see the seed below).
// Marks (spec defaults): rung 1 at invoice-sent +48h; rung 2 at
// market −72h; close-out at market −48h. Each rung is claimed by a
// send-once stamp on the booking row inside the transaction that
// queues the email (§35 pattern) — re-runs and racing sweeps send
// nothing twice. Market marks are computed in SQL against the
// America/New_York wall clock (the server/moves.mjs precedent).
const PAT_REMINDER_EXEMPT_EMAIL='pelalem@msn.com';

async function ensureInvoiceHoldLadder(){
 const sql=db();
 // Send-once stamps + the waitlist stamp the close-out transition sets
 // (codified in database/codify-live-schema.sql §13; runtime ALTERs keep
 // deploys that predate the columns safe, the §35 pattern).
 await sql`alter table market.bookings add column if not exists invoice_reminder1_sent_at timestamptz`;
 await sql`alter table market.bookings add column if not exists invoice_reminder2_sent_at timestamptz`;
 await sql`alter table market.bookings add column if not exists invoice_closeout_at timestamptz`;
 await sql`alter table market.bookings add column if not exists waitlisted_at timestamptz`;
 await sql`alter table market.applications add column if not exists payment_reminder_exempt boolean not null default false`;
 // One-time seed (settings marker): Pat's Potions (Pat Elalem) pays on
 // the 1st of the month by standing arrangement, so she is exempt from
 // the reminder/close-out automation. Seeded ONCE by email match —
 // after that the flag is plain data and a manual change is never
 // re-seeded over. NOT Pam Briscoe (different person; pays cash).
 const [seeded]=await sql`select key from market.settings where key='payment_reminder_exempt_seeded'`;
 if(seeded)return;
 await sql`update market.applications set payment_reminder_exempt=true where lower(email)=${PAT_REMINDER_EXEMPT_EMAIL}`;
 try{
  const [t]=await sql`select to_regclass('market.vendor_profiles') as reg`;
  if(t?.reg){
   await sql`alter table market.vendor_profiles add column if not exists payment_reminder_exempt boolean not null default false`;
   await sql`update market.vendor_profiles set payment_reminder_exempt=true where lower(email)=${PAT_REMINDER_EXEMPT_EMAIL}`;
  }
 }catch(e){console.error('§45 vendor_profiles exemption sync failed',e);}
 await sql`insert into market.settings(key,value) values('payment_reminder_exempt_seeded','1') on conflict(key) do nothing`;
 await audit(sql,'system','payment reminder exemption seeded',{email:PAT_REMINDER_EXEMPT_EMAIL});
}

async function sweepInvoiceHoldLadder(){
 const sql=db();
 const rows=await sql`
  select b.id,b.event_id,b.invoice_reference,b.hold_until,b.price,b.space,b.invoice_reminder1_sent_at,b.invoice_reminder2_sent_at,
    a.name,a.business,a.email,e.date,l.name location,
    coalesce((select max(x.created_at) from market.audit x where x.detail->>'id'=b.id::text and x.action in ('paypal invoice sent','booking held')),b.hold_until-interval '24 hours') as held_at,
    exists(select 1 from market.audit x where x.detail->>'id'=b.id::text and x.action='paypal invoice sent') as paypal_hold,
    ((e.date+coalesce(e.start_time,time '10:00'))-interval '48 hours' <= (now() at time zone 'America/New_York')) as closeout_due,
    ((e.date+coalesce(e.start_time,time '10:00'))-interval '72 hours' <= (now() at time zone 'America/New_York')) as rung2_due
  from market.bookings b
  join market.applications a on a.id=b.application_id
  join market.events e on e.id=b.event_id
  join market.locations l on l.id=e.location_id
  where b.status='held'
    and nullif(trim(b.invoice_reference),'') is not null
    and not coalesce(a.payment_reminder_exempt,false)
    and (e.date+coalesce(e.start_time,time '10:00')) > (now() at time zone 'America/New_York')`;
 for(const b of rows){
  if(b.paypal_hold)continue;
  const day=displayDate(b.date),space=b.space==='indoor'?'Indoor':'Outdoor',amount='$'+(Number(b.price)/100).toFixed(2);
  if(b.closeout_due){
   // Close-out: the held spot is released and the booking moves to the
   // wait-list with the organizer waitlist transition's field semantics
   // (status + decision_reason + waitlisted_at + hold cleared) — a
   // booking row cannot be both 'cancelled' and waitlisted, and the
   // unique(application_id, event_id) constraint forbids a second row,
   // so the cancellation of the spot is recorded in the audit, the
   // vendor-facing reason, and the final email. The freed spot then
   // goes through the normal waitlist scan, like the legacy cancel.
   let closed=false;
   await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(708821)`;
    const claimed=await tx`update market.bookings set invoice_closeout_at=now() where id=${b.id} and status='held' and invoice_closeout_at is null returning id`;
    if(!claimed.length)return;
    closed=true;
    await tx`update market.bookings set status='waitlist',hold_until=null,waitlisted_at=now(),waitlist_offered_at=null,decision_reason='Invoice unpaid — spot released at the 48-hour close-out; moved to the wait-list.' where id=${b.id}`;
    const body=`Hi ${b.name},\n\nYour vendor spot for ${day} at ${b.location} has been closed out because the invoice (reference ${b.invoice_reference}) was still unpaid 48 hours before the market. Your space has been released.\n\nYou've been moved to the wait-list for this date. If a space opens up, we'll contact you. Please don't pay the outstanding invoice while you're on the wait-list — if a spot is confirmed for you again, we'll let you know how to pay.\n\nIf you'd still like to attend, just reply to this email.\n\nThank you,\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await queue(tx,b.email,`Your spot was released — you're on the wait-list for ${day}`,body);
    await audit(tx,'system','invoice hold closed out',{id:b.id,event_id:b.event_id,invoice_reference:b.invoice_reference});
   });
   if(closed)await sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(708821)`;await scanWaitlist(tx,b.event_id,{space:b.space,actor:'system'});});
   continue;
  }
  const reminder=rung=>({
   subject:rung===2?`Final payment reminder — your spot for ${day}`:`Payment reminder — your spot for ${day}`,
   body:`Hi ${b.name},\n\n${rung===2?'This is a second reminder that':'This is a reminder that'} the vendor invoice for your Trinity Crafters Market spot has not been paid yet.\n\nPlease check your email for the GoDaddy invoice (reference ${b.invoice_reference}) and pay it as soon as you can — we can't hold spots without payment.\n\nMarket: ${b.location}\nDate: ${day}\nSpace: ${space}\nAmount due: ${amount}\n\nUnpaid spots are closed out 48 hours before the market and the space is released. If that happens, you'll be moved to the wait-list for that date.\n\nIf you need more time, just reply to this email and tell us when you'll pay — we'd rather hear from you than release your spot.\n\nThank you,\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`,
  });
  if(b.rung2_due){
   if(b.invoice_reminder2_sent_at)continue;
   const {subject,body}=reminder(2);
   await sql.begin(async tx=>{
    const claimed=await tx`update market.bookings set invoice_reminder2_sent_at=now() where id=${b.id} and status='held' and invoice_reminder2_sent_at is null returning id`;
    if(!claimed.length)return;
    await queue(tx,b.email,subject,body);
    await audit(tx,'system','invoice payment reminder sent',{id:b.id,rung:2,invoice_reference:b.invoice_reference});
   });
   continue;
  }
  // Rung 1 is only reachable before the market marks open (the window
  // closes when rung 2's opens), and needs the invoice-sent timestamp.
  if(b.invoice_reminder1_sent_at||!b.held_at)continue;
  const sentAt=new Date(b.held_at);
  if(!Number.isFinite(sentAt.getTime())||Date.now()<sentAt.getTime()+48*3600000)continue;
  const {subject,body}=reminder(1);
  await sql.begin(async tx=>{
   const claimed=await tx`update market.bookings set invoice_reminder1_sent_at=now() where id=${b.id} and status='held' and invoice_reminder1_sent_at is null returning id`;
   if(!claimed.length)return;
   await queue(tx,b.email,subject,body);
   await audit(tx,'system','invoice payment reminder sent',{id:b.id,rung:1,invoice_reference:b.invoice_reference,held_at:sentAt.toISOString()});
  });
 }
}

async function handleHeldPayments(){
 const sql=db(),token=await paypalToken();
 const held=await sql`
  select b.id,b.event_id,b.invoice_reference,b.hold_until,b.price,b.space,a.name,a.business,a.email,a.payment_reminder_exempt,e.date,l.name location,
    coalesce((select max(x.created_at) from market.audit x where x.detail->>'id'=b.id::text and x.action in ('paypal invoice sent','booking held')),b.hold_until-interval '24 hours') as held_at
  from market.bookings b
  join market.applications a on a.id=b.application_id
  join market.events e on e.id=b.event_id
  join market.locations l on l.id=e.location_id
  where b.status='held'`;
 for(const b of held){
  if(b.invoice_reference&&token){
   const ps=await paypalInvoiceStatus(token,b.invoice_reference);
   if(paidStatuses.has(ps)){
    await sql.begin(async tx=>{await tx`update market.bookings set status='paid',payment_reference=${b.invoice_reference},payment_method='PayPal',paid_at=coalesce(paid_at,now()),hold_until=null where id=${b.id} and status='held'`;await audit(tx,'system','paypal payment auto-synced',{id:b.id,invoice_id:b.invoice_reference,status:ps});});
    continue;
   }
  }
  // §45: vendors exempt from payment reminders (Pat's Potions — pays on
  // the 1st by arrangement) are skipped by the reminder AND the
  // auto-cancel alike; the PayPal paid-sync above still settles a paid
  // invoice. Everyone else's 24-hour rule is unchanged.
  if(b.payment_reminder_exempt)continue;
  const heldAt=new Date(b.held_at),remindAt=new Date(heldAt.getTime()+12*3600000),cancelAt=new Date(heldAt.getTime()+24*3600000),now=new Date();
  if(!Number.isFinite(heldAt.getTime())){await audit(sql,'system','payment hold date invalid',{id:b.id,held_at:String(b.held_at||'')});continue;}
  // Payment is due within 24 hours of the invoice/hold starting. Keep the stored deadline aligned with that rule.
  if(!b.hold_until||Math.abs(new Date(b.hold_until).getTime()-cancelAt.getTime())>60000)await sql`update market.bookings set hold_until=${cancelAt.toISOString()} where id=${b.id} and status='held'`;
  if(now>=remindAt&&now<cancelAt){
   const [sent]=await sql`select id from market.audit where action='payment reminder sent' and detail->>'id'=${b.id}::text limit 1`;
   if(!sent){
    const day=displayDate(b.date),deadline=cancelAt.toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}),body=`Hi ${b.name},\n\nPAYMENT REMINDER — your vendor space for ${day} has not been paid yet.\n\nYour reservation will automatically cancel if payment is not received by ${deadline}. Once cancelled, the space is released and may be booked by another vendor.\n\nMarket: ${b.location}\nSpace: ${b.space==='indoor'?'Indoor':'Outdoor'}\nAmount due: ${(Number(b.price)/100).toFixed(2)}\n\nIf you have already paid, no action is needed.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await sql.begin(async tx=>{await queue(tx,b.email,`Payment required — 12 hours remaining for ${day}`,body);await audit(tx,'system','payment reminder sent',{id:b.id,held_at:heldAt.toISOString(),remind_at:remindAt.toISOString(),cancel_at:cancelAt.toISOString()});});
   }
  }
  if(now>=cancelAt){
   const [current]=await sql`select status from market.bookings where id=${b.id}`;
   if(current?.status==='held'){
    const day=displayDate(b.date),body=`Hi ${b.name},\n\nYour Trinity Crafters Market reservation for ${day} has been automatically cancelled because payment was not received within 24 hours of the invoice being sent.\n\nThe space has now been released and may be booked by another vendor. If you would still like to attend this market, you will need to submit a new application, subject to current availability.\n\nMarket: ${b.location}\nSpace: ${b.space==='indoor'?'Indoor':'Outdoor'}\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await sql.begin(async tx=>{await tx`update market.bookings set status='cancelled',hold_until=null where id=${b.id} and status='held'`;await queue(tx,b.email,`Reservation cancelled — ${day}`,body);await audit(tx,'system','payment hold auto-cancelled',{id:b.id,held_at:heldAt.toISOString(),cancel_at:cancelAt.toISOString()});});await sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(708821)`;await scanWaitlist(tx,b.event_id,{space:b.space,actor:'system'});});
   }
  }
 }
}



async function applyMonthlyLateFees(){
 const sql=db();
 const rows=await sql`
  update market.vendor_invoices
  set late_fee=1000,late_fee_applied_at=now(),updated_at=now()
  where status<>'paid'
    and due_date is not null
    and (now() at time zone 'America/New_York')::date >= due_date + 3
    and late_fee_applied_at is null
  returning id,vendor_email,due_date`;
 for(const r of rows)await audit(sql,'system','monthly invoice late fee applied',{invoice_id:r.id,amount:1000,due_date:String(r.due_date)});
}

async function sendDayBeforeVendorReminders(){
 const sql=db();
 const regular=await sql`
  select b.id,e.date,e.start_time,e.end_time,l.name location,l.address,a.name,a.business,a.email,b.space
  from market.bookings b
  join market.applications a on a.id=b.application_id
  join market.events e on e.id=b.event_id
  join market.locations l on l.id=e.location_id
  where b.status in ('approved','held','paid')
    and e.date=((now() at time zone 'America/New_York')::date+1)`;
 const imported=await sql`
  select i.id,e.date,e.start_time,e.end_time,l.name location,l.address,i.name,i.business,i.email,i.space
  from market.imported_attendees i
  join market.events e on e.id=i.event_id
  join market.locations l on l.id=e.location_id
  where not coalesce(i.cancelled,false)
    and nullif(trim(i.email),'') is not null
    and e.date=((now() at time zone 'America/New_York')::date+1)`;
 for(const v of [...regular.map(x=>({...x,source:'booking'})),...imported.map(x=>({...x,source:'imported'}))]){
  const [sent]=await sql`select id from market.audit where action='day-before vendor reminder sent' and detail->>'id'=${v.id}::text and detail->>'source'=${v.source} limit 1`;
  if(sent)continue;
  const day=displayDate(v.date);
  const start=String(v.start_time||'10:00').slice(0,5);
  const body=`Hi ${v.name||'Vendor'},

This is your reminder that ${v.business||'you'} are scheduled to appear at Trinity Crafters Market tomorrow, ${day}.

Market: ${v.location}
Address: ${v.address||''}
Market hours: ${start}–${String(v.end_time||'15:00').slice(0,5)}
Space: ${String(v.space||'').toLowerCase().includes('out')?'Outdoor':'Indoor'}

Please sign in to your vendor account to review your booking and complete online check-in if you have not already done so.

We look forward to seeing you tomorrow!

Trinity Crafters Market
trinitycraftersmarket@gmail.com`;
  await sql.begin(async tx=>{await queue(tx,v.email,`Reminder: You're scheduled tomorrow — ${day}`,body);await audit(tx,'system','day-before vendor reminder sent',{id:v.id,source:v.source,date:String(v.date)});});
 }
}

const displayTime=v=>{
 const m=String(v||'').slice(0,5).match(/^(\d{1,2}):(\d{2})$/);
 if(!m)return '';
 let h=Number(m[1]);const suffix=h>=12?'PM':'AM';h=h%12||12;
 return h+':'+m[2]+' '+suffix;
};

async function sendDayBeforeShopperReminders(){
 const sql=db();
 // §35: the reminder stamp lives on the RSVP row (codified in
 // database/codify-live-schema.sql section 13); the runtime ALTER keeps
 // deploys that predate the column safe, the monthly-invoices pattern.
 await sql`alter table market.shopper_rsvps add column if not exists reminder_sent_at timestamptz`;
 const rows=await sql`
  select r.id,r.name,r.email,r.party_size,e.date,e.start_time,e.end_time,l.name location,l.address
  from market.shopper_rsvps r
  join market.events e on e.id=r.event_id
  join market.locations l on l.id=e.location_id
  where r.reminder_sent_at is null
    and e.date=((now() at time zone 'America/New_York')::date+1)`;
 for(const r of rows){
  const day=displayDate(r.date),start=displayTime(r.start_time)||'10:00 AM',end=displayTime(r.end_time)||'3:00 PM';
  const body=`Hi ${r.name||'there'},

We're looking forward to seeing you at Trinity Crafters Market tomorrow, ${day}!

Market: ${r.location}
Address: ${r.address||''}
Hours: ${start}–${end}
Party size: ${r.party_size}

Your free shopper RSVP helps us plan the day — thank you. Just reply to this email if your plans change.

See you there!
Trinity Crafters Market
trinitycraftersmarket@gmail.com`;
  // The stamp is the send-once guard: claim the row (only while the stamp
  // is still null), queue and stamp in one transaction — if anything
  // fails the whole thing rolls back and the next sweep retries, and an
  // hourly re-run or a racing sweep finds the stamp set and sends nothing.
  await sql.begin(async tx=>{
   const claimed=await tx`update market.shopper_rsvps set reminder_sent_at=now() where id=${r.id} and reminder_sent_at is null returning id`;
   if(!claimed.length)return;
   await queue(tx,r.email,'See you tomorrow at Trinity Crafters Market!',body);
   await audit(tx,'system','day-before shopper reminder sent',{id:r.id,event_date:String(r.date)});
  });
 }
}

async function sendPostMarketSurveys(){
 const sql=db(),site=(process.env.SITE_URL||'https://trinitylutzmarkets.com').replace(/\/$/,'');
 // Create survey invitations only for vendors actually marked as attended, on the morning after the market.
 const regular=await sql`
  select b.id booking_id,null::uuid imported_attendee_id,b.event_id,a.name vendor_name,a.business,a.email,e.date,l.name location
  from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id
  where b.checked_in=true and b.status in ('approved','paid') and e.date=((now() at time zone 'America/New_York')::date-1)
 `;
 const imported=await sql`
  select null::uuid booking_id,i.id imported_attendee_id,i.event_id,i.name vendor_name,coalesce(nullif(i.business,''),i.name) business,i.email,e.date,l.name location
  from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
  where i.attendance_state='checked_in' and not coalesce(i.cancelled,false) and e.date=((now() at time zone 'America/New_York')::date-1)
 `;
 for(const v of [...regular,...imported]){
  if(!String(v.email||'').trim())continue;
  const [s]=await sql`insert into market.vendor_surveys(event_id,booking_id,imported_attendee_id,vendor_name,business,email)
   values(${v.event_id},${v.booking_id},${v.imported_attendee_id},${v.vendor_name||'Vendor'},${v.business||''},${v.email})
   on conflict do nothing returning id,token`;
  if(!s)continue;
  const day=displayDate(v.date),link=site+'/#survey/'+s.token;
  const body=`Hi ${v.vendor_name||'Vendor'},

Thank you for vending with Trinity Crafters Market at our ${day} market. We appreciate you being part of our vendor community.

We'd love to know how your experience went. Your feedback helps us improve future markets for both vendors and shoppers, and the survey takes about one minute.

Take the survey:
${link}

Thank you again,
Trinity Crafters Market
trinitycraftersmarket@gmail.com`;
  await sql.begin(async tx=>{await queue(tx,v.email,'Thank you for joining us! Tell us how we did',body);await tx`update market.vendor_surveys set emailed_at=now() where id=${s.id}`;await audit(tx,'system','post-market survey sent',{survey_id:s.id,event_id:v.event_id,email:v.email});});
 }
}

async function dailySystemBackup(){
 const sql=db(),day=new Date().toISOString().slice(0,10);
 const [done]=await sql`select id from market.audit where action='automatic system backup created' and created_at::date=${day}::date limit 1`;
 if(done)return;
 const tables=['vendors','applications','bookings','imported_attendees','vendor_invoices','vendor_payments','events','locations','categories','bans','expenses','settings'];
 const payload={created_at:new Date().toISOString(),tables:{}};
 for(const t of tables)payload.tables[t]=await sql.unsafe('select * from market.'+t+' order by 1');
 const client=supa(),bucket='system-backups';
 try{await client.storage.createBucket(bucket,{public:false,fileSizeLimit:10485760});}catch{}
 const path=day+'/automatic-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',bytes=new TextEncoder().encode(JSON.stringify(payload));
 const {error}=await client.storage.from(bucket).upload(path,bytes,{contentType:'application/json',upsert:false});
 if(error){await audit(sql,'system','automatic system backup failed',{error:error.message});return;}
 await audit(sql,'system','automatic system backup created',{path,size:bytes.length});
}
async function handleWaitlistOffers(){
 const sql=db();
 await sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(708821)`;await sweepWaitlist(tx,'system');await scanAllFutureWaitlists(tx,'system');});
}
export default async()=>{
 if(!ready())return;
 await ensureInvoiceHoldLadder();
 await sweepInvoiceHoldLadder();
 await handleHeldPayments();
 await handleWaitlistOffers();
 await sendDayBeforeVendorReminders();
 await sendDayBeforeShopperReminders();
 await sendPostMarketSurveys();
 await applyMonthlyLateFees();
 await dailySystemBackup();
 await flushMail();
 const [last]=await db()`select value from market.settings where key='last_sync'`;
 if(process.env.GOOGLE_REFRESH_TOKEN&&(!last||Date.now()-new Date(last.value).getTime()>3600000)){
  try{await syncCalendar();}catch(e){await db()`insert into market.settings(key,value) values('sync_error',${e.message}) on conflict(key) do update set value=excluded.value`;}
 }
};
