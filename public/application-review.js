(()=>{
 const token=()=>sessionStorage.getItem('market-token');
 const headers=()=>({Authorization:'Bearer '+token(),'Content-Type':'application/json'});
 async function save(id,approved,declined){
  const r=await fetch('/.netlify/functions/application-review',{method:'POST',headers:headers(),body:JSON.stringify({id,approved_products:approved,declined_products:declined})});
  const v=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(v.error||'Could not save approval details.');
  return v;
 }
 async function approve(id){
  const r=await fetch('/.netlify/functions/api?action=booking',{method:'POST',headers:headers(),body:JSON.stringify({id,status:'approved',exception:false})});
  const v=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(v.error||'Could not approve this booking.');
  if(v.invoice_error)throw Error('The vendor was approved, but the PayPal invoice could not be sent: '+v.invoice_error+' Refresh the page before trying anything else.');
  return v;
 }
 function disclosedProducts(button){
  const details=button.closest('.card')?.querySelector('[data-review]');
  if(!details)return '';
  details.click();
  const text=document.querySelector('#modal-content .details')?.textContent?.trim()||'';
  document.querySelector('#modal')?.close();
  return text;
 }
 document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-status="approved"][data-id]');
  if(!b)return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const selling=disclosedProducts(b);
  const approved=prompt('APPROVED FOR\n\nConfirm or edit what this vendor is approved to sell:',selling);
  if(approved===null)return;
  if(!approved.trim()){alert('Enter what this vendor is approved to sell.');return;}
  const notApproved=prompt('NOT APPROVED FOR\n\nList anything this vendor may NOT sell. Leave blank if there are no exclusions:','');
  if(notApproved===null)return;
  const original=b.textContent;
  try{
   b.disabled=true;
   b.textContent='Approving…';
   await save(b.dataset.id,approved.trim(),notApproved.trim());
   const result=await approve(b.dataset.id);
   if(result.invoiced){
    alert('Approved. The approved products were saved, the PayPal invoice was sent, and this booking is now HELD until payment is recorded.');
   }else{
    alert('Approved products were saved and the booking was approved. PayPal is not configured, so no payment hold was started.');
   }
   location.reload();
  }catch(x){
   alert(x.message);
   b.disabled=false;
   b.textContent=original;
  }
 },true);
})();