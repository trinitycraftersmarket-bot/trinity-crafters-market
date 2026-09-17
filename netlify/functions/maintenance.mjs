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
const displayDate=d=>new Date(String(d).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'});

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
    const day=displayDate(b.date),body=`Hi ${b.name},\n\nYour Trinity Crafters Market reservation for ${day} has been automatically cancelled because payment was not received within 30 hours of the invoice being sent.\n\nThe space has now been released and may be booked by another vendor. If you would still like to attend this market, you will need to submit a new application, subject to current availability.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
    await sql.begin(async tx=>{await tx`update market.bookings set status='cancelled',hold_until=null where id=${b.id} and status='held'`;await queue(tx,b.email,`Reservation cancelled — ${day}`,body);await audit(tx,'system','payment hold auto-cancelled',{id:b.id,held_at:heldAt.toISOString(),cancel_at:cancelAt.toISOString()});});
   }
  }
 }
}

export default async()=>{
 if(!ready())return;
 await handleHeldPayments();
 await flushMail();
 const [last]=await db()`select value from market.settings where key='last_sync'`;
 if(process.env.GOOGLE_REFRESH_TOKEN&&(!last||Date.now()-new Date(last.value).getTime()>3600000)){
  try{await syncCalendar();}catch(e){await db()`insert into market.settings(key,value) values('sync_error',${e.message}) on conflict(key) do update set value=excluded.value`;}
 }
};
