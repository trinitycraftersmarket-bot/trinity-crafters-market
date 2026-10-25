import {db,identity,audit,queue,flushMail,isUserError} from '../../server/core.mjs';
import {eventInventory,categoryUsed,vendorIdentityKey} from '../../server/counts.mjs';
import {ensureProfileSchema} from '../../server/profiles.mjs';
import {isRegularVendor,regularAwarePrice} from '../../server/pricing.mjs';
import {syncCancellation} from '../../server/twins.mjs';
import {scanWaitlist} from '../../server/waitlist.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const money=n=>'$'+(Number(n||0)/100).toFixed(2);
const dateOnly=v=>v instanceof Date?v.toISOString().slice(0,10):(String(v??'').match(/\d{4}-\d{2}-\d{2}/)?.[0]||'');
const fmtDate=v=>{const s=dateOnly(v),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s||'Market date';return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(Date.UTC(+m[1],+m[2]-1,+m[3],17)));};

// Category-cap semantics, mirrored from server/counts.mjs and the owner's
// ruling on the Holly case (Oct 22): the effective limit for an event is
// the per-event override when a row exists, else the category default
// (event_category_limits ?? categories.vendor_limit — codify-live-schema
// §4), and a limit of 0 means NO per-category cap: several live categories
// sit at 0 with vendors actively booked into them, so 0 must never read as
// "category closed". Enforcement applies only when the cap is > 0.
const categoryCap=(override,fallback)=>{const n=Number(override??fallback);return Number.isFinite(n)&&n>0?n:0;};

export async function sourceRecord(sql,id,imported){
 if(imported){
  const [r]=await sql`select i.id,i.vendor_id,i.event_id,i.name,coalesce(nullif(i.business,''),i.name) business,i.email,i.phone,i.category_id,coalesce(c.name,i.category) category,i.selling description,lower(trim(i.space)) space,i.payment_status,i.invoice_amount,i.paid_at,i.cancelled,to_char(e.date,'YYYY-MM-DD') event_date,e.title,l.name location,l.address,(i.payment_status='paid' or i.paid_at is not null) was_paid,coalesce(i.invoice_amount,0)::int paid_amount from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id left join market.categories c on c.id=i.category_id where i.id=${id}`;
  return r?{...r,imported:true}:null;
 }
 const [r]=await sql`select b.id,b.application_id,a.vendor_id,b.event_id,a.name,a.business,a.email,a.phone,a.category_id,c.name category,a.description,b.space,b.status,b.price,b.paid_at,b.payment_method,to_char(e.date,'YYYY-MM-DD') event_date,e.title,l.name location,l.address,(b.status='paid' or b.paid_at is not null or exists(select 1 from market.vendor_payments vp where vp.booking_id=b.id)) was_paid,coalesce((select sum(vp.amount)::int from market.vendor_payments vp where vp.booking_id=b.id),b.price,0)::int paid_amount from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${id}`;
 return r?{...r,imported:false}:null;
}

async function categoryAndSpaceCounts(sql,eventId,categoryId,space){
 // Delegates to the single counting function (server/counts.mjs): owner
 // semantics (pending does not reserve) + booking/imported twin dedupe.
 const inv=await eventInventory(sql,eventId);
 return {category_used:inv.categories.get(String(categoryId))||0,space_used:inv[space]||0};
}

export async function eligibleEvents(sql,credit,u){
 const [cat]=await sql`select id,name,vendor_limit,active from market.categories where id=${credit.category_id}`;
 if(!cat?.active)return [];
 const events=await sql`select e.*,l.name location,l.address,l.market_name,o.vendor_limit override_limit from market.events e join market.locations l on l.id=e.location_id left join market.event_category_limits o on o.event_id=e.id and o.category_id=${credit.category_id} where e.open and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and e.id<>${credit.source_event_id} order by e.date,e.start_time`;
 // §50: a regular-flagged vendor's redemption prices at their rate —
 // eligibility and the amount burned both use it (redeemCredit too).
 const regular=await isRegularVendor(sql,{email:u.email});
 const out=[];
 for(const e of events){
  const dup=await sql`select 1 from (select b.id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${e.id} and lower(trim(a.email))=lower(${u.email}) and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())) union all select i.id from market.imported_attendees i where i.event_id=${e.id} and lower(trim(i.email))=lower(${u.email}) and not coalesce(i.cancelled,false)) q limit 1`;
  if(dup.length||e.sold_out)continue;
  const limit=categoryCap(e.override_limit,cat.vendor_limit);if(limit>0&&await categoryUsed(sql,e.id,credit.category_id)>=limit)continue;
  const spaces=[];
  for(const space of ['indoor','outdoor']){
   if(space==='indoor'&&e.indoor_open===false)continue;if(space==='outdoor'&&e.outdoor_open===false)continue;
   const counts=await categoryAndSpaceCounts(sql,e.id,credit.category_id,space),capacity=Number(e[space+'_capacity']||0),price=await regularAwarePrice(sql,{locationId:e.location_id,space,indoorPrice:e.indoor_price,outdoorPrice:e.outdoor_price,regular});
   if(Number(counts.space_used)<capacity&&price>0&&price<=Number(credit.remaining_amount||0))spaces.push({space,price});
  }
  if(spaces.length)out.push({id:e.id,date:dateOnly(e.date),title:e.title,location:e.location,address:e.address,market_name:e.market_name,spaces});
 }
 return out;
}

