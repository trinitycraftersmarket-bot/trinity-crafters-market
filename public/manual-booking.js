(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>'$'+(Number(n||0)/100).toFixed(2);
 const token=()=>sessionStorage.getItem('market-token');
 async function call(method,body){const r=await fetch('/.netlify/functions/manual-booking',{method,headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||'Could not complete request.');return v;}
 function ensureTab(){
  if(location.hash!=='#admin')return;
  const tabs=document.querySelector('.tabs'),panel=document.querySelector('#panel');
  if(!tabs||!panel||tabs.querySelector('[data-manual-booking]'))return;
  const b=document.createElement('button');b.textContent='Manual Booking';b.dataset.manualBooking='1';tabs.appendChild(b);b.onclick=()=>open(panel,b,tabs);
 }
 async function open(panel,button,tabs){
  tabs.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));button.classList.add('selected');
  panel.innerHTML='<div class="card"><h2>Manual Vendor Booking</h2><p>Loading market dates…</p></div>';
  try{
   const d=await call('GET');
   panel.innerHTML=`<section class="card"><h2>Manual Vendor Booking</h2><p>Use this when a vendor books directly with you at a market. The booking is saved as paid and a confirmation email is sent automatically.</p><form id="manual-booking-form"><div class="grid2"><label>Vendor name<input name="name" required></label><label>Business name (optional)<input name="business"></label><label>Email address<input name="email" type="email" required></label><label>Phone number<input name="phone" type="tel" required></label></div><label>What do they sell?<textarea name="selling" rows="4" required></textarea></label><label>Product category<select name="category_id"><option value="">Other / choose automatically</option>${d.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><div class="grid2"><label>Market date<select name="event_id" required>${d.events.map(e=>`<option value="${esc(e.id)}" data-inside="${e.indoor_price}" data-outside="${e.outdoor_price}">${new Date(e.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'})} — ${esc(e.market_name||e.title||e.location)}</option>`).join('')}</select></label><label>Space<select name="space" required><option value="Inside">Inside</option><option value="Outside">Outside</option></select></label></div><div class="grid2"><label>Payment method<select name="payment_method" required><option value="cash">Cash</option><option value="credit card">Credit card</option></select></label><label>Amount paid ($)<input name="amount" type="number" min="0" step="0.01" required></label></div><p class="muted" id="manual-price-note"></p><button>Save booking & email confirmation</button></form></section>`;
   const form=document.querySelector('#manual-booking-form'),event=form.event_id,space=form.space,amount=form.amount,note=document.querySelector('#manual-price-note');
   const price=()=>{const o=event.selectedOptions[0],c=space.value==='Inside'?Number(o?.dataset.inside||0):Number(o?.dataset.outside||0);amount.value=(c/100).toFixed(2);note.textContent='Current '+space.value.toLowerCase()+' rate: '+money(c)+'. You can change the amount if needed.';};
   event.onchange=price;space.onchange=price;price();
   form.onsubmit=async e=>{e.preventDefault();const fd=new FormData(form),payload=Object.fromEntries(fd.entries());try{form.querySelector('button').disabled=true;const r=await call('POST',payload);document.querySelector('#notice').textContent='Manual booking saved. Confirmation email sent to '+payload.email+'.';form.reset();price();}catch(err){document.querySelector('#notice').textContent=err.message;}finally{form.querySelector('button').disabled=false;}};
  }catch(e){panel.innerHTML=`<div class="card"><h2>Manual Vendor Booking</h2><div class="note">${esc(e.message)}</div></div>`;}
 }
 new MutationObserver(ensureTab).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('hashchange',()=>setTimeout(ensureTab,100));setTimeout(ensureTab,500);
})();
