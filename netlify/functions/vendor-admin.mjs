import {db,identity,audit,queue,flushMail,supa} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const phoneNorm=v=>String(v??'').replace(/\\D/g,'').slice(-15);
const fmtDate=d=>{const s=String(d||'').slice(0,10);const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m){const y=Number(m[1]),mo=Number(m[2]),day=Number(m[3]);return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(Date.UTC(y,mo-1,day,17)));}const x=new Date(d);return Number.isNaN(x.getTime())?s:new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(x);};
const fmtTime=t=>{const raw=String(t||'').trim();if(!raw)return '';const match=raw.match(/(?:T|^)(\d{1,2}):(\d{2})/);if(!match)return raw;const h=Number(match[1]),m=Number(match[2]);if(h>23||m>59)return raw;const ap=h>=12?'PM':'AM',hh=h%12||12;return hh+':'+String(m).padStart(2,'0')+' '+ap;};
async function signChatAttachments(chats){
 const messages=(chats||[]).flatMap(s=>s.messages||[]),paths=[...new Set(messages.map(m=>m.attachment_path).filter(Boolean))];
 if(!paths.length)return chats;
 const {data}=await supa().storage.from('chat-attachments').createSignedUrls(paths,3600),map=new Map((data||[]).map(x=>[x.path,x.signedUrl||null]));
 for(const m of messages)if(m.attachment_path)m.attachment_url=map.get(m.attachment_path)||null;
 return chats;
}

