// server/twins.mjs — twin-record sync as a server invariant (audit P1-3).
//
// A vendor on a market date can exist as a market.bookings row (online
// application) AND a market.imported_attendees row (PDF import / manual
// booking) with no shared schema key. Before this module, a write to one
// record left its twin stale — the root of the "labels don't update" bugs
// (audit §5 R-1); the Oct 22 inspection fix (commit 18fe3cd) patched that
// one endpoint by hand, matching twins by email only. These helpers are the
// general version: twins are resolved by the shared identity keys
// (server/counts.mjs vendorIdentityKey — vendor_id, else email, else phone,
// else normalized name) and shared-field writes fan out to both tables in
// the caller's transaction.
//
// Deliberately NOT synced here:
// - Booking workflow status (approve/decline/waitlist/held/paid). Imported
//   rows have no equivalent lifecycle (their payment_status is a separate
//   field), and booking transitions carry side effects (PayPal invoices,
//   decision emails) owned by the booking action.
// - Category. A booking's category lives on its application — shared by all
//   of that vendor's dates — so writing it from one event's twin would
//   silently re-categorize the vendor everywhere.
import {vendorIdentityKey,normalizeSpace} from './counts.mjs';

export const identityOf=r=>({vendor_id:r?.vendor_id??null,email:r?.email,phone:r?.phone,business:r?.business,name:r?.name});
export const keyOf=(r,id)=>vendorIdentityKey({...identityOf(r),id:id??r?.id});

// All booking + imported records for one event, tagged with identity keys.
export async function eventVendorRecords(tx,eventId){
 const bookings=await tx`select b.id,b.event_id,a.email,a.phone,a.business,a.name,a.vendor_id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${eventId}`;
 const imported=await tx`select i.id,i.event_id,i.email,i.phone,i.business,i.name,i.vendor_id from market.imported_attendees i where i.event_id=${eventId}`;
 return [
  ...bookings.map(r=>({source:'booking',id:r.id,event_id:r.event_id,key:keyOf(r)})),
  ...imported.map(r=>({source:'imported',id:r.id,event_id:r.event_id,key:keyOf(r)}))
 ];
}

// Records in the event whose identity key equals `key`, minus `exclude`
// ({source, id} — typically the record that was just updated directly).
export async function findTwins(tx,eventId,key,exclude=null){
 const rows=await eventVendorRecords(tx,eventId);
 return rows.filter(r=>r.key===key&&!(exclude&&r.source===exclude.source&&String(r.id)===String(exclude.id)));
}

// Fan an inspection result out to the twin record(s). Returns the number of
// twin rows updated (the caller adds its own primary update and keeps the
// Oct 22 behavior of erroring when the total is zero).
export async function syncInspection(tx,{eventId,key,exclude=null,status,notes=null,at=null,by=null}){
 let updated=0;
 for(const t of await findTwins(tx,eventId,key,exclude)){
  if(t.source==='booking')await tx`update market.bookings set inspection_status=${status},inspection_notes=${notes},inspected_at=${at},inspected_by=${by} where id=${t.id}`;
  else await tx`update market.imported_attendees set inspection_status=${status},inspection_notes=${notes},inspected_at=${at},inspected_by=${by} where id=${t.id}`;
  updated++;
 }
 return updated;
}

// Fan a space change out to the twin record(s), writing each table's own
// vocabulary (bookings: indoor/outdoor; imported: Inside/Outside — the
// convention move-space has always written).
export async function syncSpace(tx,{eventId,key,exclude=null,space}){
 const norm=normalizeSpace(space);
 if(!norm)return 0;
 let updated=0;
 for(const t of await findTwins(tx,eventId,key,exclude)){
  if(t.source==='booking')await tx`update market.bookings set space=${norm} where id=${t.id}`;
  else await tx`update market.imported_attendees set space=${norm==='indoor'?'Inside':'Outside'} where id=${t.id}`;
  updated++;
 }
 return updated;
}

// Fan a cancellation out to the twin record(s), translating between the two
// tables' representations (imported: cancelled flag + release the category
// reservation; booking: status='cancelled' + release the hold).
export async function syncCancellation(tx,{eventId,key,exclude=null}){
 let updated=0;
 for(const t of await findTwins(tx,eventId,key,exclude)){
  if(t.source==='booking'){
   await tx`update market.bookings set status='cancelled',hold_until=null where id=${t.id}`;
  }else{
   await tx`update market.imported_attendees set cancelled=true where id=${t.id}`;
   await tx`delete from market.imported_category_reservations where imported_attendee_id=${t.id}`;
  }
  updated++;
 }
 return updated;
}
