(()=> {
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=()=>sessionStorage.getItem('market-token');
 const api=async(action,body)=>{const r=await fetch('/.netlify/functions/live-chat?action='+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Request failed');return v};
 let active=null,refreshTimer=null;
 function stamp(d){return d?new Date(d).toLocaleString():''}
 function install(){
  if(location.hash!=='#admin')return;
  const tabs=document.querySelector('.tabs'),panel=document.querySelector('#panel');if(!tabs||!panel)return;
  let b=tabs.querySelector('[data-live-chat-admin]');
  if(!b){b=document.createElement('button');b.textContent='Live Chat';b.dataset.liveChatAdmin='1';b.onclick=()=>open(panel,b,tabs);const vendors=tabs.querySelector('[data-tab="vendors"]');vendors?vendors.after(b):tabs.appendChild(b);}
 }
 async function open(panel,b,tabs){
  tabs.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');active={panel,b,tabs};
  panel.innerHTML='<section class="card"><h2>Live Chat</h2><p>Loading conversations…</p></section>';
  try{const d=await api('admin-dashboard');renderDashboard(d);}catch(e){panel.innerHTML='<section class="card"><h2>Live Chat</h2><p>'+esc(e.message)+'</p></section>'}
 }
 function renderDashboard(d){
  if(!active)return;const {panel}=active,open=!!d.open,sessions=d.sessions||[],newPeople=sessions.filter(s=>!s.vendor_id),existing=sessions.filter(s=>s.vendor_id);
  const cards=list=>list.map(s=>'<button type="button" class="card live-chat-row" data-chat-session="'+esc(s.id)+'"><span><strong>'+esc(s.vendor_business||s.visitor_name)+'</strong><small>'+esc(s.visitor_name)+' · '+esc(s.visitor_email)+' · '+esc(s.visitor_phone)+'</small><small>What they sell: '+esc(s.selling)+'</small></span><span><span class="tag">'+esc(s.status)+'</span>'+(Number(s.unread||0)?'<span class="chat-unread">'+Number(s.unread)+'</span>':'')+'<small>'+esc(stamp(s.last_message_at))+'</small></span><em>'+esc(s.last_message||'No message')+'</em></button>').join('')||'<p class="muted">No conversations here yet.</p>';
  panel.innerHTML='<section class="card live-chat-admin-head"><div><h2>Live Chat</h2><p>'+ (open?'Vendors can start a live conversation now.':'Chat is closed. New questions are being sent to you by email and saved here.') +'</p></div><button id="chat-open-toggle" class="'+(open?'secondary':'')+'">'+(open?'Close Live Chat':'Open Live Chat')+'</button></section><section class="card"><h3>Active & Existing Vendors</h3><div class="live-chat-admin-list">'+cards(existing)+'</div></section><section class="card"><h3>New Vendor / Visitor History</h3><p class="muted">People who do not yet match a master vendor record stay here so their full inquiry history is not lost.</p><div class="live-chat-admin-list">'+cards(newPeople)+'</div></section>';
  panel.querySelector('#chat-open-toggle').onclick=async e=>{e.currentTarget.disabled=true;try{await api('admin-toggle',{open:!open});await openPanel()}catch(err){alert(err.message);e.currentTarget.disabled=false;}};
  panel.querySelectorAll('[data-chat-session]').forEach(x=>x.onclick=()=>conversation(x.dataset.chatSession));
  startRefresh();
 }
 async function openPanel(){if(active)await open(active.panel,active.b,active.tabs)}
 async function conversation(id){
  if(!active)return;try{const d=await api('admin-messages',{id}),s=d.session,msgs=d.messages||[];active.panel.innerHTML='<section class="card"><button type="button" class="secondary" id="chat-back">← Back to Live Chat</button><h2>'+esc(s.vendor_business||s.visitor_name)+'</h2><p><strong>'+esc(s.visitor_name)+'</strong><br>'+esc(s.visitor_email)+' · '+esc(s.visitor_phone)+'<br><strong>What they sell:</strong> '+esc(s.selling)+'</p><p><span class="tag">'+esc(s.status)+'</span>'+(s.account_number?' <span class="tag">Vendor '+esc(s.account_number)+'</span>':' <span class="tag">New vendor / visitor</span>')+'</p></section><section class="card"><div class="live-chat-messages live-chat-admin-thread">'+msgs.map(m=>'<div class="chat-msg '+(m.sender==='organizer'?'mine':'theirs')+'"><small>'+esc(m.sender==='organizer'?'You':'Vendor')+'</small><p>'+esc(m.body)+'</p><time>'+esc(stamp(m.created_at))+'</time></div>').join('')+'</div>'+(s.status==='closed'?'<div class="actions"><button id="chat-reopen">Reopen Conversation</button></div>':'<form id="chat-admin-reply"><label>Reply<textarea name="message" rows="3" required></textarea></label><div class="actions"><button type="submit">Send Reply</button><button type="button" class="secondary" id="chat-close-session">Close Conversation</button></div></form>')+'</section>';
   active.panel.querySelector('#chat-back').onclick=openPanel;
   const form=active.panel.querySelector('#chat-admin-reply');if(form)form.onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await api('admin-reply',{id,message:new FormData(form).get('message')});await conversation(id)}catch(err){alert(err.message);b.disabled=false;}};
   const close=active.panel.querySelector('#chat-close-session');if(close)close.onclick=async()=>{if(!confirm('Close this conversation?'))return;await api('admin-close',{id});await conversation(id)};
   const reopen=active.panel.querySelector('#chat-reopen');if(reopen)reopen.onclick=async()=>{await api('admin-reopen',{id});await conversation(id)};
   startRefresh(()=>conversation(id));
  }catch(e){alert(e.message)}
 }
 function startRefresh(fn=openPanel){clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(location.hash==='#admin'&&active?.b?.classList.contains('selected'))fn().catch(()=>{});else clearInterval(refreshTimer)},7000)}
 new MutationObserver(install).observe(document.body,{childList:true,subtree:true});window.addEventListener('hashchange',()=>{clearInterval(refreshTimer);setTimeout(install,100)});install();
})();