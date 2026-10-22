// server/counts.mjs — THE counting module (rebuild audit §1 rule 3, P1-2).
//
// Every capacity / category / availability number in the product comes from
// here. Before this module, the same counts were re-implemented in at least
// five places (publicData, apply, recover-application, event save,
// organizer-tools reschedule, vendor-credit, move-space) with different
// status lists — most included 'pending', none deduplicated the
// booking/imported twin records, so a vendor existing as both records was
// counted twice (the "10 active vendors in 9 booths" bug, audit §5 R-1).
//
// Semantics (owner decision, audit §13.1): a pending application does NOT
// reserve a booth. Active = bookings that are approved/paid or held with an
// unexpired hold (server/rules.mjs `active()`), plus imported attendees that
// are not cancelled. A booking and an imported_attendees row for the same
// vendor + event — matched on the shared identity keys — count ONCE.
//
// The dedupe/aggregation itself runs in JS over the candidate rows so the
// semantics live in exactly one implementation, shared by every caller
// (SQL-side copies of this logic are what diverged last time). Row volumes
// are small (per-event vendor lists; a few thousand rows for all upcoming
// events in publicData), so this is not a performance concern.
import {active as bookingActive} from './rules.mjs';

// The one place the messy stored space vocabulary is normalized
// (audit §8.9): bookings use indoor/outdoor; imported rows use
// Inside/Outside with arbitrary casing/whitespace from PDF imports.
export function normalizeSpace(value){
 const s=String(value||'').trim().toLowerCase();
 if(s==='indoor'||s==='inside')return 'indoor';
 if(s==='outdoor'||s==='outside')return 'outdoor';
 return null;
}

