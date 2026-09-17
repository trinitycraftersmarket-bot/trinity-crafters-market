import {ready,db,identity,queue,flushMail,audit} from '../../server/core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const cleanEmail=x=>String(x||'').trim().toLowerCase();
async function recipients(sql,mode,eventId){
 let rows=[];
 if(mode==='event'){
  if(!eventId)throw Error('Choose a market date.');
  rows=await sql`
   select a.name,a.business,a.email from market.bookings b join market.applications a on a.id=b.application_id
   where b.event_id=${eventId} and b.status in ('approved','held','paid')
   union all
   select i.name,coalesce(nullif(i.business,''),i.name) business,i.email from market.imported_attendees i
   where i.event_id=${eventId} and coalesce(i.cancelled,false)=false`;
 }else if(mode==='all'){
  rows=await sql`
   select a.name,a.business,a.email from market.applications a where nullif(trim(a.email),'') is not null
   union all
   select i.name,coalesce(nullif(i.business,''),i.name) business,i.email from market.imported_attendees i where nullif(trim(i.email),'') is not null`;
 }else throw Error('Choose Market Date or All Vendors.');
 const seen=new Set(),out=[];
 for(const r of rows){const email=cleanEmail(r.email);if(!email||seen.has(email))continue;seen.add(email);out.push({name:r.name||'Vendor',business:r.business||r.name||'Vendor',email});}
 return out.sort((a,b)=>a.business.localeCompare(b.business));
}
export default async req=>{
 try{
  if(!ready())return json({error:'Market database is not ready.'},503);
  const u=await identity(req);if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const sql=db(),url=new URL(req.url),action=url.searchParams.get('action')||'preview';
  if(action==='events')return json(await sql`select e.id,e.date,e.title,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id order by e.date desc`);
  if(action==='history')return json(await sql`select c.*,e.date event_date,l.name location from market.vendor_communications c left join market.events e on e.id=c.event_id left join market.locations l on l.id=e.location_id order by c.created_at desc limit 50`);
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const p=await req.json(),mode=p.mode,eventId=p.event_id||null,list=await recipients(sql,mode,eventId);
  if(action==='preview')return json({count:list.length,recipients:list});
  if(action!=='send')return json({error:'Unknown action'},404);
  const subject=String(p.subject||'').trim(),body=String(p.body||'').trim();
  if(!subject||subject.length>300)throw Error('Enter an email subject.');if(!body||body.length>10000)throw Error('Enter the email message.');if(!list.length)throw Error('There are no vendor email addresses in this selection.');
  await sql.begin(async tx=>{
   for(const v of list)await queue(tx,v.email,subject,body.replaceAll('{{name}}',v.name).replaceAll('{{business}}',v.business));
   await tx`insert into market.vendor_communications(sender_email,recipient_mode,event_id,subject,body,recipient_count,recipients) values(${u.email},${mode},${eventId},${subject},${body},${list.length},${tx.json(list)})`;
   await audit(tx,u,'vendor mass email',{mode,event_id:eventId,count:list.length,subject});
  });
  await flushMail();
  return json({ok:true,count:list.length});
 }catch(e){console.error(e);return json({error:String(e.message||e)},400);}
};
