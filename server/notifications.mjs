const contact='trinitycraftersmarket@gmail.com';
const dateOnly=d=>d instanceof Date?d.toISOString().slice(0,10):(String(d??'').match(/\d{4}-\d{2}-\d{2}/)?.[0]||'');
const formatDate=d=>{const ymd=dateOnly(d),x=ymd?new Date(ymd+'T12:00:00Z'):new Date(NaN);return Number.isNaN(x.getTime())?'Market date':x.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'});};
export function decisionEmail(booking,event,reason=''){
 const day=formatDate(event.date);
 const details=`${day}\n10 AM–3 PM Eastern\n${event.location}\n${event.address}\n${booking.space==='indoor'?'Indoor':'Outdoor'} space — $${(booking.price/100).toFixed(2)}`;
 if(booking.status==='declined')return {subject:`Market application decision — ${day}`,body:`Hi ${booking.name},\n\nThank you for applying to Trinity Crafters Market. We are unable to approve your application for the following date:\n\n${details}\n\nReason: ${reason}\n\nThis decision applies only to this date. Other requested dates are reviewed separately. If you have questions, reply to this email.\n\nTrinity Crafters Market\n${contact}`};
 return {subject:`You're approved — Trinity Crafters Market, ${day}`,body:`Hi ${booking.name},\n\nYour vendor application has been approved for:\n\n${details}\n\nYour space is reserved pending payment. We will send your invoice separately. The 30-hour payment deadline begins when the invoice is sent, not when this approval email arrives. If payment has not been received after 12 hours, we will send a reminder. If payment is still not received by 30 hours, the reservation will automatically cancel, the space will be released for resale, and you will need to reapply if you still want to attend.\n\nPlease remember:\n• Payments are nonrefundable.\n• We operate rain or shine. In the event of a hurricane, we will reschedule the market and notify you of the new date.\n• Do not pack up before 3 PM.\n• Advertise the market on Facebook.\n\nOther requested dates are reviewed separately. We look forward to seeing you!\n\nTrinity Crafters Market\n${contact}`};
}
// §42 (Oct 24, 2026): there is deliberately NO ban notification
// template here anymore. Banning a vendor is silent — the organizer
// removed the automatic ban-notice email entirely; a
// banned vendor who asks gets the organizer's own reply, not a
// template. Do not re-add one.
