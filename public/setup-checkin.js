(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=()=>sessionStorage.getItem('market-token');
 const api=async(admin=false,payload)=>{const r=await fetch('/.netlify/functions/setup-checkin'+(admin?'?admin=1':''),{method:payload?'POST':'GET',headers:{...(token()?{Authorization:'Bearer '+token()}:{}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Could not load setup check-in.');return v;};
 const nice=d=>new Date(String(d).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'});
 const timeLabel=t=>({'08:15':'8:15 AM','08:30':'8:30 AM','08:45':'8:45 AM','09:00':'9:00 AM'}[String(t||'').slice(0,5)]||'Not selected');
 const notice=s=>{const n=document.querySelector('#notice');if(n)n.textContent=s;};

 async function addVendorCheckin(){
  if(location.hash!=='#account')return;
  const app=document.querySelector('#app');if(!app||app.querySelector('#setup-checkin-vendor')||!app.querySelector('h1'))return;
  const h=app.querySelector('h1');if(!/my market bookings/i.test(h.textContent))return;
  const box=document.createElement('section');box.id='setup-checkin-vendor';box.className='card';box.style.margin='0 0 22px';box.innerHTML='<h2 style="font-size:28px">Online Setup Check-In</h2><p>Loading your eligible market dates…</p>';
  const list=app.querySelector('.list');(list||h).insertAdjacentElement(list?'beforebegin':'afterend',box);
  try{
   const {rows=[]}=await api(false);
   if(!rows.length){box.innerHTML='<h2 style="font-size:28px">Online Setup Check-In</h2><p class="muted">No paid upcoming bookings are currently eligible for setup check-in.</p>';return;}
   box.innerHTML=`<h2 style="font-size:28px">Online Setup Check-In</h2><p><strong>Please choose your setup arrival time for each market date.</strong> Online check-in closes automatically 24 hours before the market. If you do not check in, organizers may assume you are not attending.</p><div class="list">${rows.map(r=>`<article class="card" data-setup-booking="${esc(r.booking_id)}"><div class="rowhead"><div><h3>${nice(r.date)}</h3><p>${esc(r.market_name||r.title||'Crafters Market')} · ${esc(r.location||'')}<br>${esc(r.business||'')} · ${esc(r.space||'')}</p></div><span class="tag ${r.setup_arrival_time?'':'held'}">${r.setup_arrival_time?'Checked in':'Not checked in'}</span></div>${r.checkin_open?`<label>Setup arrival time<select data-setup-time><option value="">Choose arrival time</option>${['08:15','08:30','08:45','09:00'].map(t=>`<option value="${t}" ${String(r.setup_arrival_time||'').slice(0,5)===t?'selected':''}>${timeLabel(t)}</option>`).join('')}</select></label><button data-save-setup>Save setup check-in</button>`:`<p class="note">Online check-in is closed for this market. It closed 24 hours before the market.</p>`}${r.setup_arrival_time?`<p><strong>Your selected arrival:</strong> ${timeLabel(r.setup_arrival_time)}</p>`:''}</article>`).join('')}</div>`;
   box.querySelectorAll('[data-save-setup]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-setup-booking]'),sel=card.querySelector('[data-setup-time]');if(!sel.value){notice('Choose a setup arrival time first.');return;}btn.disabled=true;btn.textContent='Saving…';try{await api(false,{booking_id:card.dataset.setupBooking,arrival_time:sel.value});notice('Setup check-in saved for '+timeLabel(sel.value)+'.');box.remove();await addVendorCheckin();}catch(e){notice(e.message);btn.disabled=false;btn.textContent='Save setup check-in';}});
  }catch(e){box.innerHTML='<h2 style="font-size:28px">Online Setup Check-In</h2><p class="note">'+esc(e.message)+'</p>';}
 }

 async function renderAdminCheckin(){
  const panel=document.querySelector('#panel');if(!panel)return;
  panel.innerHTML='<section class="card"><h2>Online Vendor Setup Check-In</h2><p>Loading vendor responses…</p></section>';
  try{
   const {rows=[]}=await api(true);const dates=[...new Map(rows.map(r=>[String(r.event_id),r])).values()];
   panel.innerHTML=`<section class="card"><h2>Online Vendor Setup Check-In</h2><p>Vendors choose an arrival time of 8:15, 8:30, 8:45, or 9:00 AM. Check-in closes automatically 24 hours before each market.</p>${dates.length?`<label>Market date<select id="online-checkin-date">${dates.map(r=>`<option value="${esc(r.event_id)}">${nice(r.date)} — ${esc(r.market_name||r.title||'Crafters Market')}</option>`).join('')}</select></label><div id="online-checkin-list"></div>`:'<p class="muted">No upcoming vendor bookings found.</p>'}</section>`;
   const draw=()=>{const id=document.querySelector('#online-checkin-date')?.value,target=document.querySelector('#online-checkin-list');if(!target)return;const selected=rows.filter(r=>String(r.event_id)===id),checked=selected.filter(r=>r.setup_arrival_time).length;target.innerHTML=`<p><strong>${checked} of ${selected.length}</strong> vendors checked in online.</p><div class="list">${selected.map(r=>`<article class="card"><div class="rowhead"><div><h3>${esc(r.business||r.name)}</h3><p>${esc(r.name||'')} · ${esc(r.email||'')}<br>${esc(r.space||'')} · ${esc(r.status||'')}</p></div><span class="tag ${r.setup_arrival_time?'':'held'}">${r.setup_arrival_time?timeLabel(r.setup_arrival_time):'Not checked in'}</span></div>${r.setup_checkin_at?`<small>Submitted ${new Date(r.setup_checkin_at).toLocaleString()}</small>`:''}</article>`).join('')||'<p class="muted">No vendors for this date.</p>'}</div>`;};
   document.querySelector('#online-checkin-date')?.addEventListener('change',draw);draw();
  }catch(e){panel.innerHTML='<section class="card"><h2>Online Vendor Setup Check-In</h2><p class="note">'+esc(e.message)+'</p></section>';}
 }

 function addAdminTab(){
  if(location.hash!=='#admin')return;
  const app=document.querySelector('#app'),tabs=app?.querySelector('.tabs');if(!tabs||tabs.querySelector('[data-online-checkin]'))return;
  const b=document.createElement('button');b.type='button';b.dataset.onlineCheckin='1';b.textContent='Online Check-In';
  b.onclick=()=>{tabs.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');renderAdminCheckin();};
  const setup=[...tabs.querySelectorAll('button')].find(x=>/setup/i.test(x.textContent));if(setup)setup.insertAdjacentElement('afterend',b);else tabs.appendChild(b);
 }

 let busy=false;const refresh=()=>{if(busy)return;busy=true;queueMicrotask(()=>{busy=false;addAdminTab();addVendorCheckin();});};
 new MutationObserver(refresh).observe(document.documentElement,{childList:true,subtree:true});
 window.addEventListener('hashchange',()=>setTimeout(refresh,50));
 document.addEventListener('DOMContentLoaded',refresh);refresh();
})();