// Mirror of the client-side vendorIdentityKey (public/app.js): vendor_id
// first, then lowercased email (trailing commas stripped), then phone
// digits, then the normalized business/name. Two records — one in each
// table, or two in the same table — are the same vendor for an event iff
// their keys are equal.
export function vendorIdentityKey(v={}){
 const email=String(v.email||'').trim().toLowerCase().replace(/,+$/,'');
 const phone=String(v.phone||'').replace(/\D/g,'');
 const name=String(v.business||v.name||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
 return v.vendor_id?'vendor:'+v.vendor_id:email?'email:'+email:phone?'phone:'+phone:name?'name:'+name:'row:'+v.id;
}

// Winner rank when twins disagree, mirroring the client's dedupeVendorRows
// (paid > held > approved); an imported row is a confirmed attendee, ranked
// just below an approved booking so the booking — the system of record for
// space/category — wins ties.
const BOOKING_RANK={paid:5,held:4,approved:3};
const IMPORTED_RANK=2;

function unifyBooking(b){
 return {source:'booking',id:b.id,event_id:b.event_id,space:normalizeSpace(b.space),category_id:b.category_id||null,
  key:vendorIdentityKey({vendor_id:b.vendor_id,email:b.email,phone:b.phone,business:b.business,name:b.name,id:b.id}),
  rank:BOOKING_RANK[b.status]||0};
}
function unifyImported(i){
 return {source:'imported',id:i.id,event_id:i.event_id,space:normalizeSpace(i.space),category_id:i.category_id||null,
  key:vendorIdentityKey({vendor_id:i.vendor_id,email:i.email,phone:i.phone,business:i.business,name:i.name,id:i.id}),
  rank:IMPORTED_RANK};
}

// Dedupe unified rows by identity key, keeping the highest-ranked record
// (first record wins ties; callers pass bookings before imported rows).
export function dedupeVendors(rows){
 const map=new Map();
 for(const r of rows||[]){
  const old=map.get(r.key);
  if(!old||r.rank>old.rank)map.set(r.key,r);
 }
 return [...map.values()];
}

async function candidateRows(sql,eventId){
 const bookings=eventId
  ? await sql`select b.id,b.event_id,b.space,b.status,b.hold_until,a.email,a.phone,a.business,a.name,a.vendor_id,a.category_id from market.bookings b join market.applications a on a.id=b.application_id where b.event_id=${eventId}`
  : await sql`select b.id,b.event_id,b.space,b.status,b.hold_until,a.email,a.phone,a.business,a.name,a.vendor_id,a.category_id from market.bookings b join market.applications a on a.id=b.application_id`;
 const imported=eventId
  ? await sql`select i.id,i.event_id,i.space,i.cancelled,i.email,i.phone,i.business,i.name,i.vendor_id,i.category_id from market.imported_attendees i where i.event_id=${eventId}`
  : await sql`select i.id,i.event_id,i.space,i.cancelled,i.email,i.phone,i.business,i.name,i.vendor_id,i.category_id from market.imported_attendees i`;
 return [
  ...bookings.filter(b=>bookingActive(b)).map(unifyBooking),
  ...imported.filter(i=>!i.cancelled).map(unifyImported)
 ];
}

// The deduped active vendors for one event:
// [{source:'booking'|'imported', id, event_id, space:'indoor'|'outdoor'|null, category_id, key}]
export async function activeVendors(sql,eventId){
 return dedupeVendors(await candidateRows(sql,eventId));
}

// {indoor, outdoor, categories: Map<category_id, used>, vendors: [activeVendors rows]}
export function inventoryOf(vendors){
 const categories=new Map();
 let indoor=0,outdoor=0;
 for(const v of vendors||[]){
  if(v.space==='indoor')indoor++;
  else if(v.space==='outdoor')outdoor++;
  if(v.category_id)categories.set(String(v.category_id),(categories.get(String(v.category_id))||0)+1);
 }
 return {indoor,outdoor,categories,vendors:vendors||[]};
}

export async function eventInventory(sql,eventId){
 return inventoryOf(await activeVendors(sql,eventId));
}

export async function spaceUsed(sql,eventId,space){
 const inv=await eventInventory(sql,eventId);
 const s=normalizeSpace(space);
 return s?inv[s]:0;
}

export async function categoryUsed(sql,eventId,categoryId){
 const inv=await eventInventory(sql,eventId);
 return inv.categories.get(String(categoryId))||0;
}

// Capacity guard with the same messages as server/rules.mjs checkCapacity,
// but computed from the unified (deduped, bookings + imported) counts.
// `selfKey` is the vendorIdentityKey of the vendor being added: if that
// vendor is already counted (e.g. approving a booking whose imported twin
// holds the spot), adding them does not consume another booth/category slot.
export async function assertCapacity(sql,event,{space,categoryId,limit,exception=false,selfKey=null}={}){
 const inv=await eventInventory(sql,event.id);
 const s=normalizeSpace(space)||space;
 const selfInSpace=!!selfKey&&inv.vendors.some(v=>v.key===selfKey&&v.space===s);
 if(inv[s]>=Number(event[s+'_capacity']||0)&&!selfInSpace)throw Error('This space is sold out.');
 if(!exception&&limit!=null){
  const selfInCategory=!!selfKey&&inv.vendors.some(v=>v.key===selfKey&&String(v.category_id||'')===String(categoryId||''));
  if((inv.categories.get(String(categoryId))||0)>=Number(limit)&&!selfInCategory)throw Error('Category is full. Explicitly approve a category exception to continue.');
 }
 return inv;
}

// Counts for every event at once (publicData). Returns
// {spaces: Map<event_id, {indoor, outdoor}>, categories: Map<event_id, Map<category_id, used>>}
export async function publicCounts(sql){
 const spaces=new Map(),categories=new Map();
 // Dedupe is per event: a vendor active at two different events counts at
 // both, so group the candidates by event before deduping.
 const byEvent=new Map();
 for(const r of await candidateRows(sql,null)){
  const k=String(r.event_id);
  if(!byEvent.has(k))byEvent.set(k,[]);
  byEvent.get(k).push(r);
 }
 for(const [eventId,list] of byEvent){
  const inv=inventoryOf(dedupeVendors(list));
  spaces.set(eventId,{indoor:inv.indoor,outdoor:inv.outdoor});
  categories.set(eventId,inv.categories);
 }
 return {spaces,categories};
}

// Shape the per-(event, category) rows publicData returns:
// [{event_id, category_id, used, vendor_limit}] where vendor_limit is the
// per-event override when one exists, else the category default. Pairs whose
// category no longer exists are dropped (the old SQL inner-joined categories).
export function categoryCountRows(counts,categories,categoryLimits){
 const catById=new Map((categories||[]).map(c=>[String(c.id),c]));
 const override=new Map((categoryLimits||[]).map(o=>[String(o.event_id)+'|'+String(o.category_id),o.vendor_limit]));
 const rows=[];
 for(const [eventId,catMap] of counts.categories){
  for(const [categoryId,used] of catMap){
   const cat=catById.get(String(categoryId));
   if(!cat)continue;
   rows.push({event_id:eventId,category_id:categoryId,used,vendor_limit:override.get(eventId+'|'+categoryId)??cat.vendor_limit});
  }
 }
 return rows;
}
