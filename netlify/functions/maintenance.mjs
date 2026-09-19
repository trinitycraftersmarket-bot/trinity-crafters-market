import {ready,db,flushMail,queue,audit} from '../../server/core.mjs';
import {syncCalendar} from '../../server/sync.mjs';

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
 const s=String(v??'').trim();
 const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
 if(!m)return null;
 const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
 const x=new Date(y,mo-1,d,12,0,0);
 if(x.getFullYear()!==y||x.getMonth()!==mo-1||x.getDate()!==d)return null;
 return x;
};
const displayDate=v=>{
 const d=dateOnly(v);
 return d?d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}):'your scheduled market date';
};

async function handleHeldPayments(){
 const sql=db(),token=await paypalToken();
 const held=await sql`
  select b.id,b.invoice_reference,b.hold_until,b.price,b.space,a.name,a.business,a.email,e.date,l.name location,
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
  const heldAt=new Date(b.held_at),remindAt=new Date(heldAt.getTime()+12*3600000),cancelAt=new Date(heldAt.getTime()+30*3600000),now=new Date();
  if(!Number.isFinite(heldAt.getTime())){await audit(sql,'system','payment hold date invalid',{id:b.id,held_at:String(b.held_at||'')});continue;}
  // Keep inventory reserved for the full 30-hour payment window.
  if(!b.hold_until||new Date(b.hold_until).getTime()<cancelAt.getTime()-60000)await sql`update market.bookings set hold_until=${cancelAt.toISOString()} where id=${b.id} and status='held'`;
  if(now>=remindAt&&now<cancelAt){
   const [sent]=await sql`select id from market.audit where action='payment reminder sent' and detail->>'id'=${b.id}::text limit 1`;
   if(!sent){
    const day=displayDate(b.date),body=`Hi ${b.name},\n\nThis is a reminder that payment has not yet been received for your Trinity Crafters Market space on ${day}.\n\nYour space is being held for 30 hours from the time your invoice was sent. If payment is not received by the end of that 30-hour window, your reservation will automatically cancel, the space will be released for another vendor, and you will need to reapply if you still want to attend.\n\nMarket: ${b.location}\nSpace: ${b.space==='indoor'?'Indoor':'Outdoor'}\nAmount: $${(Number(b.price)/100).toFixed(2)}\n\nIf you have already paid, no action is needed.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await sql.begin(async tx=>{await queue(tx,b.email,`Payment reminder — ${day}`,body);await audit(tx,'system','payment reminder sent',{id:b.id,held_at:heldAt.toISOString(),cancel_at:cancelAt.toISOString()});});
   }
  }
  if(now>=cancelAt){
   const [current]=await sql`select status from market.bookings where id=${b.id}`;
   if(current?.status==='held'){
    const day=displayDate(b.date),body=`Hi ${b.name},\n\nYour Trinity Crafters Market reservation for ${day} has been automatically cancelled because payment was not received within 30 hours of the invoice being sent.\n\nThe space has now been released and may be booked by another vendor. If you would still like to attend this market, you will need to submit a new application, subject to current availability.\n\nMarket: ${b.location}\nSpace: ${b.space==='indoor'?'Indoor':'Outdoor'}\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await sql.begin(async tx=>{await tx`update market.bookings set status='cancelled',hold_until=null where id=${b.id} and status='held'`;await queue(tx,b.email,`Reservation cancelled — ${day}`,body);await audit(tx,'system','payment hold auto-cancelled',{id:b.id,held_at:heldAt.toISOString(),cancel_at:cancelAt.toISOString()});});
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

export default async()=>{
 if(!ready())return;
 await handleHeldPayments();
 await sendDayBeforeVendorReminders();
 await sendPostMarketSurveys();
 await applyMonthlyLateFees();
 await flushMail();
 const [last]=await db()`select value from market.settings where key='last_sync'`;
 if(process.env.GOOGLE_REFRESH_TOKEN&&(!last||Date.now()-new Date(last.value).getTime()>3600000)){
  try{await syncCalendar();}catch(e){await db()`insert into market.settings(key,value) values('sync_error',${e.message}) on conflict(key) do update set value=excluded.value`;}
 }
};
