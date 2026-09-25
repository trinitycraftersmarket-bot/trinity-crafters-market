import {db,identity,audit,queue,flushMail} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const money=n=>'$'+(Number(n||0)/100).toFixed(2);
const dateOnly=v=>v instanceof Date?v.toISOString().slice(0,10):(String(v??'').match(/\d{4}-\d{2}-\d{2}/)?.[0]||'');
const fmtDate=v=>{const s=dateOnly(v),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s||'Market date';return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(Date.UTC(+m[1],+m[2]-1,+m[3],17)));};

async function sourceRecord(sql,id,imported){
 if(imported){
  const [r]=await sql`select i.id,i.vendor_id,i.event_id,i.name,coalesce(nullif(i.business,''),i.name) business,i.email,i.phone,i.category_id,coalesce(c.name,i.category) category,i.selling description,lower(trim(i.space)) space,i.payment_status,i.invoice_amount,i.paid_at,i.cancelled,to_char(e.date,'YYYY-MM-DD') event_date,e.title,l.name location,l.address,(i.payment_status='paid' or i.paid_at is not null) was_paid,coalesce(i.invoice_amount,0)::int paid_amount from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id left join market.categories c on c.id=i.category_id where i.id=${id}`;
  return r?{...r,imported:true}:null;
 }
 const [r]=await sql`select b.id,b.application_id,a.vendor_id,b.event_id,a.name,a.business,a.email,a.phone,a.category_id,c.name category,a.description,b.space,b.status,b.price,b.paid_at,b.payment_method,to_char(e.date,'YYYY-MM-DD') event_date,e.title,l.name location,l.address,(b.status='paid' or b.paid_at is not null or exists(select 1 from market.vendor_payments vp where vp.booking_id=b.id)) was_paid,coalesce((select sum(vp.amount)::int from market.vendor_payments vp where vp.booking_id=b.id),b.price,0)::int paid_amount from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${id}`;
 return r?{...r,imported:false}:null;
}

async function categoryAndSpaceCounts(sql,eventId,categoryId,space){
 const alt=space==='indoor'?'inside':'outside';
 const [r]=await sql`select (select count(*)::int from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${eventId} and a.category_id=${categoryId} and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())))+(select count(*)::int from market.imported_attendees i where i.event_id=${eventId} and i.category_id=${categoryId} and not coalesce(i.cancelled,false)) as category_used,(select count(*)::int from market.bookings b where b.event_id=${eventId} and lower(trim(b.space)) in (${alt},${space}) and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())))+(select count(*)::int from market.imported_attendees i where i.event_id=${eventId} and lower(trim(i.space)) in (${alt},${space}) and not coalesce(i.cancelled,false)) as space_used`;
 return r||{category_used:0,space_used:0};
}

async function eligibleEvents(sql,credit,u){
 const [cat]=await sql`select id,name,vendor_limit,active from market.categories where id=${credit.category_id}`;
 if(!cat?.active||Number(cat.vendor_limit)<=0)return [];
 const events=await sql`select e.*,l.name location,l.address,l.market_name,o.vendor_limit override_limit from market.events e join market.locations l on l.id=e.location_id left join market.event_category_limits o on o.event_id=e.id and o.category_id=${credit.category_id} where e.open and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and e.id<>${credit.source_event_id} order by e.date,e.start_time`;
 const out=[];
 for(const e of events){
  const dup=await sql`select 1 from (select b.id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${e.id} and lower(trim(a.email))=lower(${u.email}) and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())) union all select i.id from market.imported_attendees i where i.event_id=${e.id} and lower(trim(i.email))=lower(${u.email}) and not coalesce(i.cancelled,false)) q limit 1`;
  if(dup.length||e.sold_out)continue;
  const [baseCounts]=await sql`select (select count(*)::int from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${e.id} and a.category_id=${credit.category_id} and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())))+(select count(*)::int from market.imported_attendees i where i.event_id=${e.id} and i.category_id=${credit.category_id} and not coalesce(i.cancelled,false)) as category_used`;
  const limit=Number(e.override_limit??cat.vendor_limit);if(Number(baseCounts?.category_used||0)>=limit)continue;
  const spaces=[];
  for(const space of ['indoor','outdoor']){
   if(space==='indoor'&&e.indoor_open===false)continue;if(space==='outdoor'&&e.outdoor_open===false)continue;
   const counts=await categoryAndSpaceCounts(sql,e.id,credit.category_id,space),capacity=Number(e[space+'_capacity']||0),price=Number(e[space+'_price']||0);
   if(Number(counts.space_used)<capacity&&price>0&&price<=Number(credit.remaining_amount||0))spaces.push({space,price});
  }
  if(spaces.length)out.push({id:e.id,date:dateOnly(e.date),title:e.title,location:e.location,address:e.address,market_name:e.market_name,spaces});
 }
 return out;
}