async function normalVendor(sql,id){
 const [r]=await sql`select b.id booking_id,b.application_id,b.event_id,b.space,b.status,a.user_id,a.vendor_id,coalesce(nullif(v.name,''),a.name) name,coalesce(nullif(v.email,''),a.email) email,coalesce(nullif(v.phone,''),a.phone) phone,coalesce(v.billing_address,a.billing_address) billing_address,coalesce(nullif(v.business,''),a.business) business,coalesce(nullif(v.description,''),a.description) description,coalesce(v.category_id,a.category_id) category_id,to_char(e.date,'YYYY-MM-DD') event_date,e.title,e.start_time,e.end_time,l.name location,l.address from market.bookings b join market.applications a on a.id=b.application_id left join market.vendors v on v.id=a.vendor_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${id}`;
 return r;
}
async function importedVendor(sql,id){
 try{const [r]=await sql`select i.*,coalesce(nullif(v.name,''),i.name) name,coalesce(nullif(v.business,''),i.business) business,coalesce(nullif(v.email,''),i.email) email,coalesce(nullif(v.phone,''),i.phone) phone,coalesce(v.billing_address,'') billing_address,coalesce(nullif(v.description,''),i.selling,'') description,coalesce(v.category_id,i.category_id) category_id,to_char(e.date,'YYYY-MM-DD') event_date,e.title,e.start_time,e.end_time,l.name location,l.address from market.imported_attendees i left join market.vendors v on v.id=i.vendor_id join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id where i.id=${id}`;return r||null;}catch{return null;}
}
export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req);if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const p=await req.json(),sql=db(),imported=p.imported===true;
  let v=imported?await importedVendor(sql,p.id):await normalVendor(sql,p.id);if(!v)throw Error('Vendor record not found.');
  if(p.action==='get'){
   let last=null,missing_request=null;try{const [x]=await sql`select created_at from market.audit where action='vendor booking confirmation sent' and detail->>'id'=${String(p.id)} order by created_at desc limit 1`;last=x?.created_at||null;}catch{}
   try{const [x]=v.vendor_id?await sql`select created_at,detail from market.audit where action='vendor missing info requested' and detail->>'vendor_id'=${String(v.vendor_id)} order by created_at desc limit 1`:await sql`select created_at,detail from market.audit where action='vendor missing info requested' and detail->>'id'=${String(p.id)} order by created_at desc limit 1`;if(x)missing_request={sent_at:x.created_at,missing:x.detail?.missing||[]};}catch{}
   let chats=[];try{
    const email=clean(v.email,320).toLowerCase(),phone=phoneNorm(v.phone);
    if(v.vendor_id)chats=await sql`select s.id,s.status,s.visitor_name,s.visitor_email,s.visitor_phone,s.selling,s.started_at,s.last_message_at,s.closed_at,
      coalesce(json_agg(json_build_object('id',m.id,'sender',m.sender,'body',m.body,'attachment_path',m.attachment_path,'attachment_name',m.attachment_name,'attachment_type',m.attachment_type,'attachment_size',m.attachment_size,'created_at',m.created_at) order by m.created_at) filter (where m.id is not null),'[]'::json) messages
      from market.chat_sessions s left join market.chat_messages m on m.session_id=s.id
      where s.vendor_id=${v.vendor_id} or lower(s.visitor_email)=${email} or (${phone}<>'' and s.normalized_phone=${phone})
      group by s.id order by s.last_message_at desc`;
    else chats=await sql`select s.id,s.status,s.visitor_name,s.visitor_email,s.visitor_phone,s.selling,s.started_at,s.last_message_at,s.closed_at,
      coalesce(json_agg(json_build_object('id',m.id,'sender',m.sender,'body',m.body,'attachment_path',m.attachment_path,'attachment_name',m.attachment_name,'attachment_type',m.attachment_type,'attachment_size',m.attachment_size,'created_at',m.created_at) order by m.created_at) filter (where m.id is not null),'[]'::json) messages
      from market.chat_sessions s left join market.chat_messages m on m.session_id=s.id
      where lower(s.visitor_email)=${email} or (${phone}<>'' and s.normalized_phone=${phone})
      group by s.id order by s.last_message_at desc`;
   }catch{}
   chats=await signChatAttachments(chats);
   const categories=await sql`select id,name from market.categories where active order by name`;return json({vendor:v,last_sent:last,missing_request,categories,chats});
  }
  if(p.action==='update'){
   const data={name:clean(p.name,200),business:clean(p.business,200),email:clean(p.email,320).toLowerCase(),phone:clean(p.phone,50),billing_address:clean(p.billing_address,500),description:clean(p.description,3000),category_id:clean(p.category_id,80)||null};
   if(!data.name||!data.business||!data.email)throw Error('Name, business name and email are required.');
   if(!v.vendor_id)throw Error('This vendor is not linked to a master vendor account yet.');
   if(data.category_id){const [cat]=await sql`select id from market.categories where id=${data.category_id} and active`;if(!cat)throw Error('Choose a valid category.');}const [before]=await sql`select id,account_number,name,business,email,phone,billing_address,description,category_id from market.vendors where id=${v.vendor_id}`;
   await sql.begin(async tx=>{
    await tx`update market.vendors set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},billing_address=${data.billing_address},description=${data.description},category_id=${data.category_id},updated_at=now() where id=${v.vendor_id}`;
    await tx`update market.applications set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},billing_address=${data.billing_address},description=${data.description},category_id=coalesce(${data.category_id},category_id) where vendor_id=${v.vendor_id}`;
    await tx`update market.imported_attendees i set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},selling=${data.description},category_id=coalesce(${data.category_id},i.category_id),category=coalesce((select name from market.categories where id=${data.category_id}),i.category) where vendor_id=${v.vendor_id}`;
    await audit(tx,u,'master vendor updated',{id:p.id,vendor_id:v.vendor_id,business:data.business,before,after:data});
   });
   return json({ok:true,vendor_id:v.vendor_id});
  }
  if(p.action==='request-missing-info'){
   const recipient=clean(v.email,320);if(!recipient)throw Error('This vendor does not have an email address, so a request cannot be emailed.');
   const missing=[];if(!clean(v.phone,50))missing.push('phone number');if(!clean(v.billing_address,500)&&!imported)missing.push('billing address');
   if(!missing.length)throw Error('This vendor does not have any requestable contact information missing.');
   const subject='Vendor Contact Information Update';
   const body=`Hi ${v.name||v.business||'Vendor'},\n\nWe are updating our vendor records for Trinity Crafters Market / Lutz Crafter's Market and noticed that we are missing your ${missing.join(' and ')}.\n\nPlease reply to this email with the missing information so we can keep your vendor record current.\n\nThank you!\nTrinity Crafters Market / Lutz Crafter's Market`;
   await sql.begin(async tx=>{await queue(tx,recipient,subject,body);});await flushMail();
   let [delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;
   for(let attempt=0;attempt<3&&!delivery?.sent_at&&!delivery?.error;attempt++){await flushMail();[delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;}
   if(!delivery?.sent_at)throw Error(delivery?.error||'The request could not be delivered. Please try again.');
   await audit(sql,u,'vendor missing info requested',{id:String(p.id),vendor_id:v.vendor_id?String(v.vendor_id):null,recipient,missing});return json({ok:true,recipient,missing,sent_at:delivery.sent_at});
  }
  if(p.action==='confirm'){
   const all=p.all_dates===true;
   let rows=[v];
   if(all&&!imported)rows=await sql`select b.id booking_id,b.space,b.status,a.name,a.email,a.business,a.description,to_char(e.date,'YYYY-MM-DD') event_date,e.title,e.start_time,e.end_time,l.name location,l.address from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where a.user_id=${v.user_id} and b.status in ('approved','held','paid') and e.date>=current_date order by e.date`;
   rows=rows.filter(x=>['approved','held','paid'].includes(String(x.status||'approved')));if(!rows.length)throw Error('No confirmed upcoming dates found.');
   const recipient=clean(v.email||rows[0].email,320);if(!recipient)throw Error('This vendor does not have an email address.');
   const marketNames=[...new Set(rows.map(x=>x.title||'Trinity Crafters Market'))];const subject=(marketNames.length===1?marketNames[0]:'Market')+' – Booking Confirmation';
   const details=rows.map(x=>`${fmtDate(x.event_date||x.date)}
Market Hours: ${fmtTime(x.start_time)||'10:00 AM'} – ${fmtTime(x.end_time)||'2:00 PM'}
Vendor Type: ${String(x.space||'').toLowerCase().includes('out')?'Outside Vendor':'Inside Vendor'}
Products Approved: ${x.description||x.selling||v.description||v.selling||'As approved'}
Location: ${x.location||''}${x.address?' — '+x.address:''}`).join('\n\n');
   const body=`Hi ${v.name||rows[0].name},\n\nYour vendor space${rows.length>1?'s':''} for ${marketNames.join(' / ')} ${rows.length>1?'have':'has'} been confirmed!\n\n${details}\n\nWe look forward to having you at the market!\n\n${marketNames.join(' / ')}`;
   await sql.begin(async tx=>{await queue(tx,recipient,subject,body);await audit(tx,u,'vendor booking confirmation sent',{id:String(p.id),all_dates:all,dates:rows.map(x=>String(x.event_date||x.date).slice(0,10)),recipient});});
   await flushMail();
   // The shared mail flush can process older queued messages first. Retry a few times so this newly queued confirmation is actually attempted before reporting failure.
   let [delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;
   for(let attempt=0;attempt<3&&!delivery?.sent_at&&!delivery?.error;attempt++){await flushMail();[delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;}
   if(!delivery?.sent_at)throw Error(delivery?.error||'Confirmation email was queued but could not be delivered. Please try again.');
   return json({ok:true,count:rows.length,recipient,sent_at:delivery.sent_at});
  }
  return json({error:'Unknown action'},400);
 }catch(e){console.error('Vendor admin failed',e);return json({error:e.message||'Could not update vendor.'},400);}
};