import {db,identity,audit} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req); if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const p=await req.json(); const space=p.space;
  if(!p.id||!['indoor','outdoor'].includes(space))throw Error('Choose Inside or Outside.');
  const sql=db();
  await sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(708821)`;
   let eventId,currentSpace;
   if(p.imported){
    const [r]=await tx`select id,event_id,space from market.imported_attendees where id=${p.id} for update`; if(!r)throw Error('Attendee not found.');
    eventId=r.event_id; currentSpace=String(r.space||'').toLowerCase();
   }else{
    const [r]=await tx`select id,event_id,space,status from market.bookings where id=${p.id} for update`; if(!r)throw Error('Booking not found.');
    if(!['approved','held','paid'].includes(r.status))throw Error('Only confirmed attendees can be moved.'); eventId=r.event_id; currentSpace=r.space;
   }
   const normalizedCurrent=['inside','indoor'].includes(currentSpace)?'indoor':'outdoor'; if(normalizedCurrent===space)return;
   const [e]=await tx`select indoor_capacity,outdoor_capacity from market.events where id=${eventId}`; if(!e)throw Error('Market date not found.');
   const [normal]=await tx`select count(*)::int n from market.bookings where event_id=${eventId} and space=${space} and (status in ('approved','paid') or (status='held' and hold_until>now()))`;
   const aliases=space==='indoor'?['inside','indoor']:['outside','outdoor'];
   const [imported]=await tx`select count(*)::int n from market.imported_attendees where event_id=${eventId} and lower(space)=any(${aliases})`;
   const used=Number(normal.n||0)+Number(imported.n||0),capacity=Number(e[space+'_capacity']||0);
   if(used>=capacity)throw Error((space==='indoor'?'Inside':'Outside')+' is full for this market date.');
   if(p.imported)await tx`update market.imported_attendees set space=${space==='indoor'?'Inside':'Outside'} where id=${p.id}`;
   else await tx`update market.bookings set space=${space},price=${space==='indoor'?45:30}*100 where id=${p.id}`;
   await audit(tx,u,'attendee space moved',{id:p.id,imported:!!p.imported,from:normalizedCurrent,to:space,event_id:eventId});
  });
  return json({ok:true});
 }catch(e){return json({error:e.message||'Could not move vendor.'},400);}
};
