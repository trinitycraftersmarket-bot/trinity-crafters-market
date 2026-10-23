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
   panel.innerHTML=`<section class="card"><h2>Manual Vendor Booking</h2><p>Use this when a vendor books directly with you at a market. Search for a returning vendor or add a new vendor below. Cash and credit card bookings are recorded as paid; Monthly Billing records an amount due. Tick every market date to book — saving books them all and sends a booking confirmation email for each date.</p><form id="manual-booking-form"><label>Search existing vendors<input id="manual-vendor-search" type="search" autocomplete="off" placeholder="Name, business, email or phone" aria-describedby="manual-vendor-status"></label><p id="manual-vendor-status" class="muted" role="status">Type at least 2 characters to search.</p><div id="manual-vendor-results" class="list"></div><button type="button" id="manual-new-vendor" class="secondary">Add new vendor</button><p id="manual-vendor-selection" class="muted"></p><div class="grid2"><label>Vendor name<input name="name" required></label><label>Business name (optional)<input name="business"></label><label>Email address<input name="email" type="email" required></label><label>Phone number<input name="phone" type="tel" required></label></div><label>What do they sell?<textarea name="selling" rows="4" required></textarea></label><label>Product category<select name="category_id"><option value="">Other / choose automatically</option>${d.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><fieldset id="manual-events"><legend>Market dates — tick every date to book</legend><div id="manual-event-list" style="max-height:280px;overflow-y:auto;border:1px solid #ddd;border-radius:8px;padding:.25rem .75rem">${d.events.map(e=>`<div class="manual-event-row" style="display:flex;gap:.5rem;align-items:center;padding:.3rem 0;border-bottom:1px solid #f0ead9"><label style="flex:1;display:flex;gap:.5rem;align-items:center;margin:0"><input type="checkbox" class="manual-event-check" value="${esc(e.id)}" data-label="${esc(prettyDate(e.date))}" data-inside="${e.indoor_price}" data-outside="${e.outdoor_price}"><span>${prettyDate(e.date)} — ${esc(e.market_name||e.title||e.location)}</span></label><select class="manual-event-space" aria-label="Space"><option value="Inside">Inside</option><option value="Outside">Outside</option></select><span class="manual-event-rate muted" style="min-width:4.5rem;text-align:right"></span></div>`).join('')}</div><p class="muted" id="manual-events-summary">No dates ticked yet.</p></fieldset><div class="grid2"><label>Payment method<select name="payment_method" required><option value="cash">Cash</option><option value="credit card">Credit card</option><option value="monthly billing">Monthly Billing</option></select></label><label>Amount paid ($)<input name="amount" type="number" min="0" step="0.01" required></label></div><div id="manual-card-payment" class="note" hidden><h3>Credit card payment</h3><p id="manual-card-amount">Process this card securely with GoDaddy Payments. Card details are never entered or stored on this website.</p><a id="manual-godaddy-open" class="button" href="https://spa.commerce.godaddy.com/" target="_blank" rel="noopener">Open GoDaddy Virtual Terminal</a><label>GoDaddy Txn ID<input name="payment_reference" autocomplete="off" placeholder="Example: 92892acb"></label></div><p class="muted" id="manual-price-note"></p><button type="submit" id="manual-save">Save booking & email confirmation</button></form></section>`;
   const form=document.querySelector('#manual-booking-form'),amount=form.amount,note=document.querySelector('#manual-price-note'),cardBox=document.querySelector('#manual-card-payment'),cardAmount=document.querySelector('#manual-card-amount'),cardRef=form.elements.namedItem('payment_reference'),summary=document.querySelector('#manual-events-summary');
   const rows=[...form.querySelectorAll('.manual-event-row')].map(row=>({row,check:row.querySelector('.manual-event-check'),space:row.querySelector('.manual-event-space'),rate:row.querySelector('.manual-event-rate')}));
   const rowCents=r=>r.space.value==='Inside'?Number(r.check.dataset.inside||0):Number(r.check.dataset.outside||0);
   const picked=()=>rows.filter(r=>r.check.checked);
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
   const price=()=>{rows.forEach(r=>{r.rate.textContent=money(rowCents(r));});const sel=picked(),total=sel.reduce((s,r)=>s+rowCents(r),0),isCard=form.payment_method.value==='credit card';amount.value=(total/100).toFixed(2);amount.readOnly=sel.length>1;cardBox.hidden=!isCard;cardRef.required=isCard&&sel.length===1;cardAmount.textContent='Process '+money(total)+' securely with GoDaddy Payments. Card details are never entered or stored on this website. After approval, return here and enter the GoDaddy Txn ID shown on the receipt (for example, 92892acb).';summary.textContent=sel.length?sel.length+' date'+(sel.length===1?'':'s')+' ticked — total '+money(total)+'.':'No dates ticked yet.';note.textContent=!sel.length?'Tick at least one market date.':sel.length>1?'Each ticked date is booked at its own rate for the space picked on its row; the amount above is the combined total.'+(form.payment_method.value==='monthly billing'?' Monthly Billing selected — an amount due is recorded per date.':isCard?' Credit card bookings are one date at a time so the GoDaddy charge matches the booking.':''):('Current '+sel[0].space.value.toLowerCase()+' rate: '+money(rowCents(sel[0]))+'. '+(form.payment_method.value==='monthly billing'?'Monthly Billing selected — an invoice will go out; this is the amount due.':isCard?'Credit card selected — process the payment above before saving.':'You can change the amount if needed.'));};
   rows.forEach(r=>{r.check.onchange=price;r.space.onchange=price;});form.payment_method.onchange=price;price();
   form.onsubmit=async e=>{e.preventDefault();if(busy)return;const notice=document.querySelector('#notice'),sel=picked();if(!sel.length){notice.textContent='Tick at least one market date to book.';return;}const fd=new FormData(form),base=Object.fromEntries(fd.entries());if(base.payment_method==='credit card'){if(sel.length>1){notice.textContent='Credit card bookings are one date at a time, so the GoDaddy charge matches the booking amount. Untick all but one date, or choose Cash / Monthly Billing to book several dates at once.';return;}if(!String(base.payment_reference||'').trim()){notice.textContent='Process the card in GoDaddy first, then enter the GoDaddy Txn ID shown on the receipt.';cardRef.focus();return;}}const singleAmount=amount.value;try{busy=true;save.disabled=true;newVendor.disabled=true;search.disabled=true;clearSearch();const done=[],failed=[];for(const r of sel){const payload={...base,event_id:r.check.value,space:r.space.value,amount:sel.length===1?singleAmount:(rowCents(r)/100).toFixed(2)};try{await call('POST',payload);done.push(r);}catch(err){failed.push({r,err});}}done.forEach(r=>{r.check.checked=false;});if(!failed.length){notice.textContent='Manual booking saved for '+done.length+' date'+(done.length===1?'':'s')+'. Confirmation'+(done.length===1?'':'s')+' queued for '+base.email+'.';form.reset();selection.textContent='';}else{notice.textContent='Booked '+done.length+' of '+sel.length+' dates for '+base.email+'. Not booked: '+failed.map(f=>f.r.check.dataset.label+' ('+f.err.message+')').join('; ')+'. The failed dates are still ticked — fix and save again.';}price();}catch(err){notice.textContent=err.message;}finally{busy=false;save.disabled=false;newVendor.disabled=false;search.disabled=false;}};
  }catch(e){panel.innerHTML=`<div class="card"><h2>Manual Vendor Booking</h2><div class="note">${esc(e.message)}</div></div>`;}
 }
 new MutationObserver(ensureTab).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('hashchange',()=>setTimeout(ensureTab,100));setTimeout(ensureTab,500);
})();

