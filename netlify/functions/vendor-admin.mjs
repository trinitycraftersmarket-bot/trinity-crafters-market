import {db,identity,audit,queue,flushMail} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const fmtDate=d=>{const s=String(d||'').slice(0,10);const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(m){const y=Number(m[1]),mo=Number(m[2]),day=Number(m[3]);return new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(new Date(Date.UTC(y,mo-1,day,17)));}const x=new Date(d);return Number.isNaN(x.getTime())?s:new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'}).format(x);};
const fmtTime=t=>{const raw=String(t||'').trim();if(!raw)return '';const match=raw.match(/(?:T|^)(\d{1,2}):(\d{2})/);if(!match)return raw;const h=Number(match[1]),m=Number(match[2]);if(h>23||m>59)return raw;const ap=h>=12?'PM':'AM',hh=h%12||12;return hh+':'+String(m).padStart(2,'0')+' '+ap;};

async function normalVendor(sql,id){
 const [r]=await sql`select b.id booking_id,b.application_id,b.event_id,b.space,b.status,a.user_id,a.name,a.email,a.phone,a.billing_address,a.business,a.description,e.date,e.title,e.start_time,e.end_time,l.name location,l.address from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${id}`;
 return r;
}
async function importedVendor(sql,id){
 try{const [r]=await sql`select i.*,e.date,e.title,e.start_time,e.end_time,l.name location,l.address from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id where i.id=${id}`;return r||null;}catch{return null;}
}
export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req);if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const p=await req.json(),sql=db(),imported=p.imported===true;
  let v=imported?await importedVendor(sql,p.id):await normalVendor(sql,p.id);if(!v)throw Error('Vendor record not found.');
  if(p.action==='get'){
   let last=null;try{const [x]=await sql`select created_at from market.audit where action='vendor booking confirmation sent' and detail->>'id'=${String(p.id)} order by created_at desc limit 1`;last=x?.created_at||null;}catch{}
   return json({vendor:v,last_sent:last});
  }
  if(p.action==='update'){
   const data={name:clean(p.name,200),business:clean(p.business,200),email:clean(p.email,320).toLowerCase(),phone:clean(p.phone,50),billing_address:clean(p.billing_address,500),description:clean(p.description,3000)};
   if(!data.name||!data.business||!data.email)throw Error('Name, business name and email are required.');
   if(imported){
    // Legacy attendees may have a narrower schema. Update the common profile fields,
    // then progressively fall back so an older imported record remains editable.
    let saved=false;
    for(const mode of ['full','contact','basic']){
     try{
      if(mode==='full')await sql`update market.imported_attendees set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},description=${data.description} where id=${p.id}`;
      else if(mode==='contact')await sql`update market.imported_attendees set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone} where id=${p.id}`;
      else await sql`update market.imported_attendees set name=${data.name},business=${data.business} where id=${p.id}`;
      saved=true;break;
     }catch{}
    }
    if(!saved)throw Error('Could not update this legacy vendor record.');
    // Propagate the edit across every imported occurrence of the same vendor.
    // Match the pre-edit email/phone/business so changing any of those values still finds old dates.
    try{await sql`update market.imported_attendees set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},description=${data.description} where id<>${p.id} and (lower(coalesce(email,''))=lower(${v.email||''}) or (regexp_replace(coalesce(phone,''),'\\D','','g')<>'' and regexp_replace(phone,'\\D','','g')=regexp_replace(${v.phone||''},'\\D','','g')) or lower(coalesce(business,''))=lower(${v.business||''}))`;}catch{
      try{await sql`update market.imported_attendees set name=${data.name},business=${data.business} where id<>${p.id} and lower(coalesce(business,''))=lower(${v.business||''})`;}catch{}
    }
    // Also update regular application records for this vendor so future bookings inherit the edit.
    try{await sql`update market.applications set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},billing_address=${data.billing_address},description=${data.description} where lower(email)=lower(${v.email||data.email}) or (regexp_replace(phone,'\\D','','g')<>'' and regexp_replace(phone,'\\D','','g')=regexp_replace(${v.phone||data.phone},'\\D','','g')) or lower(business)=lower(${v.business||data.business})`;}catch{}
    await audit(sql,u,'legacy vendor updated site-wide',{id:p.id,business:data.business});
   }else{
    await sql.begin(async tx=>{
      // Applications are the current master vendor source. Propagate by user_id so every booking/view uses the same profile.
      await tx`update market.applications set name=${data.name},business=${data.business},email=${data.email},phone=${data.phone},billing_address=${data.billing_address},description=${data.description} where user_id=${v.user_id}`;
      await audit(tx,u,'master vendor updated',{id:p.id,user_id:v.user_id,business:data.business});
    });
   }
   return json({ok:true});
  }
  if(p.action==='confirm'){
   const all=p.all_dates===true;
   let rows=[v];
   if(all&&!imported)rows=await sql`select b.id booking_id,b.space,b.status,a.name,a.email,a.business,a.description,e.date,e.title,e.start_time,e.end_time,l.name location,l.address from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where a.user_id=${v.user_id} and b.status in ('approved','held','paid') and e.date>=current_date order by e.date`;
   rows=rows.filter(x=>['approved','held','paid'].includes(String(x.status||'approved')));if(!rows.length)throw Error('No confirmed upcoming dates found.');
   const recipient=clean(v.email||rows[0].email,320);if(!recipient)throw Error('This vendor does not have an email address.');
   const marketNames=[...new Set(rows.map(x=>x.title||'Trinity Crafters Market'))];const subject=(marketNames.length===1?marketNames[0]:'Market')+' – Booking Confirmation';
   const details=rows.map(x=>`${fmtDate(x.date)}
Market Hours: ${fmtTime(x.start_time)||'10:00 AM'} – ${fmtTime(x.end_time)||'2:00 PM'}
Vendor Type: ${String(x.space||'').toLowerCase().includes('out')?'Outside Vendor':'Inside Vendor'}
Products Approved: ${x.description||v.description||'As approved'}
Location: ${x.location||''}${x.address?' — '+x.address:''}`).join('\n\n');
   const body=`Hi ${v.name||rows[0].name},\n\nYour vendor space${rows.length>1?'s':''} for ${marketNames.join(' / ')} ${rows.length>1?'have':'has'} been confirmed!\n\n${details}\n\nWe look forward to having you at the market!\n\n${marketNames.join(' / ')}`;
   await sql.begin(async tx=>{await queue(tx,recipient,subject,body);await audit(tx,u,'vendor booking confirmation sent',{id:String(p.id),all_dates:all,dates:rows.map(x=>String(x.date).slice(0,10)),recipient});});
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