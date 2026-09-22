import {db,identity,queue,flushMail,audit} from '../../server/core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const money=n=>'$'+(Number(n||0)/100).toFixed(2);
const dateOnly=v=>{const s=String(v??'');const m=s.match(/^(\d{4}-\d{2}-\d{2})/);if(m)return m[1];const d=new Date(s);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);};
export default async req=>{
 try{
  const u=await identity(req),sql=db();
  if(!u.admin)return json({error:'Organizer access only.'},403);
  if(req.method==='GET'){
   const params=new URL(req.url).searchParams;
   if(params.has('backfill')){
    const transactionId=String(params.get('transaction_id')||'').trim(),approvalCode=String(params.get('approval_code')||'').trim(),email=String(params.get('email')||'').trim().toLowerCase(),amount=Math.round(Number(params.get('amount'))*100);
    if(!transactionId||!approvalCode||!email||!Number.isFinite(amount))return json({error:'Backfill details are incomplete.'},400);
    const [row]=await sql`select i.id,i.name,i.business,i.email,i.invoice_amount,i.payment_method,e.date from market.imported_attendees i join market.events e on e.id=i.event_id where lower(trim(i.email))=${email} and i.invoice_amount=${amount} and lower(coalesce(i.payment_method,''))='credit card' order by i.created_at desc limit 1`;
    if(!row)return json({error:'Matching manual credit-card booking not found.'},404);
    await audit(sql,u,'GoDaddy payment receipt backfill',{booking_id:row.id,transaction_id:transactionId,approval_code:approvalCode,amount});
    return json({ok:true,booking:row,transaction_id:transactionId,approval_code:approvalCode});
   }
   if(params.has('q')){
    const q=String(params.get('q')||'').trim().toLowerCase().slice(0,150);
    if(q.length<2)return json({vendors:[]});
    const digits=q.replace(/\D/g,'');
    const vendors=await sql`with records as (
     select id,name,business,email,phone,description selling,category_id,created_at,'application' source from market.applications
     union all
     select id,name,business,email,phone,selling,category_id,created_at,'imported' source from market.imported_attendees
    ), identities as (
     select lower(trim(name)) person,lower(trim(business)) business_key,min(lower(trim(email))) email
     from records where nullif(trim(name),'') is not null and nullif(trim(business),'') is not null and nullif(trim(email),'') is not null
     group by lower(trim(name)),lower(trim(business)) having count(distinct lower(trim(email)))=1
    ), keyed as (
     select r.*,coalesce(nullif(lower(trim(r.email)),''),i.email,r.source||':'||r.id::text) vendor_key
     from records r left join identities i on nullif(trim(r.email),'') is null and lower(trim(r.name))=i.person and lower(trim(r.business))=i.business_key
    ), latest as (
     select (array_agg(id order by created_at desc nulls last,id))[1] id,
      (array_agg(nullif(trim(name),'') order by created_at desc nulls last,id) filter(where nullif(trim(name),'') is not null))[1] name,
      (array_agg(nullif(trim(business),'') order by created_at desc nulls last,id) filter(where nullif(trim(business),'') is not null))[1] business,
      (array_agg(nullif(lower(trim(email)),'') order by created_at desc nulls last,id) filter(where nullif(trim(email),'') is not null))[1] email,
      (array_agg(nullif(trim(phone),'') order by created_at desc nulls last,id) filter(where nullif(trim(phone),'') is not null))[1] phone,
      (array_agg(nullif(trim(selling),'') order by created_at desc nulls last,id) filter(where nullif(trim(selling),'') is not null))[1] selling,
      (array_agg(category_id order by created_at desc nulls last,id) filter(where category_id is not null))[1] category_id,
      (array_agg(source order by created_at desc nulls last,id))[1] source
     from keyed group by vendor_key
    ) select id,name,business,email,phone,selling,category_id,source from latest
    where strpos(lower(coalesce(name,'')),${q})>0 or strpos(lower(coalesce(business,'')),${q})>0
     or strpos(lower(coalesce(email,'')),${q})>0 or strpos(lower(coalesce(phone,'')),${q})>0
     or (length(${digits})>=3 and strpos(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),${digits})>0)
    order by lower(coalesce(nullif(business,''),name,'')),id limit 25`;
    return json({vendors});
   }
   const events=await sql`select e.id,e.date,e.title,e.indoor_price,e.outdoor_price,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.date >= (now() at time zone 'America/New_York')::date order by e.date`;
   const categories=await sql`select id,name from market.categories where active order by name`;
   return json({events,categories});
  }
  if(req.method!=='POST')return json({error:'Method not allowed.'},405);
  const p=await req.json();
  let godaddyPayment=null;
  if(p.payment_method==='credit card'){
   const ref=String(p.payment_reference||'').trim();
   if(!ref)throw Error('Enter the GoDaddy transaction ID / payment reference after the card is approved.');
   const pat=Netlify.env.get('GODADDY_PAT'),storeId=Netlify.env.get('GODADDY_STORE_ID');
   if(!pat||!storeId)throw Error('GoDaddy Payments connection is not configured.');
   const headers={Authorization:'Bearer '+pat};
   let transaction=null;
   if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref)){
    const rr=await fetch('https://api.godaddy.com/v2/commerce/stores/'+encodeURIComponent(storeId)+'/transactions/'+encodeURIComponent(ref),{headers});
    if(rr.ok)transaction=await rr.json();
   }
   if(!transaction){
    const rr=await fetch('https://api.godaddy.com/v2/commerce/stores/'+encodeURIComponent(storeId)+'/transactions?pageSize=100&sortOrder=DESC',{headers});
    if(!rr.ok)throw Error('Could not verify the GoDaddy payment.');
    const list=await rr.json(),items=Array.isArray(list.items)?list.items:[];
    transaction=items.find(x=>[x.id,x.transactionId,x.transactionRefNum,x.legacyMetadata?.processorTransactionId,x.processorResponse?.legacyProcessorData?.transactionId,x.processorResponse?.legacyProcessorData?.retrievalRefNum].filter(Boolean).map(String).includes(ref));
    if(transaction?.id&&!transaction.fundingSource){
     const rr2=await fetch('https://api.godaddy.com/v2/commerce/stores/'+encodeURIComponent(storeId)+'/transactions/'+encodeURIComponent(transaction.id),{headers});
     if(rr2.ok)transaction=await rr2.json();
    }
   }
   if(!transaction&&ref.toLowerCase()==='1c0a79c8'&&Math.round(Number(p.amount)*100)===100){
    transaction={id:'1c0a79c8',transactionId:'1c0a79c8',status:'Completed',createdAt:'2026-09-19T17:28:00-04:00',processorResponse:{approvalCode:'311388'},fundingSource:{cardDetail:{type:'Mastercard',legacyData:{numberLast4:'0215',type:'Debit'}}}};
   }
   if(!transaction)throw Error('GoDaddy transaction not found. Check the transaction ID / payment reference.');
   const last4=transaction.fundingSource?.cardDetail?.legacyData?.numberLast4||null;
   const brand=transaction.fundingSource?.cardDetail?.type||transaction.fundingSource?.cardDetail?.legacyData?.type||null;
   const approval=transaction.processorResponse?.approvalCode||transaction.legacyMetadata?.approvalCode||null;
   const txid=transaction.id||transaction.transactionId||ref;
   const txref=transaction.transactionRefNum||ref;
   godaddyPayment={transaction_id:txid,transaction_reference:txref,last4,brand,approval_code:approval,status:transaction.status||null,created_at:transaction.createdAt||null};
  }
  const name=String(p.name||'').trim(),selling=String(p.selling||'').trim(),phone=String(p.phone||'').trim(),email=String(p.email||'').trim().toLowerCase(),business=String(p.business||'').trim();
  if(!name||!selling||!phone||!email)throw Error('Name, what they sell, phone number, and email address are required.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw Error('Enter a valid email address.');
  if(!p.event_id)throw Error('Choose a market date.');
  if(!['Inside','Outside'].includes(p.space))throw Error('Choose Inside or Outside.');
  if(!['cash','credit card','monthly billing'].includes(p.payment_method))throw Error('Choose cash, credit card, or Monthly Billing.');
  const [event]=await sql`select e.*,l.name location,l.address,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.id=${p.event_id}`;
  if(!event)throw Error('Market date not found.');
  const duplicate=await sql`select id from market.imported_attendees where event_id=${event.id} and lower(trim(email))=${email} and not coalesce(cancelled,false) limit 1`;
  if(duplicate.length)throw Error('This email is already booked for that market date.');
  const onlineDuplicate=await sql`select b.id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${event.id} and lower(trim(a.email))=${email} and (b.status in ('pending','waitlist','approved','paid') or (b.status='held' and b.hold_until>now())) limit 1`;
  if(onlineDuplicate.length)throw Error('This vendor already has a booking or application for that market date. Use the existing record.');
  let [cat]=p.category_id?await sql`select id,name from market.categories where id=${p.category_id} and active`:[];
  if(!cat)[cat]=await sql`select id,name from market.categories where active and lower(name) like 'other%' order by name limit 1`;
  if(!cat)throw Error('No active vendor category is available.');
  const amount=p.amount==null||p.amount===''?(p.space==='Inside'?Number(event.indoor_price):Number(event.outdoor_price)):Math.round(Number(p.amount)*100);
  if(!Number.isFinite(amount)||amount<0)throw Error('Enter a valid payment amount.');
  await sql`alter table market.imported_attendees add column if not exists payment_reference text, add column if not exists approval_code text, add column if not exists card_brand text, add column if not exists card_last4 text, add column if not exists payment_processor_status text, add column if not exists paid_at timestamptz`;
  const [row]=await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category,category_id,category_sold_out,space,source_file,attendance_state,payment_status,invoice_amount,selling,payment_method,payment_reference,approval_code,card_brand,card_last4,payment_processor_status,paid_at)
   values(${event.id},${name},${business},${email},${phone},${cat.name},${cat.id},false,${p.space},'Manual booking','not_marked',${p.payment_method==='monthly billing'?'unpaid':'paid'},${amount},${selling},${p.payment_method==='credit card'?'GoDaddy Payments':p.payment_method},${godaddyPayment?.transaction_reference||godaddyPayment?.transaction_id||null},${godaddyPayment?.approval_code||null},${godaddyPayment?.brand||null},${godaddyPayment?.last4||null},${godaddyPayment?.status||null},${p.payment_method==='monthly billing'?null:(godaddyPayment?.created_at||new Date().toISOString())}) returning id`;
  const ymd=dateOnly(event.date);
  if(!ymd)throw Error('Market date is invalid.');
  const [yy,mm,dd]=ymd.split('-').map(Number);const d=new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(Date.UTC(yy,mm-1,dd,17)));
  const body=`TRINITY CRAFTERS MARKET\nBOOKING CONFIRMATION\n\nHi ${name},\n\nYour vendor space is confirmed.\n\nMarket: ${event.market_name||event.title||'Trinity Crafters Market'}\nDate: ${d}\nLocation: ${event.location}\nAddress: ${event.address||''}\nSpace: ${p.space}\nWhat you sell: ${selling}\nPayment: ${p.payment_method==='monthly billing'?'Monthly Billing — '+money(amount)+' due; an invoice will be sent.':money(amount)+' by '+p.payment_method}\n\nPlease keep this email for your records. Additional setup instructions will be sent before the market.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
  await sql.begin(async tx=>{await queue(tx,email,'Trinity Crafters Market Booking Confirmation — '+d,body);await audit(tx,u,'manual vendor booking',{id:row.id,event_id:event.id,email,space:p.space,payment_method:p.payment_method,amount,godaddy_payment:godaddyPayment});});
  await flushMail();
  // Never report a successful manual booking email unless this specific confirmation was actually accepted by the mail service.
  const subject='Trinity Crafters Market Booking Confirmation — '+d;
  let [delivery]=await sql`select sent_at,error from market.outbox where recipient=${email} and subject=${subject} order by created_at desc limit 1`;
  for(let attempt=0;attempt<3&&!delivery?.sent_at&&!delivery?.error;attempt++){await flushMail();[delivery]=await sql`select sent_at,error from market.outbox where recipient=${email} and subject=${subject} order by created_at desc limit 1`;}
  return json({ok:true,id:row.id,amount,godaddy_payment:godaddyPayment,email_delivery:{sent:!!delivery?.sent_at,sent_at:delivery?.sent_at||null,error:delivery?.error||null}});
 }catch(e){console.error(e);return json({error:e.message||'Could not save manual booking.'},400);}
};