async function adminSources(sql){
 const regular=await sql`select b.id,false imported,a.vendor_id,a.id application_id,a.name,a.business,a.email,a.phone,c.name category,b.status,b.space,to_char(e.date,'YYYY-MM-DD') event_date,coalesce((select sum(vp.amount)::int from market.vendor_payments vp where vp.booking_id=b.id),b.price,0)::int amount,vc.id credit_id,vc.status credit_status,vc.remaining_amount from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id join market.events e on e.id=b.event_id left join market.vendor_credits vc on vc.source_type='booking' and vc.source_id=b.id where b.status='paid' or b.paid_at is not null or exists(select 1 from market.vendor_payments vp where vp.booking_id=b.id)`;
 const imported=await sql`select i.id,true imported,i.vendor_id,null::uuid application_id,i.name,coalesce(nullif(i.business,''),i.name) business,i.email,i.phone,coalesce(c.name,i.category) category,case when i.cancelled then 'cancelled' else coalesce(i.payment_status,'paid') end status,i.space,to_char(e.date,'YYYY-MM-DD') event_date,coalesce(i.invoice_amount,0)::int amount,vc.id credit_id,vc.status credit_status,vc.remaining_amount from market.imported_attendees i join market.events e on e.id=i.event_id left join market.categories c on c.id=i.category_id left join market.vendor_credits vc on vc.source_type='imported' and vc.source_id=i.id where i.payment_status='paid' or i.paid_at is not null`;
 return [...regular,...imported].sort((a,b)=>String(b.event_date).localeCompare(String(a.event_date)));
}

