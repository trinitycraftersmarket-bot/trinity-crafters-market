import {db,identity} from '../../server/core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export default async req=>{
 try{
  const u=await identity(req),sql=db();
  if(req.method==='GET'){
   if(!u.admin&&!u.manager)return json({error:'Organizer access required.'},403);
   const url=new URL(req.url),bookingId=url.searchParams.get('booking_id');
   if(!bookingId)return json({error:'Booking required.'},400);
   const [row]=await sql`select a.agreements from market.bookings b join market.applications a on a.id=b.application_id where b.id=${bookingId}`;
   return json({special_requests:String(row?.agreements?.special_requests||'')});
  }
  return json({error:'Method not allowed.'},405);
 }catch(e){console.error(e);return json({error:e.message||'Could not load special requests.'},400);}
};
