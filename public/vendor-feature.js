// Featured Vendor Facebook post helper for organizer application review.
// Uses the vendor's submitted application details and photos already shown in the review modal.
(function(){
 const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const text=el=>(el?.textContent||'').replace(/\s+/g,' ').trim();
 function findValue(root,label){
   const nodes=[...root.querySelectorAll('h2,h3,h4,strong,p')];
   const hit=nodes.find(n=>text(n).toLowerCase().startsWith(label.toLowerCase()));
   if(!hit)return '';
   let value=text(hit).replace(new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[:\\s]*','i'),'').trim();
   if(value&&value.toLowerCase()!==label.toLowerCase())return value;
   return text(hit.nextElementSibling);
 }
 function vendorInfo(root){
   const heads=[...root.querySelectorAll('h2,h3')].map(text).filter(Boolean);
   const business=heads.find(x=>!/application|review|vendor messages|accepted agreements|billing address|exception request/i.test(x))||'';
   const body=text(root);
   const description=findValue(root,'What they sell')||findValue(root,'Products')||findValue(root,'Description')||((body.match(/What (?:they|do you) sell\??\s*([^]*?)(?:Billing address|How they heard|Exception request)/i)||[])[1]||'').trim();
   const category=findValue(root,'Category');
   return {business,description,category};
 }
 function draft(info){
   const products=(info.description||info.category||'handmade products').replace(/\s+/g,' ').trim();
   return `🌟 FEATURED VENDOR SPOTLIGHT 🌟\n\nMeet ${info.business||'one of our talented local vendors'}! 🛍️\n\n${info.business||'This local maker'} will be joining us at Trinity Crafters Market with ${products}. Come meet the maker, see their creations in person, and support a local small business!\n\n📍 Trinity Crafters Market\n🛍️ Shop local • Support small businesses • Meet local makers\n\nFollow our page for more featured vendors and upcoming market dates.\n\n#TrinityCraftersMarket #FeaturedVendor #ShopLocal #SupportSmallBusiness #LocalMakers #PascoCounty #OdessaFL #LutzFL`;
 }
 function enhance(){
   const root=document.querySelector('#modal-content'); if(!root||root.dataset.vendorFeatureReady==='1')return;
   const photos=root.querySelector('.photos');
   if(!photos)return;
   root.dataset.vendorFeatureReady='1';
   const info=vendorInfo(root),box=document.createElement('section');box.className='card';box.style.marginTop='20px';
   box.innerHTML=`<h3>Featured Vendor Facebook Post</h3><p class="muted">Create a ready-to-edit spotlight using this vendor's application details. Their submitted photos are shown above so you can choose the best images for the Facebook post.</p><button type="button" id="generate-vendor-feature">Generate Featured Vendor Post</button><div id="vendor-feature-output" hidden style="margin-top:16px"><label>Facebook post<textarea id="vendor-feature-text" rows="14"></textarea></label><div class="actions"><button type="button" id="copy-vendor-feature">Copy Post</button><button type="button" class="secondary" id="regenerate-vendor-feature">Regenerate</button></div></div>`;
   photos.parentElement.insertBefore(box,photos.nextSibling);
   const make=()=>{const area=box.querySelector('#vendor-feature-text');area.value=draft(vendorInfo(root));box.querySelector('#vendor-feature-output').hidden=false;};
   box.querySelector('#generate-vendor-feature').onclick=make;box.querySelector('#regenerate-vendor-feature').onclick=make;
   box.querySelector('#copy-vendor-feature').onclick=async()=>{const v=box.querySelector('#vendor-feature-text').value;try{await navigator.clipboard.writeText(v);box.querySelector('#copy-vendor-feature').textContent='Copied!';setTimeout(()=>box.querySelector('#copy-vendor-feature').textContent='Copy Post',1500);}catch{box.querySelector('#vendor-feature-text').select();document.execCommand('copy');}};
 }
 new MutationObserver(enhance).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',enhance);
})();
