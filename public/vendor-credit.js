// Vendor cancellation credits: organizer issuance + vendor self-service redemption.
(function(){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0)/100);
 const nice=d=>{const s=String(d||'').slice(0,10),m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return s;return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'}).format(new Date(Date.UTC(+m[1],+m[2]-1,+m[3],17)));};
 const authHeader=()=>{const t=sessionStorage.getItem('market-token');return t?{Authorization:'Bearer '+t}:{}};
 const api=async payload=>{const r=await fetch('/.netlify/functions/vendor-credit',{method:'POST',headers:{...authHeader(),'Content-Type':'application/json'},body:JSON.stringify(payload)});const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Could not process vendor credit.');return v;};
 let mePromise=null,sourcesPromise=null,accountLoading=false;
 // Never cache a failed/anonymous identity or a rejected sources fetch.
 // This script runs at page parse — usually BEFORE the organizer signs in
 // (sign-in is an in-page flow, no reload) — so the first me() call goes out
 // with no token and fails. Caching that null (or a rejected sources
 // promise) permanently disabled every credit control for the session,
 // while the other injector scripts, which have no async gate, kept
 // working. Only a successful result may stick.
 const me=()=>{if(!sessionStorage.getItem('market-token'))return Promise.resolve(null);return mePromise ||= fetch('/.netlify/functions/api?action=me',{headers:authHeader()}).then(r=>r.ok?r.json():null).then(u=>{if(!u)mePromise=null;return u;}).catch(()=>{mePromise=null;return null;});};
 async function sources(force=false){if(force)sourcesPromise=null;if(!sourcesPromise){const p=api({action:'admin-sources'}).then(v=>v.sources||[]);p.catch(()=>{if(sourcesPromise===p)sourcesPromise=null;});sourcesPromise=p;}return sourcesPromise;}
 const key=(id,imported)=>(imported?'i:':'b:')+id;

 async function issue(id,imported,button){
  const preview=await api({action:'preview',id,imported});let amount=Number(preview.source?.paid_amount||0),extra={};
  if(amount<=0){const raw=prompt('No paid amount is stored for this booking. Enter the amount actually paid in dollars:');if(raw===null)return;const cents=Math.round(Number(raw)*100);if(!Number.isFinite(cents)||cents<=0){alert('Enter a valid paid amount.');return;}extra.amount=cents;amount=cents;}
  if(!confirm('Issue '+money(amount)+' credit and cancel/release this market spot?\n\nThe vendor will be able to choose another available date online.'))return;
  const old=button?.textContent;if(button){button.disabled=true;button.textContent='Issuing…';}
  try{await api({action:'issue',id,imported,...extra});await sources(true);alert('Credit issued. The old spot and category were released, and the vendor can apply the credit from My Bookings.');location.reload();}
  catch(e){alert(e.message);if(button){button.disabled=false;button.textContent=old;}}
 }

 async function enhanceAdmin(){
  const who=await me();if(!who?.admin)return;
  let list;try{list=await sources();}catch{return;}
  const byKey=new Map(list.map(x=>[key(x.id,x.imported),x]));
  document.querySelectorAll('.inspection-row .report-actions').forEach(actions=>{
   const anchor=actions.querySelector('[data-attendance-id]');if(!anchor||actions.querySelector('[data-issue-credit]'))return;
   const x=byKey.get(key(anchor.dataset.attendanceId,anchor.dataset.imported==='1'));if(!x)return;
   const b=document.createElement('button');b.type='button';b.className='secondary';b.dataset.issueCredit=x.id;b.dataset.imported=x.imported?'1':'0';
   if(x.credit_id){b.textContent='Credit Issued '+money(x.remaining_amount);b.disabled=true;}else b.textContent='Issue Credit'+(Number(x.amount)>0?' '+money(x.amount):'');
   actions.appendChild(b);
  });
  document.querySelectorAll('#vendor-directory article.card').forEach(card=>{
   if(card.querySelector('[data-credit-section]'))return;
   const text=card.textContent||'',email=(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]?.toLowerCase()||'',form=card.querySelector('form[data-vendor]'),vendorId=form?.dataset.vendor||'';
   const rows=list.filter(x=>(email&&String(x.email||'').toLowerCase()===email)||(!email&&(x.application_id===vendorId||x.id===vendorId)));if(!rows.length)return;
   const section=document.createElement('details');section.dataset.creditSection='1';
   section.innerHTML='<summary><strong>Cancellation Credits</strong></summary><p class="muted">Issue a reusable credit from a paid booking. Issuing it also cancels and releases that original spot.</p><div class="table-wrap"><table><thead><tr><th>Market date</th><th>Space</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(nice(x.event_date))+'</td><td>'+esc(x.space||'')+'</td><td>'+esc(Number(x.amount)>0?money(x.amount):'Amount not recorded')+'</td><td>'+esc(x.status||'')+'</td><td>'+(x.credit_id?'<span class="tag">Credit issued · '+esc(money(x.remaining_amount))+' left</span>':'<button type="button" class="secondary" data-issue-credit="'+esc(x.id)+'" data-imported="'+(x.imported?'1':'0')+'">Issue Credit</button>')+'</td></tr>').join('')+'</tbody></table></div>';
   const details=card.querySelector('details');if(details)details.insertAdjacentElement('afterend',section);else card.appendChild(section);
  });
 }

 async function enhanceAccount(){
  if(accountLoading||!document.querySelector('#app h1')?.textContent?.includes('My market bookings')||document.querySelector('[data-my-credits]'))return;
  accountLoading=true;
  try{
   const v=await api({action:'mine'}),credits=v.credits||[];if(!credits.length)return;
   const panel=document.createElement('section');panel.className='card';panel.dataset.myCredits='1';
   panel.innerHTML='<h2>Vendor Credits</h2><p>Use a cancellation credit to schedule yourself for another available market date. Applying a credit automatically approves the new booking, marks it paid, and reserves your category.</p><div class="list">'+credits.map(c=>{
    const options=(c.eligible_events||[]).flatMap(e=>e.spaces.map(s=>({value:e.id+'|'+s.space,label:nice(e.date)+' — '+(e.market_name||e.title||e.location)+' — '+(s.space==='indoor'?'Indoor':'Outdoor')+' '+money(s.price)})));
    return '<article class="card"><div class="rowhead"><div><h3>'+money(c.remaining_amount)+' available</h3><small>From '+esc(nice(c.source_date))+' · '+esc(c.category||'')+'</small></div><span class="tag '+esc(c.status)+'">'+esc(c.status)+'</span></div><p>Original credit: <strong>'+money(c.original_amount)+'</strong></p>'+(c.status==='available'&&Number(c.remaining_amount)>0?(options.length?'<form data-redeem-credit="'+esc(c.id)+'"><label>Choose a new market date<select name="choice" required><option value="">Select a date and space</option>'+options.map(o=>'<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>').join('')+'</select></label><button>Apply Credit</button></form><p class="small">Want a different date? <a href="#apply">Apply the normal way instead</a> — the organizer can compare your application and apply this credit to your booking manually.</p>':'<div class="note">There are no dates right now that have both your category and a booth space fully covered by this credit.</div><p>You can still apply for any market date the normal way: submit an application with your product photos, and the organizer can compare it and apply this credit to your booking manually.</p><p><a class="button" href="#apply">Apply for a market date instead</a></p>'):'<p class="muted">This credit has been fully used.</p>')+'</article>';
   }).join('')+'</div>';
   const heading=document.querySelector('#app h1');heading.parentElement.insertBefore(panel,heading.nextSibling);
   panel.querySelectorAll('[data-redeem-credit]').forEach(form=>form.onsubmit=async e=>{e.preventDefault();const val=new FormData(form).get('choice');if(!val)return;const [event_id,space]=String(val).split('|');if(!confirm('Apply this credit to the selected market date? The booking will be approved and marked paid immediately.'))return;const b=e.submitter,old=b.textContent;b.disabled=true;b.textContent='Applying…';try{const r=await api({action:'redeem',credit_id:form.dataset.redeemCredit,event_id,space});alert('Credit applied. Your new market booking is approved and paid'+(Number(r.remaining)>0?' and you still have '+money(r.remaining)+' credit remaining.':'.'));location.reload();}catch(err){alert(err.message);b.disabled=false;b.textContent=old;}});
  }catch(e){console.warn('Credit panel',e);}finally{accountLoading=false;}
 }

 document.addEventListener('click',e=>{const b=e.target.closest('[data-issue-credit]');if(!b||b.disabled)return;e.preventDefault();e.stopImmediatePropagation();issue(b.dataset.issueCredit,b.dataset.imported==='1',b);},true);
 const enhance=()=>{enhanceAdmin();enhanceAccount();};
 new MutationObserver(enhance).observe(document.documentElement,{childList:true,subtree:true});
 document.addEventListener('DOMContentLoaded',enhance);enhance();
})();