export async function adminSources(sql){
 const regular=await sql`select b.id,false imported,a.vendor_id,a.id application_id,a.name,a.business,a.email,a.phone,c.name category,b.status,b.space,to_char(e.date,'YYYY-MM-DD') event_date,coalesce((select sum(vp.amount)::int from market.vendor_payments vp where vp.booking_id=b.id),b.price,0)::int amount,vc.id credit_id,vc.status credit_status,vc.remaining_amount from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id left join market.vendor_credits vc on vc.source_type='booking' and vc.source_id=b.id where b.status='paid' or b.paid_at is not null or exists(select 1 from market.vendor_payments vp where vp.booking_id=b.id)`;
 const imported=await sql`select i.id,true imported,i.vendor_id,null::uuid application_id,i.name,coalesce(nullif(i.business,''),i.name) business,i.email,i.phone,coalesce(c.name,i.category) category,case when i.cancelled then 'cancelled' else coalesce(i.payment_status,'paid') end status,i.space,to_char(e.date,'YYYY-MM-DD') event_date,coalesce(i.invoice_amount,0)::int amount,vc.id credit_id,vc.status credit_status,vc.remaining_amount from market.imported_attendees i join market.events e on e.id=i.event_id left join market.categories c on c.id=i.category_id left join market.vendor_credits vc on vc.source_type='imported' and vc.source_id=i.id where i.payment_status='paid' or i.paid_at is not null`;
 return [...regular,...imported].sort((a,b)=>String(b.event_date).localeCompare(String(a.event_date)));
}

