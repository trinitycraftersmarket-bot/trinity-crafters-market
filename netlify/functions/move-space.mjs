import {db,identity,audit,isUserError} from '../../server/core.mjs';
import {spaceUsed,vendorIdentityKey} from '../../server/counts.mjs';
import {syncSpace} from '../../server/twins.mjs';

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
   let eventId,currentSpace,identityRow=null,source=p.imported?'imported':'booking';
   if(p.imported){
    const [r]=await tx`select id,event_id,space,email,phone,business,name,vendor_id from market.imported_attendees where id=${p.id} for update`; if(!r)throw Error('Attendee not found.');
    eventId=r.event_id; currentSpace=String(r.space||'').toLowerCase(); identityRow=r;
   }else{
    const [r]=await tx`select b.id,b.event_id,b.space,b.status,a.email,a.phone,a.business,a.name,a.vendor_id from market.bookings b join market.applications a on a.id=b.application_id where b.id=${p.id} for update of b`; if(!r)throw Error('Booking not found.');
    if(!['approved','held','paid'].includes(r.status))throw Error('Only confirmed attendees can be moved.'); eventId=r.event_id; currentSpace=r.space; identityRow=r;
   }
   // Twin-sync invariant (server/twins.mjs): the vendor's other record for
   // this event moves with them, even when this record was already in place.
   const twinKey=identityRow?vendorIdentityKey({vendor_id:identityRow.vendor_id,email:identityRow.email,phone:identityRow.phone,business:identityRow.business,name:identityRow.name,id:p.id}):null;
   const normalizedCurrent=['inside','indoor'].includes(currentSpace)?'indoor':'outdoor'; if(normalizedCurrent===space){if(twinKey)await syncSpace(tx,{eventId,key:twinKey,exclude:{source,id:p.id},space});return;}
   const [e]=await tx`select indoor_capacity,outdoor_capacity from market.events where id=${eventId}`; if(!e)throw Error('Market date not found.');
   // Availability from the single counting function (server/counts.mjs):
   // owner semantics + twin dedupe. (The old imported count here also
   // forgot to exclude cancelled rows.)
   const used=await spaceUsed(tx,eventId,space),capacity=Number(e[space+'_capacity']||0);
   if(used>=capacity)throw Error((space==='indoor'?'Inside':'Outside')+' is full for this market date.');
   if(p.imported)await tx`update market.imported_attendees set space=${space==='indoor'?'Inside':'Outside'} where id=${p.id}`;
   else await tx`update market.bookings set space=${space},price=${space==='indoor'?45:30}*100 where id=${p.id}`;
   if(twinKey)await syncSpace(tx,{eventId,key:twinKey,exclude:{source,id:p.id},space});
   await audit(tx,u,'attendee space moved',{id:p.id,imported:!!p.imported,from:normalizedCurrent,to:space,event_id:eventId});
  });
  return json({ok:true});
 }catch(e){console.error('Move space failed',e);if(isUserError(e))return json({error:e.message},400);return json({error:'Could not move vendor.'},500);}
};
