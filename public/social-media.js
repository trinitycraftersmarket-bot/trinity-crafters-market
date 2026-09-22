(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=()=>sessionStorage.getItem('market-token')||'';
 async function api(method='GET',body){
   const r=await fetch('/.netlify/functions/buffer-social',{
     method,
     headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},
     body:body?JSON.stringify(body):undefined
   });
   const v=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(v.error||'Buffer request failed.');
   return v;
 }
 function notice(msg){
   const n=document.querySelector('#notice')||document.querySelector('#buffer-status');
   if(n)n.textContent=msg;
 }
 function enhance(){
   const tab=document.querySelector('[data-tab="social"]');
   const panel=document.querySelector('#panel');
   const draft=document.querySelector('#draft');
   if(tab)tab.textContent='Social Media';
   if(!panel||!draft||panel.querySelector('#social-publisher'))return;
   const oldCopy=document.querySelector('#copy');
   if(oldCopy)oldCopy.textContent='Copy post';

   const box=document.createElement('section');
   box.id='social-publisher';
   box.className='card section';
   box.innerHTML='<span class="eyebrow">Buffer • Facebook + Instagram</span><h2>Social Media Center</h2><div id="buffer-status" class="note">Checking Buffer connection…</div><div id="buffer-channels"></div><label>Post image<input id="social-image-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label><div id="social-image-preview"></div><input id="social-media-url" type="hidden"><small>Choose a photo from your phone or computer. Instagram requires an image; Facebook can use text only or an image.</small><div class="two"><label>Schedule date & time<input id="social-when" type="datetime-local"></label><div><small>Leave blank to publish now.</small></div></div><div class="actions"><button id="social-publish">Post / Schedule</button><button id="social-copy" class="secondary">Copy post</button></div><hr><h3>Facebook Event</h3><p class="muted">Connect each market date to its Facebook Event once. Then you can open that Event with the post already copied and paste it into the Event discussion.</p><label>Market date<select id="facebook-event-date"></select></label><label>Facebook Event URL<input id="facebook-event-url" type="url" placeholder="https://www.facebook.com/events/..."></label><div class="actions"><button id="save-facebook-event" class="secondary">Save Event Link</button><button id="open-facebook-event">Copy Post & Open Event</button></div><p class="muted">Posts are sent securely from the website to Buffer. Your Buffer API key never reaches the browser.</p>';
   panel.appendChild(box);

   api().then(v=>{
     const channels=(v.channels||[]).filter(c=>/^(facebook|instagram)$/i.test(c.service||'')&&!c.locked&&!c.disconnected);
     if(!channels.length)throw Error('Buffer is connected, but no active Facebook or Instagram channels were returned.');
     document.querySelector('#buffer-status').innerHTML='<strong>Buffer connected.</strong> Choose Facebook, Instagram, or both.';
     document.querySelector('#buffer-channels').innerHTML='<div class="two">'+channels.map(c=>'<label class="check"><input class="buffer-channel" type="checkbox" value="'+esc(c.id)+'" data-service="'+esc(c.service)+'" checked> '+esc(c.name)+' <small>('+esc(c.service)+')</small></label>').join('')+'</div>';
     const events=v.events||[];
     const eventSelect=document.querySelector('#facebook-event-date');
     eventSelect.innerHTML='<option value="">Choose a market date</option>'+events.map(e=>'<option value="'+esc(e.id)+'" data-url="'+esc(e.facebook_event_url||'')+'">'+esc((()=>{const raw=String(e.date||'').slice(0,10),parts=raw.split('-');if(parts.length!==3)return raw||'Date unavailable';return new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2]),12).toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'});})())+(e.title?' — '+esc(e.title):'')+'</option>').join('');
     eventSelect.onchange=()=>{const o=eventSelect.selectedOptions[0];document.querySelector('#facebook-event-url').value=o?.dataset.url||'';};
   }).catch(e=>{
     document.querySelector('#buffer-status').textContent=e.message;
   });

   document.querySelector('#social-image-file').onchange=async(e)=>{
     const file=e.target.files?.[0]; if(!file)return;
     const preview=document.querySelector('#social-image-preview');
     preview.textContent='Uploading image…';
     try{
       const form=new FormData(); form.append('image',file);
       const r=await fetch('/.netlify/functions/buffer-social',{method:'POST',headers:{Authorization:'Bearer '+token()},body:form});
       const v=await r.json().catch(()=>({}));
       if(!r.ok)throw Error(v.error||'Image upload failed.');
       document.querySelector('#social-media-url').value=v.url;
       preview.innerHTML='<img src="'+esc(v.url)+'" alt="Selected post image" style="max-width:100%;max-height:280px;border-radius:12px;margin:10px 0">';
     }catch(err){preview.textContent=err.message;}
   };

   document.querySelector('#save-facebook-event').onclick=async()=>{
     try{
       const sel=document.querySelector('#facebook-event-date'), eventId=sel.value, url=document.querySelector('#facebook-event-url').value.trim();
       if(!eventId)throw Error('Choose a market date.');
       if(!url)throw Error('Paste the Facebook Event link first.');
       await api('POST',{action:'saveFacebookEvent',eventId,url});
       sel.selectedOptions[0].dataset.url=url;
       notice('Facebook Event link saved.');
     }catch(e){notice(e.message);}
   };
   document.querySelector('#open-facebook-event').onclick=async()=>{
     try{
       const sel=document.querySelector('#facebook-event-date'), url=document.querySelector('#facebook-event-url').value.trim();
       if(!sel.value)throw Error('Choose a market date.');
       if(!url)throw Error('Save the Facebook Event link for this date first.');
       const postText=draft.value;
       if(!postText.trim())throw Error('Write or generate the post first.');
       try{
         await navigator.clipboard.writeText(postText);
       }catch{
         throw Error('Your browser blocked copying. Tap Copy post first, then open the Facebook Event.');
       }
       window.open(url,'_blank','noopener');
       notice('Post copied and Facebook opened. Tap “Say something…” and choose Paste.');
     }catch(e){notice(e.message);}
   };

   document.querySelector('#social-copy').onclick=async()=>{
     try{
       if(!draft.value.trim())throw Error('Write or generate the post first.');
       await navigator.clipboard.writeText(draft.value);
       notice('Post copied.');
     }catch(e){notice(e.message||'Your browser blocked copying.');}
   };

   document.querySelector('#social-publish').onclick=async()=>{
     const button=document.querySelector('#social-publish');
     try{
       const selected=[...document.querySelectorAll('.buffer-channel:checked')];
       const channels=selected.map(x=>({id:x.value,service:x.dataset.service}));
       const ids=channels.map(x=>x.id);
       const media=document.querySelector('#social-media-url').value.trim();
       const dt=document.querySelector('#social-when').value;
       if(!ids.length)throw Error('Choose Facebook, Instagram, or both.');
       if(selected.some(x=>x.dataset.service==='instagram')&&!media)throw Error('Instagram requires an image. Choose a photo above.');
       if(dt&&new Date(dt).getTime()<Date.now()+5*60*1000)throw Error('Scheduled time must be at least 5 minutes from now.');
       if(!confirm(dt?'Schedule this post in Buffer?':'Publish this post now through Buffer?'))return;
       button.disabled=true;
       const result=await api('POST',{
         text:draft.value,
         media,
         channels,
         dateTime:dt?new Date(dt).toISOString():null
       });
       if(result.partial){
         notice('Post created on some channels. '+(result.failed||[]).map(x=>x.error).join(' | '));
       }else{
         notice(dt?'Post scheduled successfully in Buffer.':'Post sent to Buffer for publishing.');
       }
     }catch(e){
       notice(e.message);
     }finally{
       button.disabled=false;
     }
   };
 }
 new MutationObserver(()=>setTimeout(enhance,0)).observe(document.body,{childList:true,subtree:true});
 document.addEventListener('click',e=>{if(e.target.closest?.('[data-tab="social"]'))setTimeout(enhance,80);});
 setTimeout(enhance,200);
})();
