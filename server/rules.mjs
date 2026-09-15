export const normalizePhone = value => { const n=String(value||'').replace(/\D/g,'');return n.length===11&&n[0]==='1'?n.slice(1):n; };
export const active = (b,now=Date.now()) => ['approved','paid'].includes(b.status)||(b.status==='held'&&new Date(b.hold_until).getTime()>now);
export function checkCapacity(event,bookings,space,categoryId,limit,exception=false){
 if(bookings.filter(b=>active(b)&&b.space===space).length>=event[space+'_capacity']) throw Error('This space is sold out.');
 if(!exception&&bookings.filter(b=>active(b)&&b.category_id===categoryId).length>=limit) throw Error('Category is full. Explicitly approve a category exception to continue.');
}
