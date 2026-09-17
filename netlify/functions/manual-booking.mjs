import {db,identity,queue,flushMail,audit} from '../../server/core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const money=n=>'$'+(Number(n||0)/100).toFixed(2);
export default async req=>{
 try{
  const u=await identity(req),sql=db();
  if(!u.admin)return json({error:'Organizer access only.'},403);
  if(req.method==='GET'){
   const events=await sql`select e.id,e.date,e.title,e.indoor_price,e.outdoor_price,l.name location,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.date >= (now() at time zone 'America/New_York')::date order by e.date`;
   const categories=await sql`select id,name from market.categories where active order by name`;
   return json({events,categories});
  }
  if(req.method!=='POST')return json({error:'Method not allowed.'},405);
  const p=await req.json();
  const name=String(p.name||'').trim(),selling=String(p.selling||'').trim(),phone=String(p.phone||'').trim(),email=String(p.email||'').trim().toLowerCase(),business=String(p.business||'').trim();
  if(!name||!selling||!phone||!email)throw Error('Name, what they sell, phone number, and email address are required.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw Error('Enter a valid email address.');
  if(!p.event_id)throw Error('Choose a market date.');
  if(!['Inside','Outside'].includes(p.space))throw Error('Choose Inside or Outside.');
  if(!['cash','credit card'].includes(p.payment_method))throw Error('Choose cash or credit card.');
  const [event]=await sql`select e.*,l.name location,l.address,l.market_name from market.events e join market.locations l on l.id=e.location_id where e.id=${p.event_id}`;
  if(!event)throw Error('Market date not found.');
  const duplicate=await sql`select id from market.imported_attendees where event_id=${event.id} and lower(trim(email))=${email} and not coalesce(cancelled,false) limit 1`;
  if(duplicate.length)throw Error('This email is already booked for that market date.');
  let [cat]=p.category_id?await sql`select id,name from market.categories where id=${p.category_id} and active`:[];
  if(!cat)[cat]=await sql`select id,name from market.categories where active and lower(name) like 'other%' order by name limit 1`;
  if(!cat)throw Error('No active vendor category is available.');
  const amount=p.amount==null||p.amount===''?(p.space==='Inside'?Number(event.indoor_price):Number(event.outdoor_price)):Math.round(Number(p.amount)*100);
  if(!Number.isFinite(amount)||amount<0)throw Error('Enter a valid payment amount.');
  const [row]=await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category,category_id,category_sold_out,space,source_file,attendance_state,payment_status,invoice_amount,selling)
   values(${event.id},${name},${business},${email},${phone},${cat.name},${cat.id},false,${p.space},'Manual booking','not_marked','paid',${amount},${selling}) returning id`;
  const d=new Date(String(event.date)+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const body=`TRINITY CRAFTERS MARKET\nBOOKING CONFIRMATION\n\nHi ${name},\n\nYour vendor space is confirmed.\n\nMarket: ${event.market_name||event.title||'Trinity Crafters Market'}\nDate: ${d}\nLocation: ${event.location}\nAddress: ${event.address||''}\nSpace: ${p.space}\nWhat you sell: ${selling}\nPayment: ${money(amount)} by ${p.payment_method}\n\nPlease keep this email for your records. Additional setup instructions will be sent before the market.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`;
  await sql.begin(async tx=>{await queue(tx,email,'Trinity Crafters Market Booking Confirmation — '+d,body);await audit(tx,u,'manual vendor booking',{id:row.id,event_id:event.id,email,space:p.space,payment_method:p.payment_method,amount});});
  await flushMail();
  return json({ok:true,id:row.id,amount});
 }catch(e){console.error(e);return json({error:e.message||'Could not save manual booking.'},400);}
};
