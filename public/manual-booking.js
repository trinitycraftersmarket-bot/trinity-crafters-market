(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>'$'+(Number(n||0)/100).toFixed(2);
 const dateOnly=v=>{
  const s=String(v??'');
  const m=s.match(/^(\d{4}-\d{2}-\d{2})/);
  if(m)return m[1];
  const d=new Date(s);
  if(Number.isNaN(d.getTime()))return '';
  return d.toISOString().slice(0,10);
 };
 const prettyDate=v=>{
  const ymd=dateOnly(v);
  if(!ymd)return 'Date unavailable';
  return new Date(ymd+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'});
 };
 const token=()=>sessionStorage.getItem('market-token');
 async function call(method,body,query=''){const r=await fetch('/.netlify/functions/manual-booking'+query,{method,headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||'Could not complete request.');return v;}
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
   panel.innerHTML=`<section class="card"><h2>Manual Vendor Booking</h2><p>Use this when a vendor books directly with you at a market. Search for a returning vendor or add a new vendor below. Cash and credit card bookings are recorded as paid; Monthly Billing records an amount due. Saving sends a booking confirmation email.</p><form id="manual-booking-form"><label>Search existing vendors<input id="manual-vendor-search" type="search" autocomplete="off" placeholder="Name, business, email or phone" aria-describedby="manual-vendor-status"></label><p id="manual-vendor-status" class="muted" role="status">Type at least 2 characters to search.</p><div id="manual-vendor-results" class="list"></div><button type="button" id="manual-new-vendor" class="secondary">Add new vendor</button><p id="manual-vendor-selection" class="muted"></p><div class="grid2"><label>Vendor name<input name="name" required></label><label>Business name (optional)<input name="business"></label><label>Email address<input name="email" type="email" required></label><label>Phone number<input name="phone" type="tel" required></label></div><label>What do they sell?<textarea name="selling" rows="4" required></textarea></label><label>Product category<select name="category_id"><option value="">Other / choose automatically</option>${d.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><div class="grid2"><label>Market date<select name="event_id" required>${d.events.map(e=>`<option value="${esc(e.id)}" data-inside="${e.indoor_price}" data-outside="${e.outdoor_price}">${prettyDate(e.date)} — ${esc(e.market_name||e.title||e.location)}</option>`).join('')}</select></label><label>Space<select name="space" required><option value="Inside">Inside</option><option value="Outside">Outside</option></select></label></div><div class="grid2"><label>Payment method<select name="payment_method" required><option value="cash">Cash</option><option value="credit card">Credit card</option><option value="monthly billing">Monthly Billing</option></select></label><label>Amount paid ($)<input name="amount" type="number" min="0" step="0.01" required></label></div><div id="manual-card-payment" class="note" hidden><h3>Credit card payment</h3><p id="manual-card-amount">Process this card securely with GoDaddy Payments. Card details are never entered or stored on this website.</p><a id="manual-godaddy-open" class="button" href="https://spa.commerce.godaddy.com/" target="_blank" rel="noopener">Open GoDaddy Virtual Terminal</a><label>GoDaddy transaction ID / payment reference<input name="payment_reference" autocomplete="off" placeholder="Enter after the payment is approved"></label></div><p class="muted" id="manual-price-note"></p><button type="submit" id="manual-save">Save booking & email confirmation</button></form></section>`;
   const form=document.querySelector('#manual-booking-form'),event=form.event_id,space=form.space,amount=form.amount,note=document.querySelector('#manual-price-note'),cardBox=document.querySelector('#manual-card-payment'),cardAmount=document.querySelector('#manual-card-amount'),cardRef=form.elements.namedItem('payment_reference');
   const search=form.querySelector('#manual-vendor-search'),results=form.querySelector('#manual-vendor-results'),status=form.querySelector('#manual-vendor-status'),selection=form.querySelector('#manual-vendor-selection'),newVendor=form.querySelector('#manual-new-vendor'),save=form.querySelector('#manual-save');
   const fields=['name','business','email','phone','selling','category_id'];
   let searchVersion=0,timer,busy=false;
   const clearSearch=()=>{clearTimeout(timer);searchVersion++;search.value='';results.replaceChildren();status.textContent='Type at least 2 characters to search.';};
   const selectVendor=v=>{
    fields.forEach(key=>{form.elements.namedItem(key).value=v[key]||'';});
    const missing=['email','phone'].filter(key=>!String(v[key]||'').trim());
    clearSearch();selection.textContent='Using '+(v.business||v.name||v.email)+'. '+(missing.length?'No saved '+missing.join(' or ')+' found. Enter the missing details below.':'Email and phone filled from saved records. Review before saving.');
    form.elements.namedItem('name').focus();
   };
   newVendor.onclick=()=>{if(busy)return;clearSearch();fields.forEach(key=>{form.elements.namedItem(key).value='';});selection.textContent='New vendor — enter their details below. They will be added when you save the booking.';form.elements.namedItem('name').focus();};
   search.oninput=()=>{
    clearTimeout(timer);const version=++searchVersion,q=search.value.trim();results.replaceChildren();
    if(q.length<2){status.textContent='Type at least 2 characters to search.';return;}
    status.textContent='Searching vendors…';
    timer=setTimeout(async()=>{
     try{
      const response=await call('GET',undefined,'?q='+encodeURIComponent(q));
      if(version!==searchVersion||!form.isConnected)return;
      const vendors=response.vendors||[];
      status.textContent=vendors.length?vendors.length+' match'+(vendors.length===1?'':'es')+'. Select a vendor to fill in their details.'+(vendors.length===25?' Refine your search if needed.':''):'No matching vendors. Choose Add new vendor to enter their details.';
      vendors.forEach(v=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=[v.business||v.name,v.business?v.name:'',v.email||'No saved email',v.phone||'No saved phone'].filter(Boolean).join(' · ');b.onclick=()=>{if(!busy)selectVendor(v);};results.appendChild(b);});
     }catch(err){if(version===searchVersion&&form.isConnected)status.textContent='Vendor search unavailable: '+err.message+' Try searching again, or enter the vendor details below.';}
    },250);
   };
   const price=()=>{const o=event.selectedOptions[0],c=space.value==='Inside'?Number(o?.dataset.inside||0):Number(o?.dataset.outside||0);amount.value=(c/100).toFixed(2);const isCard=form.payment_method.value==='credit card';cardBox.hidden=!isCard;cardRef.required=isCard;cardAmount.textContent='Process '+money(c)+' securely with GoDaddy Payments. Card details are never entered or stored on this website. After approval, return here and enter the GoDaddy transaction ID / payment reference.';note.textContent='Current '+space.value.toLowerCase()+' rate: '+money(c)+'. '+(form.payment_method.value==='monthly billing'?'Monthly Billing selected — an invoice will go out; this is the amount due.':isCard?'Credit card selected — process the payment above before saving.':'You can change the amount if needed.');};
   event.onchange=price;space.onchange=price;form.payment_method.onchange=price;price();
   form.onsubmit=async e=>{e.preventDefault();if(busy)return;const fd=new FormData(form),payload=Object.fromEntries(fd.entries());if(payload.payment_method==='credit card'&&!String(payload.payment_reference||'').trim()){document.querySelector('#notice').textContent='Process the card in GoDaddy first, then enter the GoDaddy transaction ID / payment reference.';cardRef.focus();return;}try{busy=true;save.disabled=true;newVendor.disabled=true;search.disabled=true;clearSearch();await call('POST',payload);document.querySelector('#notice').textContent='Manual booking saved. Confirmation queued for '+payload.email+'.';form.reset();selection.textContent='';price();}catch(err){document.querySelector('#notice').textContent=err.message;}finally{busy=false;save.disabled=false;newVendor.disabled=false;search.disabled=false;}};
  }catch(e){panel.innerHTML=`<div class="card"><h2>Manual Vendor Booking</h2><div class="note">${esc(e.message)}</div></div>`;}
 }
 new MutationObserver(ensureTab).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('hashchange',()=>setTimeout(ensureTab,100));setTimeout(ensureTab,500);
})();