// Issue a cancellation credit from a paid booking/imported record and
// cancel/release its spot. Idempotent per source record: a second call
// returns the existing credit without re-emailing. A record that was paid
// and has ALREADY been cancelled (e.g. via Cancel Vendor) stays creditable
// — cancelling preserves paid_at/payment evidence (see sourceRecord's
// was_paid), and the re-cancel below is a no-op that still emails the
// vendor, audits, and rescans the waitlist.
export async function issueCredit(sql,{id,imported,amount:amountIn,note},u){
 let created;
 await sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(708821)`;
  const v=await sourceRecord(tx,id,imported);if(!v)throw Error('Vendor booking not found.');if(!v.was_paid)throw Error('A credit can only be issued from a paid booking.');if(!v.category_id)throw Error('Assign this vendor to a category before issuing a credit.');
  const [existing]=await tx`select * from market.vendor_credits where source_type=${v.imported?'imported':'booking'} and source_id=${v.id} for update`;if(existing){created=existing;return;}
  let amount=Number(v.paid_amount||0);if(amount<=0&&amountIn!=null)amount=Number(amountIn);if(!Number.isInteger(amount)||amount<=0)throw Error('No paid amount is recorded for this booking. Enter the amount actually paid.');
  const [c]=await tx`insert into market.vendor_credits(vendor_id,email,category_id,source_type,source_id,source_event_id,original_amount,remaining_amount,issued_by,note) values(${v.vendor_id||null},${String(v.email||'').trim().toLowerCase()},${v.category_id},${v.imported?'imported':'booking'},${v.id},${v.event_id},${amount},${amount},${u.email},${clean(note,1000)}) returning *`;
  if(v.imported){await tx`update market.imported_attendees set cancelled=true where id=${v.id}`;await tx`delete from market.imported_category_reservations where imported_attendee_id=${v.id}`;}else await tx`update market.bookings set status='cancelled',hold_until=null where id=${v.id}`;
  // Twin-sync invariant (server/twins.mjs): cancel the vendor's other
  // record for this event too, so the twin doesn't keep holding inventory.
  await syncCancellation(tx,{eventId:v.event_id,key:vendorIdentityKey({vendor_id:v.vendor_id,email:v.email,phone:v.phone,business:v.business,name:v.name,id:v.id}),exclude:{source:v.imported?'imported':'booking',id:v.id}});
  const link=(process.env.SITE_URL||'https://trinitylutzmarkets.com')+'/#account';
  const body='Hi '+(v.name||'Vendor')+',\n\nA '+money(amount)+' credit has been issued for your cancelled '+fmtDate(v.event_date)+' market booking.\n\nChoose a different available market date online under My Bookings:\n'+link+'\n\nWhen you apply the credit, the new booking will be automatically approved and marked paid, and your category will be reserved for that date. If the new space costs less than your credit, the unused balance will remain available.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com';
  await queue(tx,v.email,'Vendor credit available — '+money(amount),body);await audit(tx,u,'vendor credit issued',{credit_id:c.id,source_type:c.source_type,source_id:c.source_id,amount,source_event_id:c.source_event_id});created=c;await scanWaitlist(tx,v.event_id,{space:v.space,actor:u});
 });
 return created;
}

// Redeem a credit against a different, future market date — any market or
// location, and credits never expire (no issued_at/age check anywhere in
// this path; market.vendor_credits has no expiry column). The new booking
// is created as an imported attendee marked paid FROM the credit:
// payment_status 'paid', payment_method 'Credit', payment_reference
// 'CREDIT-<credit id prefix>', source_file 'Vendor credit'.
export async function redeemCredit(sql,{credit_id,event_id,space},u){
 let result;
 await sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(708821)`;
  const [credit]=await tx`select * from market.vendor_credits where id=${credit_id} and lower(email)=lower(${u.email}) for update`;if(!credit||credit.status!=='available'||Number(credit.remaining_amount)<=0)throw Error('This credit is no longer available.');if(String(credit.source_event_id)===String(event_id))throw Error('Choose a different market date for this credit.');
  const [cat]=await tx`select id,name,vendor_limit,active from market.categories where id=${credit.category_id}`;if(!cat?.active)throw Error('This category is not currently available.');
  const [e]=await tx`select e.*,l.name location,l.address,l.market_name,o.vendor_limit override_limit from market.events e join market.locations l on l.id=e.location_id left join market.event_category_limits o on o.event_id=e.id and o.category_id=${credit.category_id} where e.id=${event_id} and e.open and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') for update of e`;if(!e||e.sold_out)throw Error('That market date is no longer available.');
  const dup=await tx`select 1 from (select b.id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${e.id} and lower(trim(a.email))=lower(${u.email}) and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())) union all select i.id from market.imported_attendees i where i.event_id=${e.id} and lower(trim(i.email))=lower(${u.email}) and not coalesce(i.cancelled,false)) q limit 1`;if(dup.length)throw Error('You already have a booking or application for that market date.');
  const counts=await categoryAndSpaceCounts(tx,e.id,credit.category_id,space),limit=categoryCap(e.override_limit,cat.vendor_limit);if(limit>0&&Number(counts.category_used)>=limit)throw Error('Your category just filled for that date. Choose another market date.');if(space==='indoor'&&e.indoor_open===false)throw Error('Indoor spaces are closed for that date.');if(space==='outdoor'&&e.outdoor_open===false)throw Error('Outdoor spaces are closed for that date.');if(Number(counts.space_used)>=Number(e[space+'_capacity']||0))throw Error('That space just sold out. Choose another option.');
  const price=await regularAwarePrice(tx,{locationId:e.location_id,space,indoorPrice:e.indoor_price,outdoorPrice:e.outdoor_price,regular:await isRegularVendor(tx,{email:u.email})});if(price<=0)throw Error('That space does not have a valid price.');if(price>Number(credit.remaining_amount))throw Error('This credit does not fully cover that space. Choose a lower-priced space or contact the organizer.');
  const v=await sourceRecord(tx,credit.source_id,credit.source_type==='imported');if(!v)throw Error('The original vendor record could not be found.');
  const [row]=await tx`insert into market.imported_attendees(event_id,name,business,email,phone,category,category_id,category_sold_out,space,source_file,attendance_state,payment_status,invoice_amount,selling,payment_method,payment_reference,paid_at,vendor_id) values(${e.id},${v.name||v.business||'Vendor'},${v.business||v.name||'Vendor'},${u.email},${v.phone||''},${cat.name},${cat.id},false,${space},'Vendor credit','not_marked','paid',${price},${v.description||''},'Credit',${'CREDIT-'+String(credit.id).slice(0,8)},now(),${credit.vendor_id||v.vendor_id||null}) returning id`;
  await tx`insert into market.imported_category_reservations(imported_attendee_id,event_id,category_id,space) values(${row.id},${e.id},${cat.id},${space}) on conflict(imported_attendee_id,category_id) do nothing`;
  await tx`insert into market.vendor_credit_redemptions(credit_id,imported_attendee_id,event_id,amount) values(${credit.id},${row.id},${e.id},${price})`;
  const remaining=Number(credit.remaining_amount)-price;await tx`update market.vendor_credits set remaining_amount=${remaining},status=${remaining===0?'used':'available'},last_redeemed_at=now(),updated_at=now() where id=${credit.id}`;
  const body='Hi '+(v.name||'Vendor')+',\n\nYour vendor credit has been applied and your new market date is confirmed.\n\nMarket: '+(e.market_name||e.title||'Trinity Crafters Market')+'\nDate: '+fmtDate(e.date)+'\nLocation: '+e.location+'\n'+(e.address||'')+'\nSpace: '+(space==='indoor'?'Indoor':'Outdoor')+'\nAmount applied: '+money(price)+'\nPayment status: PAID\nCategory reserved: '+cat.name+'\nCredit remaining: '+money(remaining)+'\n\nYour booking is approved and paid. Your category is now reserved for this market date.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com';
  await queue(tx,u.email,'Credit applied — '+fmtDate(e.date),body);await audit(tx,u,'vendor credit redeemed',{credit_id:credit.id,imported_attendee_id:row.id,event_id:e.id,space:space,amount:price,remaining});result={ok:true,booking_id:row.id,remaining};
 });
 return result;
}

