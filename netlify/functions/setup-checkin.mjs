import {db,identity,audit,queue,flushMail,ensureOutboxTracking} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const ARRIVALS=new Set(['08:15','08:30','08:45','09:00']);
const normalizedEmail=s=>String(s||'').trim().toLowerCase().replace(/[;,]+$/,'').trim();
const hamptonNote=loc=>/hampton/i.test(String(loc||''))?'\n\nFor Hampton Inn events: this market has just 9 indoor spots. Indoor spots are filled first from the vendors who completed online check-in. Outside vendors do not normally move indoors, but if an indoor spot is still open, it will go to a checked-in outside vendor, first come, first served. Outside spots are also first come, first served in check-in order.':'';

export default async req=>{
 try{
  const u=await identity(req),sql=db(),url=new URL(req.url);
  await sql`alter table market.bookings add column if not exists setup_tables smallint`;await sql`alter table market.imported_attendees add column if not exists setup_tables smallint`;
  if(req.method==='GET'){
   const admin=url.searchParams.get('admin')==='1';
   if(admin){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    const rows=await sql`select * from (
      select 'booking'::text source,b.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,a.name,a.business,a.email,b.space,b.status,to_char(b.setup_arrival_time,'HH24:MI') setup_arrival_time,b.setup_checkin_at,b.setup_tables,c.name products,
      (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
      (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
      from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id join market.categories c on c.id=a.category_id
      where (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and b.status in ('approved','held','paid')
      union all
      select 'imported'::text source,i.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,i.name,i.business,i.email,i.space,'paid'::text status,to_char(i.setup_arrival_time,'HH24:MI') setup_arrival_time,i.setup_checkin_at,i.setup_tables,coalesce(nullif(i.selling,''),nullif(i.category,''),'Local handmade goods') products,
      (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
      (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
      from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
      where (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and not i.cancelled and i.payment_status='paid'
    ) q order by date,business,name`;
    return json({rows});
   }
   const email=normalizedEmail(u.email);
   const rows=await sql`select * from (
    select 'booking'::text source,b.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,a.business,b.space,b.status,to_char(b.setup_arrival_time,'HH24:MI') setup_arrival_time,b.setup_checkin_at,b.setup_tables,
    (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
    (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
    from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id
    where a.user_id=${u.id} and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and b.status='paid'
    union all
    select 'imported'::text source,i.id record_id,e.id event_id,e.date,e.start_time,e.title,l.name location,l.market_name,i.business,i.space,'paid'::text status,to_char(i.setup_arrival_time,'HH24:MI') setup_arrival_time,i.setup_checkin_at,i.setup_tables,
    (((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') cutoff,
    (now()<(((e.date+coalesce(e.start_time,time '10:00')) at time zone 'America/New_York')-interval '24 hours')) checkin_open
    from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
    where lower(regexp_replace(trim(i.email),'[;,]+$','','g'))=${email} and (e.date + coalesce(e.end_time,time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') and not i.cancelled and i.payment_status='paid'
   ) q order by date`;
   return json({rows});
  }
  if(req.method==='POST'){
   const p=await req.json(),source=p.source==='imported'?'imported':'booking',recordId=p.record_id||p.booking_id;

   if(p.action==='remind'){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    if(!recordId)throw Error('Vendor record is required.');
    let row;
    if(source==='imported'){
     [row]=await sql`select i.id,i.name,i.business,i.email,i.space,to_char(i.setup_arrival_time,'HH24:MI') setup_arrival_time,e.date,e.start_time,e.title,l.name location,l.market_name
       from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id
       where i.id=${recordId} and not i.cancelled and i.payment_status='paid'`;
    }else{
     [row]=await sql`select b.id,a.name,a.business,a.email,b.space,to_char(b.setup_arrival_time,'HH24:MI') setup_arrival_time,e.date,e.start_time,e.title,l.name location,l.market_name
       from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id
       where b.id=${recordId} and b.status in ('approved','held','paid')`;
    }
    if(!row)return json({error:'Vendor booking not found.'},404);
    if(row.setup_arrival_time)throw Error('This vendor has already completed online check-in.');
    const [window]=await sql`select now()<(((${row.date}::date+coalesce(${row.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in is already closed for this market.');
    const recipient=normalizedEmail(row.email);
    if(!recipient)throw Error('This vendor does not have an email address.');
    const [dateInfo]=await sql`select to_char(${row.date}::date,'FMDay, FMMonth FMDD, YYYY') label`;
    const market=row.market_name||row.title||'Crafters Market',dateLabel=dateInfo?.label||String(row.date).slice(0,10);
    const subject=`Online Check-In Is Required — ${market} — ${dateLabel}`;
    const body=`Hi ${row.name||row.business||'Vendor'},\n\nThis is a reminder that online setup check-in is required for ${market} on ${dateLabel}.\n\nPlease choose your setup arrival time (8:15, 8:30, 8:45, or 9:00 AM) and tell us how many tables you are bringing (1 or 2). Online check-in closes automatically 24 hours before the market.\n\nComplete your check-in here:\nhttps://trinitylutzmarkets.com/#account\n\nAll booth spots are tentative. Booth assignments are finalized from the completed check-ins, and the main room will be filled first. If you do not complete online check-in, you risk losing your assigned spot — we will fill the main room from the vendors who have checked in, and vendors who have not checked in will be placed in whatever spaces remain. Final floor plan assignments will be sent Friday. No vendors are admitted after 9:00 AM — arrive after 9:00 AM and you will likely lose your spot, with absolutely no refund.${hamptonNote(row.location)}\n\nThank you!\nTrinity Crafters Market / Lutz Crafter's Market`;
    await sql.begin(async tx=>{await queue(tx,recipient,subject,body);await audit(tx,u,'vendor setup check-in reminder sent',{source,record_id:String(recordId),recipient,date:String(row.date).slice(0,10)});});
    await flushMail();
    let [delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;
    for(let attempt=0;attempt<3&&!delivery?.sent_at&&!delivery?.error;attempt++){await flushMail();[delivery]=await sql`select sent_at,error from market.outbox where recipient=${recipient} and subject=${subject} order by created_at desc limit 1`;}
    if(!delivery?.sent_at)throw Error(delivery?.error||'The reminder could not be delivered. Please try again.');
    return json({ok:true,recipient,sent_at:delivery.sent_at});
   }

   if(p.action==='remind-all'){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    if(!p.event_id)throw Error('Choose a market date.');
    const [event]=await sql`select e.id,e.date,e.start_time,e.title,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.id=${p.event_id}`;
    if(!event)return json({error:'Market date not found.'},404);
    const [window]=await sql`select now()<(((${event.date}::date+coalesce(${event.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in is already closed for this market.');
    const regular=await sql`select a.name,a.email from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${p.event_id} and b.status in ('approved','held','paid') and b.setup_checkin_at is null and nullif(trim(a.email),'') is not null`;
    const imported=await sql`select i.name,i.email from market.imported_attendees i where i.event_id=${p.event_id} and not i.cancelled and i.payment_status='paid' and i.setup_checkin_at is null and nullif(trim(i.email),'') is not null`;
    const seen=new Set(),rows=[...regular,...imported].filter(x=>{const k=normalizedEmail(x.email);if(!k||seen.has(k))return false;seen.add(k);return true;});
    const [dateInfo]=await sql`select to_char(${event.date}::date,'FMDay, FMMonth FMDD, YYYY') label`;
    const day=dateInfo?.label||String(event.date).slice(0,10),market=event.market_name||event.title||'Trinity Crafters Market';
    const subject='Online check-in required, final plan sent Friday';
    await sql.begin(async tx=>{for(const v of rows)await queue(tx,normalizedEmail(v.email),subject,`Hi ${v.name||'Vendor'},\n\nThis is a reminder that online check-in is required for ${day}.\n\nPlease sign in and choose your planned setup arrival time:\nhttps://trinitylutzmarkets.com/#account\n\nMarket: ${market}\nDate: ${day}\nLocation: ${event.location}\n\nAll booth spots are tentative. Booth assignments are finalized from the completed check-ins, and the main room will be filled first. If you do not complete online check-in, you risk losing your assigned spot — we will fill the main room from the vendors who have checked in, and vendors who have not checked in will be placed in whatever spaces remain. Final floor plan assignments will be sent Friday. No vendors are admitted after 9:00 AM — arrive after 9:00 AM and you will likely lose your spot, with absolutely no refund.${hamptonNote(event.location)}\n\nIf you have already completed online check-in since this reminder was prepared, no further action is needed.\n\nThank you,\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`);await audit(tx,u,'online check-in mass reminder',{event_id:String(p.event_id),count:rows.length});});
    await flushMail();
    return json({ok:true,count:rows.length});
   }
   if(p.action==='remind-tables'){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    if(!p.event_id)throw Error('Choose a market date.');
    const [event]=await sql`select e.id,e.date,e.title,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.id=${p.event_id}`;
    if(!event)return json({error:'Market date not found.'},404);
    const regular=await sql`select a.name,a.email from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${p.event_id} and b.status in ('approved','held','paid') and (b.setup_checkin_at is not null or b.setup_arrival_time is not null) and b.setup_tables is null and not coalesce(lower(b.space),'') like '%out%' and nullif(trim(a.email),'') is not null`;
    const imported=await sql`select i.name,i.email from market.imported_attendees i where i.event_id=${p.event_id} and not i.cancelled and i.payment_status='paid' and (i.setup_checkin_at is not null or i.setup_arrival_time is not null) and i.setup_tables is null and not coalesce(lower(i.space),'') like '%out%' and nullif(trim(i.email),'') is not null`;
    const seen=new Set(),rows=[...regular,...imported].filter(x=>{const k=normalizedEmail(x.email);if(!k||seen.has(k))return false;seen.add(k);return true;});
    const [dateInfo]=await sql`select to_char(${event.date}::date,'FMDay, FMMonth FMDD, YYYY') label`;
    const day=dateInfo?.label||String(event.date).slice(0,10),market=event.market_name||event.title||'Trinity Crafters Market';
    const subject='Quick update needed: how many tables are you bringing?';
    await sql.begin(async tx=>{for(const v of rows)await queue(tx,normalizedEmail(v.email),subject,`Hi ${v.name||'Vendor'},\n\nGood news \u2014 you are already checked in online for ${market} on ${day}. We just need one more detail: how many tables are you bringing, 1 or 2?\n\nIndoor spaces are 6x9 and that size is strictly enforced \u2014 your entire setup must fit within your 6x9 space, so please plan accordingly.\n\nSign in, open your booking for this market, and tap Update check-in to add it:\nhttps://trinitylutzmarkets.com/#account\n\nThank you,\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`);await audit(tx,u,'table count request to checked-in vendors',{event_id:String(p.event_id),count:rows.length});});
    await flushMail();
    return json({ok:true,count:rows.length});
   }

   if(p.action==='email-report'){
    if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
    if(!p.event_id)throw Error('Choose a market date first.');
    await ensureOutboxTracking(sql);
    const [ev]=await sql`select e.date,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.id=${p.event_id}`;
    if(!ev)throw Error('Market not found.');
    const roster=await sql`select business,name,email from (
      select a.business,a.name,a.email from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${p.event_id} and b.status in ('approved','held','paid')
      union all
      select i.business,i.name,i.email from market.imported_attendees i where i.event_id=${p.event_id} and not i.cancelled and i.payment_status='paid'
    ) q order by business,name`;
    const wanted=new Set(roster.map(r=>normalizedEmail(r.email)).filter(Boolean));
    const all=await sql`select recipient,subject,created_at,sent_at,error,opened_at,open_count,last_opened_at from market.outbox where sent_at is not null or error is not null order by created_at desc limit 5000`;
    const byEmail={};
    for(const row of all){const k=normalizedEmail(row.recipient);if(!wanted.has(k))continue;(byEmail[k] ||= []).push(row);}
    const seen=new Set(),vendors=[];
    for(const r of roster){const k=normalizedEmail(r.email);if(k&&seen.has(k))continue;if(k)seen.add(k);vendors.push({business:r.business,name:r.name,email:r.email,sends:byEmail[k]||[]});}
    await audit(sql,u,'email proof report viewed',{event_id:p.event_id});
    return json({ok:true,market:ev.market_name||'',location:ev.location||'',date:ev.date,vendors});
   }

   const arrival=String(p.arrival_time||'').slice(0,5);
   if(!recordId||!ARRIVALS.has(arrival))throw Error('Choose an available setup arrival time.');
   const tables=Number(p.tables);if(![1,2].includes(tables))throw Error('Choose how many tables you are bringing: 1 or 2.');
   if(source==='imported'){
    const email=normalizedEmail(u.email);
    const [row]=await sql`select i.id,i.name,i.business,i.email,i.space,i.payment_status,i.cancelled,e.date,e.start_time,e.title,l.name location,l.market_name from market.imported_attendees i join market.events e on e.id=i.event_id join market.locations l on l.id=e.location_id where i.id=${recordId} and lower(regexp_replace(trim(i.email),'[;,]+$','','g'))=${email}`;
    if(!row)return json({error:'Assigned market not found.'},404);
    if(row.cancelled||row.payment_status!=='paid')throw Error('Setup check-in is only available for an active paid assignment.');
    const [window]=await sql`select now()<(((${row.date}::date+coalesce(${row.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in closed 24 hours before this market.');
    await sql`update market.imported_attendees set setup_arrival_time=${arrival}::time,setup_tables=${tables},setup_checkin_at=now() where id=${row.id}`;
    await audit(sql,u,'vendor setup check-in',{source:'imported',record_id:row.id,arrival_time:arrival,tables});
    const label=({'08:15':'8:15 AM','08:30':'8:30 AM','08:45':'8:45 AM','09:00':'9:00 AM'})[arrival];
    await queue(sql,'trinitycraftersmarket@gmail.com','Vendor online check-in — '+(row.business||row.name),`Vendor: ${row.business||row.name}\nContact: ${row.name||''}\nEmail: ${row.email||u.email}\nMarket: ${row.market_name||row.title||'Crafters Market'}\nDate: ${row.date}\nLocation: ${row.location||''}\nSpace: ${row.space||''}\nSetup arrival: ${label}\nTables: ${tables}\nRecord: PDF imported vendor`);
   }else{
    const [booking]=await sql`select b.id,b.status,b.space,e.date,e.start_time,e.title,l.name location,l.market_name,a.user_id,a.name,a.business,a.email from market.bookings b join market.applications a on a.id=b.application_id join market.events e on e.id=b.event_id join market.locations l on l.id=e.location_id where b.id=${recordId}`;
    if(!booking||booking.user_id!==u.id)return json({error:'Booking not found.'},404);
    if(booking.status!=='paid')throw Error('Setup check-in is available after your booking is paid.');
    const [window]=await sql`select now()<(((${booking.date}::date+coalesce(${booking.start_time}::time,time '10:00')) at time zone 'America/New_York')-interval '24 hours') as open`;
    if(!window?.open)throw Error('Online setup check-in closed 24 hours before this market.');
    await sql`update market.bookings set setup_arrival_time=${arrival}::time,setup_tables=${tables},setup_checkin_at=now() where id=${booking.id}`;
    await audit(sql,u,'vendor setup check-in',{source:'booking',record_id:booking.id,arrival_time:arrival,tables});
    const label=({'08:15':'8:15 AM','08:30':'8:30 AM','08:45':'8:45 AM','09:00':'9:00 AM'})[arrival];
    await queue(sql,'trinitycraftersmarket@gmail.com','Vendor online check-in — '+(booking.business||booking.name),`Vendor: ${booking.business||booking.name}\nContact: ${booking.name||''}\nEmail: ${booking.email||u.email}\nMarket: ${booking.market_name||booking.title||'Crafters Market'}\nDate: ${booking.date}\nLocation: ${booking.location||''}\nSpace: ${booking.space||''}\nSetup arrival: ${label}\nTables: ${tables}\nRecord: Website booking`);
   }
   await flushMail();
   return json({ok:true,arrival_time:arrival});
  }
  return json({error:'Method not allowed.'},405);
 }catch(e){console.error(e);return json({error:e.message||'Could not process setup check-in.'},400);}
};
