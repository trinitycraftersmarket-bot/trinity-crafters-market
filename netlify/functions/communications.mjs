import {ready,db,identity,queue,flushMail,audit} from '../../server/core.mjs';
import {parseFlyerAttachment,resolveFlyerRecipients,sendFlyer,flyerHistory} from '../../server/flyer.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const cleanEmail=x=>String(x||'').trim().toLowerCase();
export async function recipients(sql,mode,eventId){
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
// The Vendor Communications send (exported as a testable seam, the
// vendor-credit idiom). §57: `attachment` is a parseFlyerAttachment
// result ({filename, content}) or null — §56's validation, the same
// outbox attachment shape flyer sends queue, no second send path.
// When present, every queued email carries the flyer and the audit
// entry names the file; when null the send is exactly what it was
// before §57. `flush` is injectable for tests; production flushMail.
export async function sendVendorEmail(sql,{actor,list,mode,eventId,subject,body,attachment=null,flush=flushMail}){
 subject=String(subject||'').trim();body=String(body||'').trim();
 if(!subject||subject.length>300)throw Error('Enter an email subject.');if(!body||body.length>10000)throw Error('Enter the email message.');if(!list.length)throw Error('There are no vendor email addresses in this selection.');
 const attachments=attachment?[{filename:attachment.filename,content:attachment.content}]:null;
 await sql.begin(async tx=>{
  for(const v of list)await queue(tx,v.email,subject,body.replaceAll('{{name}}',v.name).replaceAll('{{business}}',v.business),null,attachments);
  await tx`insert into market.vendor_communications(sender_email,recipient_mode,event_id,subject,body,recipient_count,recipients) values(${actor.email},${mode},${eventId},${subject},${body},${list.length},${tx.json(list)})`;
  await audit(tx,actor,'vendor mass email',{mode,event_id:eventId,count:list.length,subject,...(attachment?{attachment:attachment.filename}:{})});
 });
 await flush();
 return {count:list.length};
}
export default async req=>{
 try{
  if(!ready())return json({error:'Market database is not ready.'},503);
  const u=await identity(req);if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const sql=db(),url=new URL(req.url),action=url.searchParams.get('action')||'preview';
  if(action==='events')return json(await sql`select e.id,e.date,e.title,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id order by e.date desc`);
  if(action==='history')return json(await sql`select c.*,e.date event_date,l.name location from market.vendor_communications c left join market.events e on e.id=c.event_id left join market.locations l on l.id=e.location_id order by c.created_at desc limit 50`);
  // §56 Email a Flyer: same organizer gate, its own actions. The flyer
  // audience (server/flyer.mjs) adds the Regulars Only mode and the
  // silent-ban exclusion the plain recipients() above predates; the
  // send verifies every queued row and reports delivery per vendor.
  if(action==='flyer-history')return json(await flyerHistory(sql));
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(action==='flyer-preview'||action==='flyer-send'){
   const p=await req.json();
   if(action==='flyer-preview'){const list=await resolveFlyerRecipients(sql,p.mode,p.event_id||null);return json({count:list.length,recipients:list});}
   const attachment=parseFlyerAttachment(p.attachment);
   const sent=await sendFlyer(sql,{actor:u,mode:p.mode,eventId:p.event_id||null,subject:p.subject,body:p.body,attachment});
   return json({ok:true,...sent});
  }
  const p=await req.json(),mode=p.mode,eventId=p.event_id||null,list=await recipients(sql,mode,eventId);
  if(action==='preview')return json({count:list.length,recipients:list});
  if(action!=='send')return json({error:'Unknown action'},404);
  // §57: an optional flyer rides the familiar send. §56's
  // parseFlyerAttachment validates it BEFORE anything is queued, so a
  // bad file refuses the whole send with the flyer section's wording.
  const attachment=p.attachment?parseFlyerAttachment(p.attachment):null;
  const sent=await sendVendorEmail(sql,{actor:u,list,mode,eventId,subject:p.subject,body:p.body,attachment});
  return json({ok:true,...sent});
 }catch(e){console.error(e);return json({error:String(e.message||e)},400);}
};
