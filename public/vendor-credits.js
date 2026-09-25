// Vendor cancellation credits: organizer issue controls + vendor self-service redemption.
(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0)/100);
  const nice=d=>{const s=String(d||'').slice(0,10);return new Date(s+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'});};
  const token=()=>sessionStorage.getItem('market-token');
  const notice=s=>{const n=document.querySelector('#notice');if(n)n.textContent=s;};
  const modal=(html)=>{const d=document.querySelector('#modal'),root=document.querySelector('#modal-content');if(!d||!root)return;root.innerHTML=html;d.showModal();};
  async function api(action,body){
    const r=await fetch('/.netlify/functions/vendor-credits?action='+encodeURIComponent(action),{
      method:body===undefined?'GET':'POST',
      headers:{...(token()?{Authorization:'Bearer '+token()}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const v=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(v.error||'Could not process vendor credit.');
    return v;
  }
  let mePromise=null;
  async function me(){
    if(!token())return null;
    if(!mePromise)mePromise=fetch('/.netlify/functions/api?action=me',{headers:{Authorization:'Bearer '+token()}})
      .then(async r=>r.ok?r.json():null).catch(()=>null);
    return mePromise;
  }

  async function issueExact(sourceType,sourceId){
    const preview=await api('preview',{source_type:sourceType,source_id:sourceId});
    if(preview.already_issued){
      const c=preview.credit;
      notice('Credit already issued. Remaining balance: '+money(c.remaining_amount)+'.');
      return;
    }
    if(!preview.can_issue)throw Error(preview.reason||'This booking is not eligible for a credit.');
    const s=preview.source;
    if(!confirm('Issue a '+money(preview.amount)+' vendor credit for '+(s.business||s.name||'this vendor')+'?\n\nOriginal market: '+nice(s.date)+'\n\nThis will cancel the original booking and release its booth and category inventory.'))return;
    const r=await api('issue',{source_type:sourceType,source_id:sourceId});
    notice('Credit issued for '+money(r.credit.original_amount)+'. The vendor can apply it from My Bookings.');
    location.reload();
  }

  async function openVendorSources(recordId){
    const rows=await api('vendor-sources',{record_id:recordId});
    if(!rows.length){notice('No paid booking is available to credit for this vendor.');return;}
    const eligible=rows.filter(x=>x.can_issue);
    modal(`<h2>Issue Vendor Credit</h2>
      <p>Select the paid market booking being cancelled. The credit will equal the recorded paid amount.</p>
      <form id="vendor-credit-source-form">
        <div class="list">${rows.map((x,i)=>{
          const s=x.source,c=x.credit;
          return `<label class="card check" style="display:block">
            ${x.can_issue?`<input type="radio" name="source" value="${esc(s.source_type+'|'+s.source_id)}" ${i===0?'checked':''}>`:''}
            <strong>${esc(s.business||s.name||'Vendor')}</strong><br>
            ${nice(s.date)} · ${esc(s.location||'')} · ${esc(String(s.space||'').toUpperCase())}<br>
            <strong>${x.can_issue?money(x.amount):'Credit already issued'}</strong>
            ${c?`<br><small>Remaining credit: ${money(c.remaining_amount)}</small>`:''}
          </label>`;
        }).join('')}</div>
        <div class="actions">
          <button ${eligible.length?'':'disabled'}>Issue Selected Credit</button>
          <button type="button" class="secondary" id="cancel-credit-source">Cancel</button>
        </div>
      </form>`);
    const form=document.querySelector('#vendor-credit-source-form');
    if(!form)return;
    document.querySelector('#cancel-credit-source').onclick=()=>document.querySelector('#modal')?.close();
    form.onsubmit=async e=>{
      e.preventDefault();
      const value=new FormData(form).get('source');
      if(!value)return;
      const [type,id]=String(value).split('|');
      document.querySelector('#modal')?.close();
      try{await issueExact(type,id);}catch(err){notice(err.message);}
    };
  }

  async function enhanceAdmin(){
    const who=await me();
    if(!who?.admin)return;
    document.querySelectorAll('.inspection-row .report-actions').forEach(actions=>{
      const anchor=actions.querySelector('[data-attendance-id]');
      if(!anchor||actions.querySelector('[data-issue-credit]'))return;
      const b=document.createElement('button');
      b.type='button';b.className='secondary';b.textContent='Issue Credit';
      b.dataset.issueCredit=anchor.dataset.attendanceId;
      b.dataset.imported=anchor.dataset.imported||'0';
      actions.appendChild(b);
    });
    document.querySelectorAll('#vendor-directory article.card').forEach(card=>{
      const form=card.querySelector('form[data-vendor]');
      if(!form||card.querySelector('[data-vendor-credit]'))return;
      let actions=card.querySelector('.actions');
      if(!actions){actions=document.createElement('div');actions.className='actions';form.insertAdjacentElement('beforebegin',actions);}
      const b=document.createElement('button');
      b.type='button';b.className='secondary';b.textContent='Issue Credit';
      b.dataset.vendorCredit=form.dataset.vendor;
      actions.appendChild(b);
    });
  }

  let walletLoading=false;
  async function enhanceWallet(){
    if(walletLoading||!token()||!location.hash.startsWith('#account'))return;
    const h=[...document.querySelectorAll('#app h1')].find(x=>/my market bookings/i.test(x.textContent||''));
    const root=document.querySelector('#app');
    if(!h||!root||root.querySelector('#vendor-credit-wallet')||root.dataset.creditWalletLoaded==='1')return;
    walletLoading=true;
    try{
      const credits=await api('list');
      const section=document.createElement('section');
      section.id='vendor-credit-wallet';
      section.className='section';
      if(!credits.length){
        section.innerHTML='';
        root.dataset.creditWalletLoaded='1';
        return;
      }
      section.innerHTML=`<div class="card"><div class="rowhead"><div><span class="eyebrow">Vendor Credits</span><h2>Your available market credit</h2></div></div>
        <p>Choose a different available market date. Applying a credit immediately confirms the booking, marks it paid, and reserves your category and booth inventory.</p>
        <div class="list">${credits.map(c=>{
          const available=c.status==='available'&&Number(c.remaining_amount)>0;
          const opts=c.options||[];
          return `<article class="card">
            <div class="rowhead"><div><h3>${money(c.remaining_amount)} ${available?'available':'used'}</h3><small>Issued from ${nice(c.source_date)} · ${esc(c.source_location||'')}</small></div><span class="tag ${available?'paid':''}">${available?'CREDIT AVAILABLE':'USED'}</span></div>
            <p><strong>Category:</strong> ${esc(c.category||'')}<br><strong>Original credit:</strong> ${money(c.original_amount)}</p>
            ${available?opts.length?`<label>New market date & space<select data-credit-option="${esc(c.id)}">${opts.map(o=>`<option value="${esc(o.event_id+'|'+o.space)}">${nice(o.date)} — ${esc(o.market_name||o.location||'Market')} — ${o.space==='indoor'?'Indoor':'Outdoor'} — ${money(o.price)}</option>`).join('')}</select></label><button data-redeem-credit="${esc(c.id)}">Apply Credit</button>`:`<div class="note">No future booth currently meets all three requirements: your category is open, booth inventory is available, and this credit fully covers the booth price.</div>`:''}
          </article>`;
        }).join('')}</div>
      </div>`;
      h.insertAdjacentElement('afterend',section);
    }catch(e){
      if(!/sign in/i.test(e.message))notice(e.message);
    }finally{walletLoading=false;}
  }

  document.addEventListener('click',async e=>{
    const issue=e.target.closest('[data-issue-credit]');
    if(issue){
      e.preventDefault();e.stopImmediatePropagation();
      issue.disabled=true;
      try{await issueExact(issue.dataset.imported==='1'?'imported':'booking',issue.dataset.issueCredit);}
      catch(err){notice(err.message);issue.disabled=false;}
      return;
    }
    const vendor=e.target.closest('[data-vendor-credit]');
    if(vendor){
      e.preventDefault();e.stopImmediatePropagation();
      vendor.disabled=true;
      try{await openVendorSources(vendor.dataset.vendorCredit);}
      catch(err){notice(err.message);}
      finally{vendor.disabled=false;}
      return;
    }
    const redeem=e.target.closest('[data-redeem-credit]');
    if(redeem){
      e.preventDefault();e.stopImmediatePropagation();
      const select=document.querySelector('[data-credit-option="'+CSS.escape(redeem.dataset.redeemCredit)+'"]');
      if(!select?.value)return;
      const [eventId,space]=select.value.split('|'),label=select.options[select.selectedIndex]?.textContent||'selected market';
      if(!confirm('Apply this credit to:\n\n'+label+'\n\nThis will immediately confirm the booking, mark it paid, and reserve your category.'))return;
      redeem.disabled=true;redeem.textContent='Applying…';
      try{
        const r=await api('redeem',{credit_id:redeem.dataset.redeemCredit,event_id:eventId,space});
        notice('Credit applied. Your new booking is confirmed and paid'+(r.remaining>0?' · '+money(r.remaining)+' credit remains.':'.'));
        location.reload();
      }catch(err){notice(err.message);redeem.disabled=false;redeem.textContent='Apply Credit';}
    }
  },true);

  function enhance(){enhanceWallet();enhanceAdmin();}
  new MutationObserver(enhance).observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('hashchange',()=>{mePromise=null;setTimeout(enhance,0);});
  document.addEventListener('DOMContentLoaded',enhance);
  enhance();
})();
