import {db,identity,audit} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const ARRIVALS=new Set(['08:15','08:30','08:45','09:00']);
const normalizedEmail=s=>String(s||'').trim().toLowerCase().replace(/[;,]+$/,'').trim();

export default async req=>{
 try{
  const u=await identity(req),sql=db(),url=new URL(req.url);
  if(req.method==='GET'){
   const admin=url.searchParams.get('admin')==='1';
   if(admin){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    const rows=await sql`select * from (
      select 'booking'::text source,b.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,a.name,a.business,a.email,b.space,b.status,to_char(b.setup_arrival_time,'HH24:MI') setup_arrival_time,b.setup_checkin_at,
      (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
      (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
      from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id
      where e.date >= (now() at time zone 'America/New_York')::date and b.status in ('approved','held','paid')
      union all
      select 'imported'::text source,i.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,i.name,i.business,i.email,i.space,'paid'::text status,to_char(i.setup_arrival_time,'HH24:MI') setup_arrival_time,i.setup_checkin_at,
      (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
      (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
      from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
      where e.date >= (now() at time zone 'America/New_York')::date and not i.cancelled and i.payment_status='paid'
    ) q order by date,business,name`;
    return json({rows});
   }
   const email=normalizedEmail(u.email);
   const rows=await sql`select * from (
    select 'booking'::text source,b.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,a.business,b.space,b.status,to_char(b.setup_arrival_time,'HH24:MI') setup_arrival_time,b.setup_checkin_at,
    (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
    (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
    from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id
    where a.user_id=${u.id} and e.date >= (now() at time zone 'America/New_York')::date and b.status='paid'
    union all
    select 'imported'::text source,i.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,i.business,i.space,'paid'::text status,to_char(i.setup_arrival_time,'HH24:MI') setup_arrival_time,i.setup_checkin_at,
    (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
    (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
    from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
    where lower(regexp_replace(trim(i.email),'[;,]+$','','g'))=${email} and e.date >= (now() at time zone 'America/New_York')::date and not i.cancelled and i.payment_status='paid'
   ) q order by date`;
   return json({rows});
  }
  if(req.method==='POST'){
   const p=await req.json(),arrival=String(p.arrival_time||'').slice(0,5),source=p.source==='imported'?'imported':'booking',recordId=p.record_id||p.booking_id;
   if(!recordId||!ARRIVALS.has(arrival))throw Error('Choose an available setup arrival time.');
   if(source==='imported'){
    const email=normalizedEmail(u.email);
    const [row]=await sql`select i.id,i.payment_status,i.cancelled,e.date,e.start_time from market.imported_attendees i join market.events e on e.id=i.event_id where i.id=${recordId} and lower(regexp_replace(trim(i.email),'[;,]+$','','g'))=${email}`;
    if(!row)return json({error:'Assigned market not found.'},404);
    if(row.cancelled||row.payment_status!=='paid')throw Error('Setup check-in is only available for an active paid assignment.');
    const [window]=await sql`select now()<(((${row.date}::date+coalesce(${row.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in closed 24 hours before this market.');
    await sql`update market.imported_attendees set setup_arrival_time=${arrival}::time,setup_checkin_at=now() where id=${row.id}`;
    await audit(sql,u,'vendor setup check-in',{source:'imported',record_id:row.id,arrival_time:arrival});
   }else{
    const [booking]=await sql`select b.id,b.status,e.date,e.start_time,a.user_id from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id where b.id=${recordId}`;
    if(!booking||booking.user_id!==u.id)return json({error:'Booking not found.'},404);
    if(booking.status!=='paid')throw Error('Setup check-in is available after your booking is paid.');
    const [window]=await sql`select now()<(((${booking.date}::date+coalesce(${booking.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in closed 24 hours before this market.');
    await sql`update market.bookings set setup_arrival_time=${arrival}::time,setup_checkin_at=now() where id=${booking.id}`;
    await audit(sql,u,'vendor setup check-in',{source:'booking',record_id:booking.id,arrival_time:arrival});
   }
   return json({ok:true,arrival_time:arrival});
  }
  return json({error:'Method not allowed.'},405);
 }catch(e){console.error(e);return json({error:e.message||'Could not process setup check-in.'},400);}
};
