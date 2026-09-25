(()=> {
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=()=>sessionStorage.getItem('market-token');
 const api=async(action,body)=>{const r=await fetch('/.netlify/functions/live-chat?action='+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Request failed');return v};
 const ALERT_KEY='tcm-live-chat-alerts-enabled',ALERTED_KEY='tcm-live-chat-alerted-at';
 let active=null,refreshTimer=null,alertTimer=null,audioCtx=null,storageLib=null,historyTimer=null,historyState={q:'',filter:'all',page:1,pageSize:20,total:0,pages:1};
 function stamp(d){return d?new Date(d).toLocaleString():''}
 function fileValid(file){return !!file&&file.size>0&&file.size<=10*1024*1024&&['image/jpeg','image/png','image/webp','image/gif','application/pdf'].includes(file.type)}
 async function uploadAttachment(sessionId,file){
  if(!fileValid(file))throw Error('Attach a JPG, PNG, WEBP, GIF, or PDF up to 10 MB.');
  const ticket=await api('admin-create-upload',{id:sessionId,name:file.name,type:file.type,size:file.size});
  storageLib=storageLib||await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const client=storageLib.createClient(ticket.url,ticket.key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {error}=await client.storage.from(ticket.bucket).uploadToSignedUrl(ticket.path,ticket.token,file,{contentType:file.type,upsert:false});
  if(error)throw Error('The file could not be uploaded. Please try again.');
  return {path:ticket.path,name:file.name,type:file.type,size:file.size};
 }
 function attachmentHtml(m){
  if(!m.attachment_name)return '';
  const name=esc(m.attachment_name),url=m.attachment_url?esc(m.attachment_url):'';
  if(!url)return '<div class="chat-attachment"><span>📎 '+name+'</span></div>';
  if(String(m.attachment_type||'').startsWith('image/'))return '<div class="chat-attachment"><a href="'+url+'" target="_blank" rel="noopener"><img class="chat-attachment-img" src="'+url+'" alt="Attachment: '+name+'" loading="lazy"></a><a class="chat-file-link" href="'+url+'" target="_blank" rel="noopener">📎 '+name+'</a></div>';
  return '<div class="chat-attachment"><a class="chat-file-link" href="'+url+'" target="_blank" rel="noopener">📄 '+name+'</a></div>';
 }
 function alertsEnabled(){return localStorage.getItem(ALERT_KEY)==='1'}
 function setAlertsEnabled(v){localStorage.setItem(ALERT_KEY,v?'1':'0')}
 function alertedMap(){try{return JSON.parse(localStorage.getItem(ALERTED_KEY)||'{}')||{}}catch{return {}}}
 function saveAlerted(m){localStorage.setItem(ALERTED_KEY,JSON.stringify(m))}
 function ensureAudio(){
  try{
   const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
   audioCtx=audioCtx||new C();if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});
   return audioCtx;
  }catch{return null}
 }
 function chime(){
  if(!alertsEnabled())return;
  const ctx=ensureAudio();if(!ctx)return;
  try{
   const now=ctx.currentTime,g=ctx.createGain();g.connect(ctx.destination);g.gain.setValueAtTime(.0001,now);g.gain.exponentialRampToValueAtTime(.12,now+.02);g.gain.exponentialRampToValueAtTime(.0001,now+.5);
   [[784,0,.22],[1046,.16,.34]].forEach(([freq,start,end])=>{const o=ctx.createOscillator();o.type='sine';o.frequency.value=freq;o.connect(g);o.start(now+start);o.stop(now+end);});
  }catch{}
 }
 function notifyBrowser(title,body,sessionId){
  if(!alertsEnabled()||!('Notification'in window)||Notification.permission!=='granted')return;
  try{
   const n=new Notification(title,{body,tag:'tcm-chat-'+sessionId,renotify:true});
   n.onclick=()=>{window.focus();location.hash='#admin';setTimeout(()=>{const b=document.querySelector('[data-live-chat-admin]');if(b)b.click();setTimeout(()=>conversation(sessionId),250)},250);n.close();};
  }catch{}
 }
 function markBaseline(sessions){
  const m=alertedMap();for(const s of sessions||[])if(s.last_message_at)m[s.id]=s.last_message_at;saveAlerted(m);
 }
 function fireDashboardAlerts(sessions){
  if(!alertsEnabled())return;
  const m=alertedMap(),fresh=(sessions||[]).filter(s=>Number(s.unread||0)>0&&s.last_message_at&&(!m[s.id]||new Date(s.last_message_at)>new Date(m[s.id])));
  if(!fresh.length)return;
  fresh.sort((a,b)=>new Date(b.last_message_at)-new Date(a.last_message_at));
  for(const s of fresh)m[s.id]=s.last_message_at;saveAlerted(m);chime();
  const s=fresh[0],name=s.vendor_business||s.visitor_name||'Vendor',prefix=fresh.length>1?fresh.length+' new vendor chats. Latest from ':'New message from ';
  notifyBrowser('Trinity Crafters Market — Live Chat',prefix+name+': '+String(s.last_message||'New message').slice(0,160),s.id);
 }
 function maybeAlertThread(s,msgs){
  if(!alertsEnabled())return;
  const visitor=[...(msgs||[])].reverse().find(m=>m.sender==='visitor');if(!visitor)return;
  const m=alertedMap(),when=visitor.created_at;if(!when||m[s.id]&&new Date(when)<=new Date(m[s.id]))return;
  m[s.id]=when;saveAlerted(m);chime();const preview=visitor.body||(visitor.attachment_name?'Attachment: '+visitor.attachment_name:'New message');notifyBrowser('New vendor message',String(s.vendor_business||s.visitor_name||'Vendor')+': '+String(preview).slice(0,160),s.id);
 }
 async function enableAlerts(){
  const d=await api('admin-dashboard');markBaseline(d.sessions||[]);setAlertsEnabled(true);ensureAudio();chime();
  if('Notification'in window&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}
 }
 function alertStatusText(){
  if(!alertsEnabled())return 'Enable sound & browser alerts';
  if(!('Notification'in window))return 'Sound alerts on';
  if(Notification.permission==='granted')return 'Sound & browser alerts on ✓';
  if(Notification.permission==='denied')return 'Sound on · browser alerts blocked';
  return 'Sound alerts on';
 }
 function install(){
  if(location.hash!=='#admin'){clearInterval(alertTimer);return;}
  const managerPanel=document.querySelector('#manager-content'),panel=document.querySelector('#panel')||managerPanel,tabs=document.querySelector('.tabs')||(managerPanel?document.querySelector('#manager-toolbar'):null);if(!tabs||!panel)return;
  let b=tabs.querySelector('[data-live-chat-admin]');
  if(!b&&managerPanel)return;
  if(!b){b=document.createElement('button');b.textContent='Live Chat';b.dataset.liveChatAdmin='1';const vendors=tabs.querySelector('[data-tab="vendors"]');vendors?vendors.after(b):tabs.appendChild(b);}
  b.onclick=()=>open(panel,b,tabs);
  startAlertWatch();
  if(alertsEnabled())document.addEventListener('click',ensureAudio,{once:true,capture:true});
 }
 function startAlertWatch(){
  if(alertTimer)return;
  const poll=async()=>{if(location.hash!=='#admin'||!token()){clearInterval(alertTimer);alertTimer=null;return;}try{const d=await api('admin-dashboard');fireDashboardAlerts(d.sessions||[]);const unread=(d.sessions||[]).reduce((n,s)=>n+Number(s.unread||0),0),b=document.querySelector('[data-live-chat-admin]');if(b)b.textContent=unread?'Live Chat ('+unread+')':'Live Chat';}catch{}};
  poll();alertTimer=setInterval(poll,5000);
 }
 async function open(panel,b,tabs){
  tabs.querySelectorAll('button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');active={panel,b,tabs};
  panel.innerHTML='<section class="card"><h2>Live Chat</h2><p>Loading conversations…</p></section>';
  try{const d=await api('admin-dashboard');renderDashboard(d);await loadHistory();}catch(e){panel.innerHTML='<section class="card"><h2>Live Chat</h2><p>'+esc(e.message)+'</p></section>'}
 }
 function chatCard(s){
  const label=s.vendor_business||s.visitor_name||'Vendor',existing=!!s.vendor_id,unread=Number(s.unread||0);
  return '<button type="button" class="live-chat-history-row" data-chat-session="'+esc(s.id)+'"><span class="chat-history-main"><strong>'+esc(label)+'</strong><small>'+esc(s.visitor_name||'')+(s.visitor_email?' · '+esc(s.visitor_email):'')+(s.visitor_phone?' · '+esc(s.visitor_phone):'')+'</small><em>'+esc(s.last_message||'No message yet')+'</em></span><span class="chat-history-meta"><span><span class="tag">'+esc(s.status)+'</span> <span class="tag '+(existing?'':'held')+'">'+(existing?'Existing vendor':'New inquiry')+'</span>'+(unread?'<span class="chat-unread">'+unread+'</span>':'')+'</span><small>'+esc(stamp(s.last_message_at))+'</small></span></button>';
 }
 function renderDashboard(d){
  if(!active)return;const {panel}=active,open=!!d.open;
  panel.innerHTML='<section class="card live-chat-admin-head"><div><h2>Live Chat</h2><p>'+(open?'Vendors can start a live conversation now.':'Chat is closed. New questions are being sent to you by email and saved here.')+'</p></div><div class="actions"><button id="chat-alert-toggle" class="secondary">'+esc(alertStatusText())+'</button><button id="chat-open-toggle" class="'+(open?'secondary':'')+'">'+(open?'Close Live Chat':'Open Live Chat')+'</button></div></section>'+
  '<section class="card live-chat-history-card"><div class="chat-history-heading"><div><h3>Conversation History</h3><p class="muted">Search by vendor name, business name, phone number, or email. Older conversations stay available without filling the entire page.</p></div><button type="button" class="secondary" id="chat-history-refresh">Refresh</button></div>'+
  '<div class="chat-history-toolbar"><label class="chat-history-search"><span>Search conversations</span><div><input id="chat-history-search" type="search" autocomplete="off" placeholder="Name, phone, email, or business" value="'+esc(historyState.q)+'"><button type="button" class="quiet" id="chat-history-clear" '+(historyState.q?'':'hidden')+'>Clear</button></div></label>'+
  '<div class="chat-history-filters" role="group" aria-label="Filter chat history">'+
    [['all','All'],['active','Active'],['unread','Unread'],['closed','Closed'],['existing','Existing vendors'],['new','New inquiries']].map(([v,l])=>'<button type="button" class="'+(historyState.filter===v?'selected':'')+'" data-chat-filter="'+v+'">'+l+'</button>').join('')+
  '</div></div>'+
  '<div id="chat-history-summary" class="chat-history-summary">Loading conversations…</div><div id="chat-history-results" class="live-chat-admin-list"></div><div id="chat-history-pager" class="chat-history-pager"></div></section>';
  panel.querySelector('#chat-open-toggle').onclick=async e=>{e.currentTarget.disabled=true;try{await api('admin-toggle',{open:!open});await openPanel()}catch(err){alert(err.message);e.currentTarget.disabled=false;}};
  panel.querySelector('#chat-alert-toggle').onclick=async e=>{e.currentTarget.disabled=true;try{if(alertsEnabled()){setAlertsEnabled(false);}else await enableAlerts();await openPanel()}catch(err){alert(err.message);e.currentTarget.disabled=false;}};
  panel.querySelector('#chat-history-refresh').onclick=()=>loadHistory();
  const search=panel.querySelector('#chat-history-search'),clear=panel.querySelector('#chat-history-clear');
  search.oninput=()=>{historyState.q=search.value.trim();historyState.page=1;clear.hidden=!historyState.q;clearTimeout(historyTimer);historyTimer=setTimeout(()=>loadHistory(),300);};
  search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(historyTimer);historyState.q=search.value.trim();historyState.page=1;loadHistory();}};
  clear.onclick=()=>{search.value='';historyState.q='';historyState.page=1;clear.hidden=true;search.focus();loadHistory();};
  panel.querySelectorAll('[data-chat-filter]').forEach(btn=>btn.onclick=()=>{historyState.filter=btn.dataset.chatFilter;historyState.page=1;panel.querySelectorAll('[data-chat-filter]').forEach(x=>x.classList.toggle('selected',x===btn));loadHistory();});
 }
 async function loadHistory(){
  if(!active?.panel?.querySelector('#chat-history-results'))return;
  const results=active.panel.querySelector('#chat-history-results'),summary=active.panel.querySelector('#chat-history-summary'),pager=active.panel.querySelector('#chat-history-pager');
  results.setAttribute('aria-busy','true');summary.textContent='Loading conversations…';
  try{
   const d=await api('admin-search',{q:historyState.q,filter:historyState.filter,page:historyState.page,page_size:historyState.pageSize});
   historyState.total=Number(d.total||0);historyState.pages=Number(d.pages||1);historyState.page=Number(d.page||1);
   const sessions=d.sessions||[];
   results.innerHTML=sessions.map(chatCard).join('')||'<p class="empty">No conversations match this search.</p>';
   const from=historyState.total?((historyState.page-1)*historyState.pageSize)+1:0,to=Math.min(historyState.total,historyState.page*historyState.pageSize);
   summary.textContent=historyState.q?'Showing '+from+'–'+to+' of '+historyState.total+' matching conversations':'Showing '+from+'–'+to+' of '+historyState.total+' conversations · newest first';
   pager.innerHTML=(historyState.pages>1?'<button type="button" class="secondary" id="chat-prev" '+(historyState.page<=1?'disabled':'')+'>← Previous</button><span>Page '+historyState.page+' of '+historyState.pages+'</span><button type="button" class="secondary" id="chat-next" '+(historyState.page>=historyState.pages?'disabled':'')+'>Next →</button>':'');
   const prev=pager.querySelector('#chat-prev'),next=pager.querySelector('#chat-next');
   if(prev)prev.onclick=()=>{historyState.page=Math.max(1,historyState.page-1);loadHistory();};
   if(next)next.onclick=()=>{historyState.page=Math.min(historyState.pages,historyState.page+1);loadHistory();};
   results.querySelectorAll('[data-chat-session]').forEach(x=>x.onclick=()=>conversation(x.dataset.chatSession));
  }catch(e){results.innerHTML='<p class="empty">'+esc(e.message)+'</p>';summary.textContent='Could not load conversation history.';}
  finally{results.removeAttribute('aria-busy');}
 }
 async function openPanel(){if(active)await open(active.panel,active.b,active.tabs)}
 async function conversation(id){
  if(!active)return;try{const d=await api('admin-messages',{id}),s=d.session,msgs=d.messages||[];maybeAlertThread(s,msgs);active.panel.innerHTML='<section class="card"><button type="button" class="secondary" id="chat-back">← Back to Live Chat</button><h2>'+esc(s.vendor_business||s.visitor_name)+'</h2><p><strong>'+esc(s.visitor_name)+'</strong><br>'+esc(s.visitor_email)+' · '+esc(s.visitor_phone)+'<br><strong>What they sell:</strong> '+esc(s.selling)+'</p><p><span class="tag">'+esc(s.status)+'</span>'+(s.account_number?' <span class="tag">Vendor '+esc(s.account_number)+'</span>':' <span class="tag">New vendor / visitor</span>')+'</p></section><section class="card"><div class="live-chat-messages live-chat-admin-thread">'+msgs.map(m=>'<div class="chat-msg '+(m.sender==='organizer'?'mine':'theirs')+'"><small>'+esc(m.sender==='organizer'?'You':'Vendor')+'</small>'+(m.body?'<p>'+esc(m.body)+'</p>':'')+attachmentHtml(m)+'<time>'+esc(stamp(m.created_at))+'</time></div>').join('')+'</div>'+(s.status==='closed'?'<div class="actions"><button id="chat-reopen">Reopen Conversation</button></div>':'<form id="chat-admin-reply"><label>Reply<textarea name="message" rows="3" placeholder="Type a reply, attach a file, or both"></textarea></label><label class="chat-attach-control">Attach screenshot or PDF<input name="attachment" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"></label><small>JPG, PNG, WEBP, GIF, or PDF up to 10 MB.</small><div class="actions"><button type="submit">Send Reply</button><button type="button" class="secondary" id="chat-close-session">Close Conversation</button></div></form>')+'</section>';
   active.panel.querySelector('#chat-back').onclick=openPanel;
   const form=active.panel.querySelector('#chat-admin-reply');if(form)form.onsubmit=async e=>{e.preventDefault();const b=e.submitter,f=new FormData(form),file=f.get('attachment'),hasFile=!!file&&file.size>0,message=String(f.get('message')||'').trim();if(!message&&!hasFile)return alert('Type a reply or attach a file.');b.disabled=true;b.textContent=hasFile?'Uploading…':'Sending…';try{const attachment=hasFile?await uploadAttachment(id,file):null;await api('admin-reply',{id,message,attachment});await conversation(id)}catch(err){alert(err.message);b.disabled=false;b.textContent='Send Reply';}};
   const close=active.panel.querySelector('#chat-close-session');if(close)close.onclick=async()=>{if(!confirm('Close this conversation?'))return;await api('admin-close',{id});await conversation(id)};
   const reopen=active.panel.querySelector('#chat-reopen');if(reopen)reopen.onclick=async()=>{await api('admin-reopen',{id});await conversation(id)};
   startRefresh(async()=>{const formNow=active?.panel?.querySelector('#chat-admin-reply'),ta=formNow?.querySelector('textarea'),file=formNow?.querySelector('input[type="file"]');if(formNow&&((ta&&(ta===document.activeElement||ta.value.trim()))||file?.files?.length))return;await conversation(id);});
  }catch(e){alert(e.message)}
 }
 function startRefresh(fn=openPanel){clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(location.hash==='#admin'&&active?.b?.isConnected&&active.b.classList.contains('selected'))fn().catch(()=>{});else clearInterval(refreshTimer)},7000)}
 new MutationObserver(install).observe(document.body,{childList:true,subtree:true});window.addEventListener('hashchange',()=>{clearInterval(refreshTimer);active=null;setTimeout(install,100)});install();
})();