export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req),p=await req.json(),sql=db(),action=clean(p.action,60);
  if(action==='admin-sources'){if(!u.admin)return json({error:'Organizer access only'},403);return json({sources:await adminSources(sql)});}
  if(action==='preview'){if(!u.admin)return json({error:'Organizer access only'},403);const v=await sourceRecord(sql,p.id,p.imported===true);if(!v)throw Error('Vendor booking not found.');return json({source:v});}
  if(action==='issue'){
   if(!u.admin)return json({error:'Organizer access only'},403);let created;
   await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(708821)`;
    const v=await sourceRecord(tx,p.id,p.imported===true);if(!v)throw Error('Vendor booking not found.');if(!v.was_paid)throw Error('A credit can only be issued from a paid booking.');if(!v.category_id)throw Error('Assign this vendor to a category before issuing a credit.');
    const [existing]=await tx`select * from market.vendor_credits where source_type=${v.imported?'imported':'booking'} and source_id=${v.id} for update`;if(existing){created=existing;return;}
    let amount=Number(v.paid_amount||0);if(amount<=0&&p.amount!=null)amount=Number(p.amount);if(!Number.isInteger(amount)||amount<=0)throw Error('No paid amount is recorded for this booking. Enter the amount actually paid.');
    const [c]=await tx`insert into market.vendor_credits(vendor_id,email,category_id,source_type,source_id,source_event_id,original_amount,remaining_amount,issued_by,note) values(${v.vendor_id||null},${String(v.email||'').trim().toLowerCase()},${v.category_id},${v.imported?'imported':'booking'},${v.id},${v.event_id},${amount},${amount},${u.email},${clean(p.note,1000)}) returning *`;
    if(v.imported){await tx`update market.imported_attendees set cancelled=true where id=${v.id}`;await tx`delete from market.imported_category_reservations where imported_attendee_id=${v.id}`;}else await tx`update market.bookings set status='cancelled',hold_until=null where id=${v.id}`;
    const link=(process.env.SITE_URL||'https://trinitylutzmarkets.com')+'/#account';
    const body='Hi '+(v.name||'Vendor')+',\n\nA '+money(amount)+' credit has been issued for your cancelled '+fmtDate(v.event_date)+' market booking.\n\nChoose a different available market date online under My Bookings:\n'+link+'\n\nWhen you apply the credit, the new booking will be automatically approved and marked paid, and your category will be reserved for that date. If the new space costs less than your credit, the unused balance will remain available.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com';
    await queue(tx,v.email,'Vendor credit available — '+money(amount),body);await audit(tx,u,'vendor credit issued',{credit_id:c.id,source_type:c.source_type,source_id:c.source_id,amount,source_event_id:c.source_event_id});created=c;
   });
   await flushMail();return json({ok:true,credit:created});
  }
  if(action==='mine'){
   const credits=await sql`select vc.*,c.name category,to_char(e.date,'YYYY-MM-DD') source_date from market.vendor_credits vc join market.categories c on c.id=vc.category_id join market.events e on e.id=vc.source_event_id where lower(vc.email)=lower(${u.email}) and vc.status<>'void' order by vc.issued_at desc`;
   const result=[];for(const c of credits)result.push({...c,eligible_events:c.status==='available'&&Number(c.remaining_amount)>0?await eligibleEvents(sql,c,u):[]});return json({credits:result});
  }
  if(action==='redeem'){
   if(!['indoor','outdoor'].includes(p.space))throw Error('Choose an available space.');let result;
   await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(708821)`;
    const [credit]=await tx`select * from market.vendor_credits where id=${p.credit_id} and lower(email)=lower(${u.email}) for update`;if(!credit||credit.status!=='available'||Number(credit.remaining_amount)<=0)throw Error('This credit is no longer available.');if(String(credit.source_event_id)===String(p.event_id))throw Error('Choose a different market date for this credit.');
    const [cat]=await tx`select id,name,vendor_limit,active from market.categories where id=${credit.category_id}`;if(!cat?.active||Number(cat.vendor_limit)<=0)throw Error('This category is not currently available.');
    const [e]=await tx`select e.*,l.name location,l.address,l.market_name,o.vendor_limit override_limit from market.events e join market.locations l on l.id=e.location_id left join market.event_category_limits o on o.event_id=e.id and o.category_id=${credit.category_id} where e.id=${p.event_id} and e.open and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') for update`;if(!e||e.sold_out)throw Error('That market date is no longer available.');
    const dup=await tx`select 1 from (select b.id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${e.id} and lower(trim(a.email))=lower(${u.email}) and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())) union all select i.id from market.imported_attendees i where i.event_id=${e.id} and lower(trim(i.email))=lower(${u.email}) and not coalesce(i.cancelled,false)) q limit 1`;if(dup.length)throw Error('You already have a booking or application for that market date.');
    const counts=await categoryAndSpaceCounts(tx,e.id,credit.category_id,p.space),limit=Number(e.override_limit??cat.vendor_limit);if(Number(counts.category_used)>=limit)throw Error('Your category just filled for that date. Choose another market date.');if(p.space==='indoor'&&e.indoor_open===false)throw Error('Indoor spaces are closed for that date.');if(p.space==='outdoor'&&e.outdoor_open===false)throw Error('Outdoor spaces are closed for that date.');if(Number(counts.space_used)>=Number(e[p.space+'_capacity']||0))throw Error('That space just sold out. Choose another option.');
    const price=Number(e[p.space+'_price']||0);if(price<=0)throw Error('That space does not have a valid price.');if(price>Number(credit.remaining_amount))throw Error('This credit does not fully cover that space. Choose a lower-priced space or contact the organizer.');
    const v=await sourceRecord(tx,credit.source_id,credit.source_type==='imported');if(!v)throw Error('The original vendor record could not be found.');
    const [row]=await tx`insert into market.imported_attendees(event_id,name,business,email,phone,category,category_id,category_sold_out,space,source_file,attendance_state,payment_status,invoice_amount,selling,payment_method,payment_reference,paid_at,vendor_id) values(${e.id},${v.name||v.business||'Vendor'},${v.business||v.name||'Vendor'},${u.email},${v.phone||''},${cat.name},${cat.id},false,${p.space},'Vendor credit','not_marked','paid',${price},${v.description||''},'Credit',${'CREDIT-'+String(credit.id).slice(0,8)},now(),${credit.vendor_id||v.vendor_id||null}) returning id`;
    await tx`insert into market.imported_category_reservations(imported_attendee_id,event_id,category_id,space) values(${row.id},${e.id},${cat.id},${p.space}) on conflict(imported_attendee_id,category_id) do nothing`;
    await tx`insert into market.vendor_credit_redemptions(credit_id,imported_attendee_id,event_id,amount) values(${credit.id},${row.id},${e.id},${price})`;
    const remaining=Number(credit.remaining_amount)-price;await tx`update market.vendor_credits set remaining_amount=${remaining},status=${remaining===0?'used':'available'},last_redeemed_at=now(),updated_at=now() where id=${credit.id}`;
    const body='Hi '+(v.name||'Vendor')+',\n\nYour vendor credit has been applied and your new market date is confirmed.\n\nMarket: '+(e.market_name||e.title||'Trinity Crafters Market')+'\nDate: '+fmtDate(e.date)+'\nLocation: '+e.location+'\n'+(e.address||'')+'\nSpace: '+(p.space==='indoor'?'Indoor':'Outdoor')+'\nAmount applied: '+money(price)+'\nPayment status: PAID\nCategory reserved: '+cat.name+'\nCredit remaining: '+money(remaining)+'\n\nYour booking is approved and paid. Your category is now reserved for this market date.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com';
    await queue(tx,u.email,'Credit applied — '+fmtDate(e.date),body);await audit(tx,u,'vendor credit redeemed',{credit_id:credit.id,imported_attendee_id:row.id,event_id:e.id,space:p.space,amount:price,remaining});result={ok:true,booking_id:row.id,remaining};
   });
   await flushMail();return json(result);
  }
  return json({error:'Unknown action'},400);
 }catch(e){console.error('Vendor credit failed',e);return json({error:e.message||'Could not process vendor credit.'},400);}
};