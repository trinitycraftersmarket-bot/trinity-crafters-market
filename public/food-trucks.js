(()=>{const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const token=()=>sessionStorage.getItem('market-token');async function api(method='',body=null,admin=false){const u='/.netlify/functions/food-trucks'+(admin?'?admin=1':'');const r=await fetch(u,{method:method||'GET',headers:{...(token()?{Authorization:'Bearer '+token()}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||'Request failed.');return v;}const date=x=>new Date(String(x).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'});
function nav(){const n=document.querySelector('header nav');if(n&&!n.querySelector('[href="#food-trucks"]')){const a=document.createElement('a');a.href='#food-trucks';a.textContent='Food Trucks';n.insertBefore(a,n.querySelector('.admin-link'));}}
async function publicPage(){
  if(location.hash!=='#food-trucks')return;
  const app=document.querySelector('#app');
  if(!app)return;
  app.innerHTML='<section class="card"><h1>Food Truck Application</h1><p>Loading available dates…</p></section>';
  try{
    const d=await api();
    const avail=(d.events||[]).filter(e=>e.available);
    app.innerHTML=`<section class="card"><h1>Food Truck Application</h1><p>Each market date has <strong>one food truck space for $35</strong>. Applications are reviewed before approval and payment.</p>${avail.length?`<form id="food-truck-form">
      <fieldset><legend>Market dates</legend><p>Select every date you would like to attend. You only need to submit this application once.</p>
      <div class="list">${avail.map(e=>`<label class="check card"><input type="checkbox" name="event_id" value="${esc(e.id)}"> <span><strong>${date(e.date)}</strong><br><small>${esc(e.market_name||e.title||e.location)} · $35</small></span></label>`).join('')}</div></fieldset>
      <div class="grid2"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Phone<input name="phone" type="tel" required></label><label>Billing address<input name="billing_address" required></label></div>
      <label>What type of food do you have?<textarea name="food_type" required></textarea></label>
      <div class="grid2"><label>Is your rig wrapped? <small>(A wrapped rig helps attract customers.)</small><select name="wrapped"><option value="yes">Yes</option><option value="no">No</option></select></label><label>Do you use propane?<select name="propane"><option value="no">No</option><option value="yes">Yes</option></select></label></div>
      <label>How big is your rig?<input name="rig_size" placeholder="Example: 20 ft long × 8 ft wide" required></label>
      <label class="check"><input type="checkbox" name="permits" required> I have the proper permits required to operate.</label>
      <label class="check"><input type="checkbox" name="insurance" required> I have current insurance.</label>
      <div class="note"><strong>Photos:</strong> Upload 1 required picture of your rig and up to 4 additional food/menu photos. Maximum 10 MB per photo.</div>
      <label>Rig photo (required)<input name="rig_photo" type="file" accept="image/*" required></label>
      <label>Food/menu photos (up to 4)<input name="food_photos" type="file" accept="image/*" multiple></label>
      <div class="total" id="food-truck-total">Select at least one market date · Estimated invoice total: $0.00</div>
      <button>Submit Food Truck Application</button>
    </form>`:'<div class="note"><strong>All currently listed food truck dates are filled.</strong></div>'}</section>`;

    const f=document.querySelector('#food-truck-form');
    if(!f)return;
    const updateTotal=()=>{
      const n=f.querySelectorAll('[name="event_id"]:checked').length;
      const box=document.querySelector('#food-truck-total');
      if(box)box.textContent=(n?n+' market date'+(n===1?'':'s')+' selected':'Select at least one market date')+' · Estimated invoice total: $'+(n*35).toFixed(2);
    };
    f.querySelectorAll('[name="event_id"]').forEach(x=>x.addEventListener('change',updateTotal));
    updateTotal();

    f.onsubmit=async e=>{
      e.preventDefault();
      const event_ids=[...f.querySelectorAll('[name="event_id"]:checked')].map(x=>x.value);
      if(!event_ids.length){alert('Select at least one market date.');return;}
      const rig=f.rig_photo.files[0],foods=[...f.food_photos.files];
      if(!rig)return;
      if(foods.length>4){alert('Choose no more than 4 food/menu photos.');return;}
      const files=[rig,...foods];
      if(files.some(x=>x.size>10485760)){alert('Each photo must be 10 MB or smaller.');return;}
      const read=x=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res({name:x.name,size:x.size,type:x.type,data:r.result});r.onerror=rej;r.readAsDataURL(x);});
      const photos=[];
      for(let i=0;i<files.length;i++){const x=await read(files[i]);x.rig=i===0;photos.push(x);}
      const fd=new FormData(f),p=Object.fromEntries(fd.entries());
      p.event_ids=event_ids;
      delete p.event_id;delete p.rig_photo;delete p.food_photos;
      p.wrapped=p.wrapped==='yes';p.propane=p.propane==='yes';p.permits=f.permits.checked;p.insurance=f.insurance.checked;p.photos=photos;
      const b=f.querySelector('button');
      try{
        b.disabled=true;
        await api('POST',p);
        app.innerHTML='<section class="card"><h1>Application Received</h1><p>Thank you. Your food truck application has been submitted for review. Check your email for confirmation.</p></section>';
      }catch(x){alert(x.message);}
      finally{b.disabled=false;}
    };
  }catch(e){
    app.innerHTML=`<section class="card"><h1>Food Truck Application</h1><div class="note">${esc(e.message)}</div></section>`;
  }
}
function adminTab(){if(location.hash!=='#admin')return;const tabs=document.querySelector('.tabs'),panel=document.querySelector('#panel');if(!tabs||!panel||tabs.querySelector('[data-food-trucks]'))return;const b=document.createElement('button');b.textContent='Food Trucks';b.dataset.foodTrucks='1';tabs.appendChild(b);b.onclick=async()=>{tabs.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');panel.innerHTML='<p>Loading food truck applications…</p>';try{const d=await api('GET',null,true);panel.innerHTML=`<h2>Food Trucks</h2><p>One $35 food truck spot is available per market date.</p>${d.applications.length?d.applications.map(x=>`<article class="card"><div class="rowhead"><div><h3>${esc(x.name)}</h3><p>${date(x.date)} · ${esc(x.market_name||x.title||x.location)}</p></div><span class="tag">${esc(x.status)}</span></div><p><strong>Food:</strong> ${esc(x.food_type)}</p>${x.approved_products?`<p><strong>Approved for:</strong> ${esc(x.approved_products)}<br><strong>Not approved for:</strong> ${esc(x.declined_products||'None')}</p>`:''}${x.decision_reason?`<div class="note"><strong>Decline reason:</strong> ${esc(x.decision_reason)}</div>`:''}<p><strong>Phone:</strong> ${esc(x.phone)} · <strong>Email:</strong> ${esc(x.email)}</p><p><strong>Billing:</strong> ${esc(x.billing_address)}</p><p><strong>Rig:</strong> ${esc(x.rig_size)} · Wrapped: ${x.wrapped?'Yes':'No'} · Propane: ${x.propane?'Yes':'No'}</p><p>Permits: ${x.permits?'Yes':'No'} · Insurance: ${x.insurance?'Yes':'No'} · Photos: ${(x.photos||[]).length}</p><div class="actions"><button data-ft="approved" data-id="${x.id}">Approve</button><button data-ft="declined" data-id="${x.id}" class="quiet">Decline</button><button data-ft="paid" data-id="${x.id}">Mark Paid $35</button></div></article>`).join(''):'<p>No food truck applications yet.</p>'}`;panel.querySelectorAll('[data-ft]').forEach(btn=>btn.onclick=async()=>{const row=d.applications.find(x=>x.id===btn.dataset.id),status=btn.dataset.ft,p={id:btn.dataset.id,status};if(status==='approved'){const approved=prompt('APPROVED FOR\n\nConfirm or edit what this food truck is approved to sell:',row.food_type||'');if(approved===null)return;if(!approved.trim()){alert('Enter what this food truck is approved to sell.');return;}const excluded=prompt('NOT APPROVED FOR\n\nList anything they may NOT sell. Leave blank if none:','');if(excluded===null)return;p.approved_products=approved;p.declined_products=excluded;}if(status==='declined'){const reason=prompt('REASON FOR DECLINING\n\nWhy is this food truck application being declined?','');if(reason===null)return;if(!reason.trim()){alert('A decline reason is required.');return;}p.reason=reason;}try{await api('PATCH',p);b.click();}catch(e){alert(e.message);}});}catch(e){panel.innerHTML=`<div class="note">${esc(e.message)}</div>`;}};}
const route=()=>{nav();if(location.hash==='#food-trucks')publicPage();setTimeout(adminTab,150)};window.addEventListener('hashchange',route);new MutationObserver(()=>{nav();adminTab();}).observe(document.documentElement,{childList:true,subtree:true});route();})();