// Organizer application-review flag data: every available credit with a
// balance, keyed by vendor email in the client, with the source market
// date so the review card can say "Holds a $X credit from <date>".
export async function applicantCredits(sql){
 return sql`select vc.id,lower(vc.email) email,vc.remaining_amount,vc.original_amount,to_char(e.date,'YYYY-MM-DD') source_date from market.vendor_credits vc join market.events e on e.id=vc.source_event_id where vc.status='available' and vc.remaining_amount>0 order by vc.issued_at`;
}

// vendor_credit_redemptions originally recorded only automatic redeems
// (which create an imported attendee). The organizer path below settles an
// application BOOKING instead, so the table needs a booking_id and a
// nullable imported_attendee_id. Lazy DDL, same pattern as the other
// feature migrations; database/vendor-credits.sql carries the fresh shape.
async function ensureRedemptionBookingColumn(sql){
 await sql`alter table market.vendor_credit_redemptions add column if not exists booking_id uuid references market.bookings(id)`;
 await sql`alter table market.vendor_credit_redemptions alter column imported_attendee_id drop not null`;
}

// ORGANIZER OVERRIDE (owner, Oct 22): approve an application booking and
// settle it from the vendor's credit, even when category/space counts
// would block a normal approval or an automatic redeem — the organizer
// compared the application (photos etc.) and decided. Deliberately NO
// capacity/category/space checks here. The credit applies up to the
// booking's outstanding balance; a shortfall stays as the booking's
// normal amount due (status 'approved', not paid). Full settlement marks
// the booking paid-from-credit exactly like an automatic redeem does
// (payment_method 'Credit', payment_reference 'CREDIT-<id prefix>'), with
// the ledger row in vendor_payments and the redemption row recorded.
export async function redeemForApplication(sql,{booking_id,credit_id},u){
 if(!u?.admin)throw Error('Organizer access only');
 await ensureRedemptionBookingColumn(sql);
 let result;
 await sql.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(708821)`;
  const [b]=await tx`select b.*,a.email,a.name,a.business,c.name category,to_char(e.date,'YYYY-MM-DD') event_date,e.title,l.name location,l.address,l.market_name from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${booking_id} for update of b`;
  if(!b)throw Error('Booking not found.');
  if(!['pending','waitlist','approved','held'].includes(b.status))throw Error('This booking can no longer be approved.');
  let credit;
  if(credit_id){const [c]=await tx`select * from market.vendor_credits where id=${credit_id} for update`;credit=c;}
  else{const [c]=await tx`select * from market.vendor_credits where lower(email)=lower(${b.email}) and status='available' and remaining_amount>0 order by issued_at limit 1 for update`;credit=c;}
  if(!credit||credit.status!=='available'||Number(credit.remaining_amount)<=0)throw Error('That credit is no longer available.');
  if(String(credit.email||'').trim().toLowerCase()!==String(b.email||'').trim().toLowerCase())throw Error('That credit belongs to a different vendor.');
  const [paidRow]=await tx`select coalesce(sum(amount),0)::int paid from market.vendor_payments where booking_id=${b.id}`;
  const outstanding=Number(b.price||0)-Number(paidRow.paid||0);
  if(outstanding<=0)throw Error('This booking is already fully paid.');
  const applied=Math.min(Number(credit.remaining_amount),outstanding),due=outstanding-applied,reference='CREDIT-'+String(credit.id).slice(0,8);
  await tx`insert into market.vendor_payments(application_id,booking_id,amount,payment_method,paid_at,note,recorded_by) values(${b.application_id},${b.id},${applied},'Credit',now(),${'Vendor credit '+reference+' applied by organizer'},${u.email})`;
  await tx`insert into market.vendor_credit_redemptions(credit_id,booking_id,event_id,amount) values(${credit.id},${b.id},${b.event_id},${applied})`;
  const remaining=Number(credit.remaining_amount)-applied;
  await tx`update market.vendor_credits set remaining_amount=${remaining},status=${remaining===0?'used':'available'},last_redeemed_at=now(),updated_at=now() where id=${credit.id}`;
  if(due===0)await tx`update market.bookings set status='paid',paid_at=now(),payment_method='Credit',payment_reference=${reference},hold_until=null where id=${b.id}`;
  else await tx`update market.bookings set status='approved',hold_until=null where id=${b.id}`;
  const body='Hi '+(b.name||'Vendor')+',\n\nYour vendor credit has been applied and your market date is confirmed.\n\nMarket: '+(b.market_name||b.title||'Trinity Crafters Market')+'\nDate: '+fmtDate(b.event_date)+'\nLocation: '+b.location+'\n'+(b.address||'')+'\nSpace: '+(b.space==='indoor'?'Indoor':'Outdoor')+'\nAmount applied: '+money(applied)+'\nPayment status: '+(due===0?'PAID':'PARTIALLY PAID')+'\nCategory reserved: '+b.category+'\nCredit remaining: '+money(remaining)+(due===0?'\n\nYour booking is approved and paid. Your category is now reserved for that market date.':'\nRemaining balance due: '+money(due)+'. The organizer will invoice you for the remaining balance.\n\nYour booking is approved. Your category is now reserved for that market date.')+'\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com';
  await queue(tx,b.email,'Credit applied — '+fmtDate(b.event_date),body);
  await audit(tx,u,'vendor credit redeemed for application',{credit_id:credit.id,booking_id:b.id,event_id:b.event_id,amount:applied,remaining,amount_due:due,override:true});
  result={ok:true,booking_id:b.id,applied,remaining_credit:remaining,amount_due:due,status:due===0?'paid':'approved'};
 });
 return result;
}

// Organizer application-review conflict panel data (owner, Oct 22): for
// each application booking under review whose category is at/over its cap
// on that date, assemble the "who sells what" comparison — the applicant's
// own line plus one line per vendor who genuinely holds that category on
// that date. Holders come from server/counts.mjs eventInventory, i.e. the
// single counting rules: pending does not reserve, booking/imported twins
// count once, cancelled imports excluded. A cap of 0 means NO cap
// (categoryCap), so limit-0 categories never conflict. "Sells" text
// preference: application description (bookings) / imported selling field
// (imports), then the vendor profile description; empty when none exists
// (the client renders "products not listed" — text is never invented).
// The applicant's own record is excluded from the holder list by identity
// key, and a date whose cap is consumed only by the applicant themselves
// is not a conflict.
export async function applicationConflicts(sql){
 await ensureProfileSchema(sql);
 const apps=await sql`select b.id booking_id,b.event_id,a.vendor_id,a.email,a.phone,a.business,a.name,a.description,c.id category_id,c.name category,c.vendor_limit,o.vendor_limit override_limit,to_char(e.date,'YYYY-MM-DD') event_date from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id left join market.event_category_limits o on o.event_id=b.event_id and o.category_id=a.category_id where b.status in ('pending','waitlist','approved','held') order by e.date,a.business`;
 const cache=new Map(),out=[];
 for(const b of apps){
  const cap=categoryCap(b.override_limit,b.vendor_limit);if(cap<=0)continue;
  const key=String(b.event_id)+'|'+String(b.category_id);
  if(!cache.has(key)){
   const inv=await eventInventory(sql,b.event_id),vendors=[];
   for(const h of inv.vendors.filter(v=>String(v.category_id)===String(b.category_id))){
    if(h.source==='booking'){const [r]=await sql`select a.business,a.description,p.description profile_description from market.bookings bk join market.applications a on a.id=bk.application_id left join market.vendor_profiles p on p.email=lower(trim(a.email)) where bk.id=${h.id}`;if(r)vendors.push({key:h.key,business:r.business||'',sells:String(r.description||'').trim()||String(r.profile_description||'').trim()});}
    else{const [r]=await sql`select coalesce(nullif(i.business,''),i.name) business,i.selling,p.description profile_description from market.imported_attendees i left join market.vendor_profiles p on p.email=lower(trim(both ' ,' from i.email)) where i.id=${h.id}`;if(r)vendors.push({key:h.key,business:r.business||'',sells:String(r.selling||'').trim()||String(r.profile_description||'').trim()});}
   }
   cache.set(key,{used:inv.categories.get(String(b.category_id))||0,vendors});
  }
  const entry=cache.get(key);if(entry.used<cap)continue;
  const selfKey=vendorIdentityKey({vendor_id:b.vendor_id,email:b.email,phone:b.phone,business:b.business,name:b.name,id:b.booking_id});
  const others=entry.vendors.filter(v=>v.key!==selfKey).map(({business,sells})=>({business,sells}));
  if(!others.length)continue;
  out.push({booking_id:b.booking_id,event_id:b.event_id,event_date:b.event_date,category:b.category,limit:cap,used:entry.used,applicant:{business:b.business||b.name||'',sells:String(b.description||'').trim()},vendors:others});
 }
 return out;
}

export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req),p=await req.json(),sql=db(),action=clean(p.action,60);
  if(action==='admin-sources'){if(!u.admin)return json({error:'Organizer access only'},403);return json({sources:await adminSources(sql)});}
  if(action==='applicant-credits'){if(!u.admin)return json({error:'Organizer access only'},403);return json({credits:await applicantCredits(sql)});}
  if(action==='application-conflicts'){if(!u.admin)return json({error:'Organizer access only'},403);return json({conflicts:await applicationConflicts(sql)});}
  if(action==='redeem-for-application'){if(!u.admin)return json({error:'Organizer access only'},403);const result=await redeemForApplication(sql,{booking_id:p.booking_id,credit_id:p.credit_id},u);await flushMail();return json(result);}
  if(action==='preview'){if(!u.admin)return json({error:'Organizer access only'},403);const v=await sourceRecord(sql,p.id,p.imported===true);if(!v)throw Error('Vendor booking not found.');return json({source:v});}
  if(action==='issue'){
   if(!u.admin)return json({error:'Organizer access only'},403);
   const created=await issueCredit(sql,{id:p.id,imported:p.imported===true,amount:p.amount,note:p.note},u);
   await flushMail();return json({ok:true,credit:created});
  }
  if(action==='mine'){
   const credits=await sql`select vc.*,c.name category,to_char(e.date,'YYYY-MM-DD') source_date from market.vendor_credits vc join market.categories c on c.id=vc.category_id join market.events e on e.id=vc.source_event_id where lower(vc.email)=lower(${u.email}) and vc.status<>'void' order by vc.issued_at desc`;
   const result=[];for(const c of credits)result.push({...c,eligible_events:c.status==='available'&&Number(c.remaining_amount)>0?await eligibleEvents(sql,c,u):[]});return json({credits:result});
  }
  if(action==='redeem'){
   if(!['indoor','outdoor'].includes(p.space))throw Error('Choose an available space.');
   const result=await redeemCredit(sql,{credit_id:p.credit_id,event_id:p.event_id,space:p.space},u);
   await flushMail();return json(result);
  }
  return json({error:'Unknown action'},400);
 }catch(e){console.error('Vendor credit failed',e);if(isUserError(e))return json({error:e.message},400);return json({error:'Could not process vendor credit.'},500);}
};