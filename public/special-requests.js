// Vendor special requests: capture on application and surface on organizer attendance cards.
(function(){
 const originalFetch=window.fetch.bind(window);
 window.fetch=async function(input,init){
  try{
   const url=typeof input==='string'?input:(input?.url||'');
   if(url.includes('action=apply')&&init?.body){
    const p=JSON.parse(init.body);
    const field=document.querySelector('[name="special_requests"]');
    if(field){p.agreements=p.agreements||{};p.agreements.special_requests=String(field.value||'').trim().slice(0,2000);init={...init,body:JSON.stringify(p)};}
   }
  }catch(e){console.warn('Special request capture skipped',e);}
  return originalFetch(input,init);
 };
 function addApplicationField(){
  const form=document.querySelector('#application');
  if(!form||form.querySelector('[name="special_requests"]'))return;
  const first=form.querySelector('section.card'); if(!first)return;
  const label=document.createElement('label');
  label.innerHTML='Special requests or setup notes <span style="font-weight:normal">(optional)</span><textarea name="special_requests" maxlength="2000" placeholder="Examples: need to be near an outlet, mobility/accessibility request, prefer wall space, bringing an extra display, or anything the organizer should know for setup."></textarea><small>These notes will be shown to the organizer on the attendance list for your market date.</small>';
  first.appendChild(label);
 }
 async function loadAttendanceNotes(){
  const token=sessionStorage.getItem('market-token'); if(!token)return;
  const cards=[...document.querySelectorAll('.inspection-row')];
  for(const card of cards){
   if(card.querySelector('.special-request-note'))continue;
   const btn=card.querySelector('[data-attendance-id]');
   if(!btn||btn.dataset.imported==='1')continue;
   try{
    const r=await originalFetch('/.netlify/functions/special-requests?booking_id='+encodeURIComponent(btn.dataset.attendanceId),{headers:{Authorization:'Bearer '+token}});
    if(!r.ok)continue; const v=await r.json(); if(!v.special_requests)continue;
    const note=document.createElement('div'); note.className='note special-request-note';
    const strong=document.createElement('strong'); strong.textContent='Special request / setup note';
    const p=document.createElement('p'); p.style.margin='4px 0 0'; p.textContent=v.special_requests;
    note.append(strong,p);
    const actions=card.querySelector('.report-actions'); card.insertBefore(note,actions||null);
   }catch{}
  }
 }
 let timer;
 const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>{addApplicationField();loadAttendanceNotes();},80)};
 new MutationObserver(refresh).observe(document.documentElement,{childList:true,subtree:true});
 document.addEventListener('DOMContentLoaded',refresh);refresh();
})();
