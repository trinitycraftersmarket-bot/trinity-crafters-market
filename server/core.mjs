import postgres from 'postgres';
import {createClient} from '@supabase/supabase-js';
import {normalizePhone} from './rules.mjs';
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
 const manager=!admin&&(await db()`select email from market.staff where email=${u.email.toLowerCase()} and active`).length>0;
 return {id:u.id,email:u.email.toLowerCase(),admin,manager};
}
export async function banned(tx,u,phone){return (await tx`select id from market.bans where active and (user_id=${u.id} or email=${u.email} or phone=${normalizePhone(phone)})`).length>0;}
export async function expire(tx=db()){await tx`update market.bookings set status='expired' where status='held' and hold_until<=now()`;}
export async function audit(tx,u,action,detail){await tx`insert into market.audit(actor,action,detail) values(${u.email||u},${action},${tx.json(detail)})`;}
export async function queue(tx,to,subject,body){await tx`insert into market.outbox(recipient,subject,body) values(${to},${subject},${body})`;}
export async function flushMail(){
 if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return;
 await db().begin(async tx=>{const rows=await tx`select * from market.outbox where sent_at is null order by created_at limit 10 for update skip locked`;
 for(const r of rows){try{const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':r.id},body:JSON.stringify({from:process.env.MAIL_FROM,reply_to:"trinitycraftersmarket@gmail.com",to:[r.recipient],subject:r.subject,text:r.body}),signal:AbortSignal.timeout(8000)});if(!res.ok){const info=await res.json().catch(()=>({}));const detail=String(info.message||info.error||info.name||'').slice(0,300);throw Error('Email delivery failed: '+res.status+(detail?' — '+detail:''));}await tx`update market.outbox set sent_at=now(),error=null where id=${r.id}`;}catch(e){await tx`update market.outbox set error=${e.message} where id=${r.id}`;}}
 });
}
export async function publicData(){
 const sql=db();await expire(sql);
 // Live inventory uses the same active vendor records shown on the attendance list.
 // Normalize imported space labels because PDF/manual imports may contain casing or whitespace differences.
 const events=await sql`select e.*,l.name as location,l.address,l.market_name,((select count(*)::int from market.bookings b where b.event_id=e.id and lower(trim(b.space)) in ('indoor','inside') and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())))+(select count(*)::int from market.imported_attendees i where i.event_id=e.id and not coalesce(i.cancelled,false) and lower(trim(i.space)) in ('inside','indoor'))) as indoor_used,((select count(*)::int from market.bookings b where b.event_id=e.id and lower(trim(b.space)) in ('outdoor','outside') and (b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now())))+(select count(*)::int from market.imported_attendees i where i.event_id=e.id and not coalesce(i.cancelled,false) and lower(trim(i.space)) in ('outside','outdoor'))) as outdoor_used from market.events e join market.locations l on l.id=e.location_id where (e.date + coalesce(e.end_time,time '15:00')) > (now() at time zone 'America/New_York') order by e.date,e.start_time`;
 const categories=await sql`select * from market.categories where active order by name`;
 const locations=await sql`select id,name,address,market_name from market.locations order by name`;
 const counts=await sql`select x.event_id,x.category_id,count(*)::int as used,coalesce(o.vendor_limit,c.vendor_limit) as vendor_limit from (select b.event_id,a.category_id from market.bookings b join market.applications a on a.id=b.application_id where b.status in ('pending','approved','paid') or (b.status='held' and b.hold_until>now()) union all select r.event_id,r.category_id from market.imported_category_reservations r) x join market.categories c on c.id=x.category_id left join market.event_category_limits o on o.event_id=x.event_id and o.category_id=x.category_id group by x.event_id,x.category_id,o.vendor_limit,c.vendor_limit`;
 const offerings=await sql`select event_id,space,category from (
   select b.event_id,lower(trim(b.space)) space,case when lower(c.name) like 'other%' then null else c.name end category from market.bookings b join market.applications a on a.id=b.application_id join market.categories c on c.id=a.category_id where b.status in ('approved','paid') or (b.status='held' and b.hold_until>now())
   union all
   select i.event_id,lower(trim(i.space)) space,case when nullif(trim(i.selling),'') is not null then trim(i.selling) when lower(coalesce(i.category,'')) like 'other%' then null else nullif(trim(i.category),'') end category from market.imported_attendees i where not coalesce(i.cancelled,false)
 ) x where category is not null and lower(trim(space)) in ('indoor','inside','outdoor','outside') order by event_id,space,category`;
 const publicVendors=await sql`select event_id,business,description,category from (
   select b.event_id,nullif(trim(a.business),'') business,nullif(trim(a.description),'') description,nullif(trim(c.name),'') category
   from market.bookings b join market.applications a on a.id=b.application_id left join market.categories c on c.id=a.category_id
   where b.status in ('approved','paid') or (b.status='held' and b.hold_until>now())
   union all
   select i.event_id,nullif(trim(coalesce(i.business,i.name)),'') business,nullif(trim(i.selling),'') description,nullif(trim(i.category),'') category
   from market.imported_attendees i where not coalesce(i.cancelled,false)
 ) x where business is not null order by event_id,business`;
 return {events,categories,locations,counts,offerings,publicVendors};
}