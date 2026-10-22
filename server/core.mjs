import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {normalizePhone} from './rules.mjs';
import {publicCounts,categoryCountRows} from './counts.mjs';
// User-facing validation failures are thrown as plain Errors all over the
// codebase (throw Error('This space is sold out.')). Anything else —
// TypeError/ReferenceError, database errors (postgres.js errors carry a
// `code` and a non-'Error' name), network failures — is a server fault.
// Handlers use this to answer 400 with the message for the former and a
// generic, fully-logged 500 for the latter, instead of masking real faults
// as bad requests (audit §7.4.3).
export const isUserError=e=>!!e&&e.name==='Error'&&typeof e.message==='string'&&e.message.length>0&&e.code===undefined;
export const ready=()=>!!(process.env.DATABASE_URL&&process.env.SUPABASE_URL&&process.env.SUPABASE_PUBLISHABLE_KEY&&process.env.SUPABASE_SECRET_KEY&&process.env.ADMIN_EMAIL);
let connection;
export const db=()=>connection ||= postgres(process.env.DATABASE_URL,{ssl:'require',max:2,prepare:false,idle_timeout:20});
export const supa=()=>createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
export async function identity(req){
 const token=req.headers.get('authorization')?.replace(/^Bearer /,'');
 if(!token) throw Error('Sign in to continue.');
 const {data,error}=await supa().auth.getUser(token);
 if(error||!data.user?.email_confirmed_at) throw Error('Please sign in with a verified email.');
 const u=data.user; const admin=u.email.toLowerCase()===process.env.ADMIN_EMAIL.toLowerCase();
 if(!admin){const bans=await db()`select id from market.bans where active and (user_id=${u.id} or email=${u.email.toLowerCase()} or phone in (select phone from market.applications where user_id=${u.id}))`;if(bans.length)throw Error('Your vendor access is restricted. Contact the market organizer.');}
 let manager=false,permissions=[];
 if(!admin){
  const [staff]=await db()`select permissions from market.staff where email=${u.email.toLowerCase()} and active`;
  manager=!!staff;
  permissions=manager&&Array.isArray(staff.permissions)?staff.permissions:[];
 }
 return {id:u.id,email:u.email.toLowerCase(),admin,manager,permissions};
}
export async function banned(tx,u,phone){return (await tx`select id from market.bans where active and (user_id=${u.id} or email=${u.email} or phone=${normalizePhone(phone)})`).length>0;}
export async function expire(tx=db()){await tx`update market.bookings set status='expired' where status='held' and hold_until<=now()`;}
export async function audit(tx,u,action,detail){await tx`insert into market.audit(actor,action,detail) values(${u.email||u},${action},${tx.json(detail)})`;}
export async function queue(tx,to,subject,body,htmlBody=null,attachments=null){
 const [row]=await tx`insert into market.outbox(recipient,subject,body,html_body,attachments) values(${to},${subject},${body},${htmlBody},${attachments?tx.json(attachments):null}) returning id`;
 return row;
}
export async function flushMail(){
 if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return {sent:0,failed:0};
 let sent=0,failed=0;
 for(let batch=0;batch<25;batch++){
  let processed=0;
  await db().begin(async tx=>{
   const rows=await tx`select * from market.outbox where sent_at is null and error is null order by created_at limit 10 for update skip locked`;
   processed=rows.length;
   for(const r of rows){
    try{
     const attachments=Array.isArray(r.attachments)?r.attachments.filter(a=>a&&a.filename&&a.content).map(a=>({filename:String(a.filename).slice(0,180),content:String(a.content)})):[];
     const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':r.id},body:JSON.stringify({from:process.env.MAIL_FROM,reply_to:"trinitycraftersmarket@gmail.com",to:[r.recipient],subject:r.subject,text:r.body,...(r.html_body?{html:r.html_body}:{}),...(attachments.length?{attachments}:{})}),signal:AbortSignal.timeout(10000)});
     if(!res.ok){const info=await res.json().catch(()=>({}));const detail=String(info.message||info.error||info.name||'').slice(0,300);throw Error('Email delivery failed: '+res.status+(detail?' — '+detail:''));}
     await tx`update market.outbox set sent_at=now(),error=null where id=${r.id}`;sent++;
    }catch(e){await tx`update market.outbox set error=${e.message} where id=${r.id}`;failed++;}
   }
  });
  if(processed<10)break;
 }
 return {sent,failed};
}
export async function publicData(){
 const sql=db();await expire(sql);
 // Live inventory uses the same active vendor records shown on the attendance list.
 // All used-space / used-category numbers come from server/counts.mjs — the
 // single counting function (owner semantics: pending does not reserve;
 // booking/imported twins deduplicated by vendor identity).
 const events=await sql`select e.*,l.name as location,l.address,l.market_name from market.events e join market.locations l on l.id=e.location_id where (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') order by e.date,e.start_time`;
 const categories=await sql`select * from market.categories where active order by name`;
 const locations=await sql`select id,name,address,market_name from market.locations order by name`;
 const categoryLimits=await sql`select event_id,category_id,vendor_limit from market.event_category_limits`;
 const inventory=await publicCounts(sql);
 for(const e of events){const s=inventory.spaces.get(String(e.id))||{indoor:0,outdoor:0};e.indoor_used=s.indoor;e.outdoor_used=s.outdoor;}
 // The old counts query joined every category (active or not); keep that
 // exact reach for the row shaping even though the payload list is active-only.
 const allCategories=await sql`select id,vendor_limit from market.categories`;
 const counts=categoryCountRows(inventory,allCategories,categoryLimits);
 const offerings=await sql`select event_id,space,category from (
   select b.event_id,lower(trim(b.space)) space,case when lower(c.name) like 'other%' then null else c.name end category from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id where b.status in ('approved','paid') or (b.status='held' and b.hold_until>now())
   union all
   select i.event_id,lower(trim(i.space)) space,case when nullif(trim(i.selling),'') is not null then trim(i.selling) when lower(coalesce(i.category,'')) like 'other%' then null else nullif(trim(i.category),'') end category from market.imported_attendees i where not coalesce(i.cancelled,false)
 ) x where category is not null and lower(trim(space)) in ('indoor','inside','outdoor','outside') order by event_id,space,category`;
 const publicVendors=await sql`select event_id,business,description,category from (
   select b.event_id,nullif(trim(a.business),'') business,nullif(trim(coalesce(b.approved_products,a.description)),'') description,null::text category
   from market.bookings b join market.applications a on a.id=b.application_id
   where b.status in ('approved','paid') or (b.status='held' and b.hold_until>now())
   union all
   select i.event_id,nullif(trim(coalesce(i.business,i.name)),'') business,nullif(trim(coalesce(i.approved_products,i.selling)),'') description,null::text category
   from market.imported_attendees i where not coalesce(i.cancelled,false)
 ) x where business is not null order by event_id,business`;
 publicVendors.splice(0,publicVendors.length,...[...new Map(publicVendors.map(v=>[String(v.event_id)+'|'+String(v.business||'').toLowerCase().replace(/[^a-z0-9]/g,''),v])).values()]);
 return {events,categories,categoryLimits,locations,counts,offerings,publicVendors};
}