import {db,identity,audit,isUserError} from '../../server/core.mjs';
import {normalizeSpace,spaceUsed,vendorIdentityKey} from '../../server/counts.mjs';
import {syncSpace} from '../../server/twins.mjs';
import {isRegularVendor,regularAwarePrice} from '../../server/pricing.mjs';
import {ensureCoupons,couponPercentFor,applyCouponPrice} from '../../server/coupons.mjs';
import {ensureHallway} from '../../server/hallway.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const spaceLabel=s=>s==='indoor'?'Inside':s==='hallway'?'Hallway':'Outside';
export default async req=>{
 try{
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const u=await identity(req); if(!(u.admin||u.manager))return json({error:'Organizer or Manager access only'},403);
  const p=await req.json(); const space=p.space;
  if(!p.id||!['indoor','outdoor','hallway'].includes(space))throw Error('Choose Inside, Outside or Hallway.');
  // §60: an optional swap partner — a vendor currently in the target
  // space who takes this vendor's space in exchange. A swap exchanges
  // two records 1-for-1, so no space's used count changes and the
  // capacity refusal below never applies to it.
  const swapWith=p.swapWith&&p.swapWith.id?{id:p.swapWith.id,imported:!!p.swapWith.imported}:null;
  const sql=db();
  await sql.begin(async tx=>{
   await tx`select pg_advisory_xact_lock(708821)`;await ensureHallway(tx);await ensureCoupons(tx);
   // Load one record (booking or imported attendee) for update.
   const load=async(id,imported)=>{
    if(imported){
     const [r]=await tx`select id,event_id,space,email,phone,business,name,vendor_id,cancelled from market.imported_attendees where id=${id} for update`; return r?{...r,imported:true}:null;
    }
    const [r]=await tx`select b.id,b.application_id,b.event_id,b.space,b.status,b.coupon_code,a.email,a.phone,a.business,a.name,a.vendor_id from market.bookings b join market.applications a on a.id=b.application_id where b.id=${id} for update of b`; return r?{...r,imported:false}:null;
   };
   const src=await load(p.id,!!p.imported);
   if(!src)throw Error(p.imported?'Attendee not found.':'Booking not found.');
   if(!src.imported&&!['approved','held','paid'].includes(src.status))throw Error('Only confirmed attendees can be moved.');
   const eventId=src.event_id;
   const keyOfRow=(row,id)=>vendorIdentityKey({vendor_id:row.vendor_id,email:row.email,phone:row.phone,business:row.business,name:row.name,id});
   // Twin-sync invariant (server/twins.mjs): the vendor's other record for
   // this event moves with them, even when this record was already in place.
   const twinKey=keyOfRow(src,p.id);
   const normalizedCurrent=normalizeSpace(src.space)||'outdoor';
   if(normalizedCurrent===space){
    if(swapWith)throw Error('That vendor is already '+spaceLabel(space)+' — nothing to swap.');
    if(twinKey)await syncSpace(tx,{eventId,key:twinKey,exclude:{source:p.imported?'imported':'booking',id:p.id},space});
    return;
   }
   const [e]=await tx`select indoor_capacity,outdoor_capacity,hallway_capacity,indoor_price,outdoor_price,hallway_price,location_id from market.events where id=${eventId}`; if(!e)throw Error('Market date not found.');
   // Put one record into a space. Imported rows only change space —
   // their organizer-set invoice_amount never reprices on a move/swap.
   // Bookings reprice via §50: regularAwarePrice reads the EVENT's
   // prices, and a regular-flagged vendor pays the location's regular
   // rate for their new space, never the standard price.
   const applySpace=async(row,toSpace)=>{
    if(row.imported)await tx`update market.imported_attendees set space=${toSpace==='indoor'?'Inside':toSpace==='hallway'?'Hallway':'Outside'} where id=${row.id}`;
    else{let newPrice=await regularAwarePrice(tx,{locationId:e.location_id,space:toSpace,indoorPrice:e.indoor_price,outdoorPrice:e.outdoor_price,hallwayPrice:e.hallway_price,regular:await isRegularVendor(tx,{email:row.email,applicationId:row.application_id||null})});
    // §63: a coupon booking keeps its coupon % applied to the new
    // space price (the discount follows the booking, like §50's rate).
    if(row.coupon_code){const pct=await couponPercentFor(tx,row.coupon_code);if(pct!=null)newPrice=applyCouponPrice(newPrice,pct);}
    await tx`update market.bookings set space=${toSpace},price=${newPrice} where id=${row.id}`;}
   };
   if(swapWith){
    // §60 swap — every fact is recomputed inside this transaction:
    // the partner must be a movable record on THIS event, currently
    // sitting in the target space, and a different vendor. Both sides
    // then exchange spaces, reprice by the same rules as a plain move,
    // twin-sync, and each side's audit entry names the other.
    if(String(swapWith.id)===String(p.id)&&swapWith.imported===!!p.imported)throw Error('Pick a different vendor to swap with.');
    const partner=await load(swapWith.id,swapWith.imported);
    if(!partner)throw Error('Swap partner not found.');
    if(partner.event_id!==eventId)throw Error('That vendor is on a different market date.');
    if(!partner.imported&&!['approved','held','paid'].includes(partner.status))throw Error('Only confirmed attendees can be swapped.');
    if(partner.imported&&partner.cancelled)throw Error('That vendor is no longer attending this market date.');
    if((normalizeSpace(partner.space)||'outdoor')!==space)throw Error('That vendor is not in the '+spaceLabel(space)+' space anymore — reload and pick another vendor.');
    const partnerKey=keyOfRow(partner,swapWith.id);
    if(partnerKey===twinKey)throw Error('That is the same vendor — pick someone else to swap with.');
    await applySpace(src,space);
    await applySpace(partner,normalizedCurrent);
    if(twinKey)await syncSpace(tx,{eventId,key:twinKey,exclude:{source:p.imported?'imported':'booking',id:p.id},space});
    await syncSpace(tx,{eventId,key:partnerKey,exclude:{source:swapWith.imported?'imported':'booking',id:swapWith.id},space:normalizedCurrent});
    await audit(tx,u,'attendee space swapped',{id:p.id,imported:!!p.imported,from:normalizedCurrent,to:space,partner_id:swapWith.id,partner_imported:swapWith.imported,event_id:eventId});
    await audit(tx,u,'attendee space swapped',{id:swapWith.id,imported:swapWith.imported,from:space,to:normalizedCurrent,partner_id:p.id,partner_imported:!!p.imported,event_id:eventId});
    return;
   }
   // Availability from the single counting function (server/counts.mjs):
   // owner semantics + twin dedupe. (The old imported count here also
   // forgot to exclude cancelled rows.)
   const used=await spaceUsed(tx,eventId,space),capacity=Number(e[space+'_capacity']||0);
   if(used>=capacity)throw Error(spaceLabel(space)+' is full for this market date.');
   await applySpace(src,space);
   if(twinKey)await syncSpace(tx,{eventId,key:twinKey,exclude:{source:p.imported?'imported':'booking',id:p.id},space});
   await audit(tx,u,'attendee space moved',{id:p.id,imported:!!p.imported,from:normalizedCurrent,to:space,event_id:eventId});
  });
  return json({ok:true});
 }catch(e){console.error('Move space failed',e);if(isUserError(e))return json({error:e.message},400);return json({error:'Could not move vendor.'},500);}
};
