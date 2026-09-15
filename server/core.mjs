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
 return {id:u.id,email:u.email.toLowerCase(),admin};
}
export async function banned(tx,u,phone){return (await tx`select id from market.bans where active and (user_id=${u.id} or email=${u.email} or phone=${normalizePhone(phone)})`).length>0;}
export async function expire(tx=db()){await tx`update market.bookings set status='expired' where status='held' and hold_until<=now()`;}
export async function audit(tx,u,action,detail){await tx`insert into market.audit(actor,action,detail) values(${u.email||u},${action},${tx.json(detail)})`;}
export async function queue(tx,to,subject,body){await tx`insert into market.outbox(recipient,subject,body) values(${to},${subject},${body})`;}
export async function flushMail(){
 if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return;
 await db().begin(async tx=>{const rows=await tx`select * from market.outbox where sent_at is null order by created_at limit 10 for update skip locked`;
 for(const r of rows){try{const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':r.id},body:JSON.stringify({from:process.env.MAIL_FROM,reply_to:"trinitycraftersmarket@gmail.com",to:[r.recipient],subject:r.subject,text:r.body}),signal:AbortSignal.timeout(8000)});if(!res.ok)throw Error('Email delivery failed: '+res.status);await tx`update market.outbox set sent_at=now(),error=null where id=${r.id}`;}catch(e){await tx`update market.outbox set error=${e.message} where id=${r.id}`;}}
 });
}
export async function publicData(){
 const sql=db();await expire(sql);
 const events=await sql`select e.*,l.name as location,l.address,(select count(*)::int from market.bookings b where b.event_id=e.id and b.space='indoor' and (b.status in ('approved','paid') or (b.status='held' and b.hold_until>now()))) as indoor_used,(select count(*)::int from market.bookings b where b.event_id=e.id and b.space='outdoor' and (b.status in ('approved','paid') or (b.status='held' and b.hold_until>now()))) as outdoor_used from market.events e join market.locations l on l.id=e.location_id where e.date >= (now() at time zone 'America/New_York')::date order by e.date`;
 const categories=await sql`select * from market.categories where active order by name`;
 const counts=await sql`select b.event_id,a.category_id,count(*)::int as used from market.bookings b join market.applications a on a.id=b.application_id where b.status in ('approved','paid') or (b.status='held' and b.hold_until>now()) group by b.event_id,a.category_id`;
 return {events,categories,counts};
}
