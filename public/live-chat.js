(()=> {
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key='tcm-live-chat-session';
 let state={open:false,session:null,messages:[],visible:false,timer:null};
 const api=async(action,body)=>{
  const r=await fetch('/.netlify/functions/live-chat?action='+encodeURIComponent(action),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||'Chat is temporarily unavailable.');return v;
 };
 function saved(){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
 function save(s){if(s)localStorage.setItem(key,JSON.stringify(s));else localStorage.removeItem(key)}
 function shell(){
  if(document.querySelector('#live-chat-launcher'))return;
  const wrap=document.createElement('div');wrap.id='live-chat-root';
  wrap.innerHTML='<button id="live-chat-launcher" type="button" aria-expanded="false" aria-controls="live-chat-panel"><span class="chat-dot"></span><span>Questions? Chat with us</span></button><section id="live-chat-panel" class="live-chat-panel" hidden aria-label="Vendor live chat"><div class="live-chat-head"><div><strong>Trinity Crafters Market</strong><small id="live-chat-status">Checking availability…</small></div><button type="button" class="quiet" id="live-chat-close" aria-label="Close chat">✕</button></div><div id="live-chat-body"></div></section>';
  document.body.appendChild(wrap);
  wrap.querySelector('#live-chat-launcher').onclick=()=>{state.visible=!state.visible;draw();if(state.visible&&state.session)refresh();};
  wrap.querySelector('#live-chat-close').onclick=()=>{state.visible=false;draw();};
 }
 function formHtml(){
  const label=state.open?'Start live chat':'Send us a message';
  const note=state.open?'We are online. Tell us who you are and what you sell to start chatting.':'Live chat is currently closed. Send your question and we will receive it by email.';
  return '<div class="live-chat-intro"><p>'+esc(note)+'</p></div><form id="live-chat-start"><label>Name<input name="name" autocomplete="name" required></label><label>Email<input type="email" name="email" autocomplete="email" required></label><label>Phone<input name="phone" autocomplete="tel" required></label><label>What do you sell?<textarea name="selling" rows="2" required></textarea></label><label>Your question<textarea name="message" rows="3" required></textarea></label><small>Your contact information is used to respond to your market question.</small><button type="submit">'+esc(label)+'</button></form>';
 }
 function transcriptHtml(){
  const s=state.session||{},offline=s.status==='offline'||!state.open,closed=s.status==='closed';
  return '<div class="live-chat-context"><strong>'+esc(s.existing_vendor?'Welcome back — we matched your vendor record.':'Vendor inquiry')+'</strong><small>'+(closed?'Conversation closed':offline?'We are offline. New messages will be emailed to us.':'Live now')+'</small></div><div class="live-chat-messages" id="live-chat-messages">'+state.messages.map(m=>'<div class="chat-msg '+(m.sender==='visitor'?'mine':'theirs')+'"><small>'+esc(m.sender==='visitor'?'You':'Trinity Crafters Market')+'</small><p>'+esc(m.body)+'</p><time>'+new Date(m.created_at).toLocaleString()+'</time></div>').join('')+'</div>'+(closed?'<button type="button" class="secondary" id="live-chat-new">Start a new conversation</button>':'<form id="live-chat-send"><textarea name="message" rows="2" placeholder="Type your message…" required></textarea><button type="submit">Send</button></form>');
 }
 function draw(){
  shell();
  const panel=document.querySelector('#live-chat-panel'),launch=document.querySelector('#live-chat-launcher'),body=document.querySelector('#live-chat-body'),status=document.querySelector('#live-chat-status');
  panel.hidden=!state.visible;launch.setAttribute('aria-expanded',state.visible?'true':'false');
  status.textContent=state.open?'● Live chat is open':'● Offline — messages go to email';
  body.innerHTML=state.session?transcriptHtml():formHtml();
  const start=body.querySelector('#live-chat-start');if(start)start.onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;b.textContent='Sending…';try{const p=Object.fromEntries(new FormData(start));const r=await api('start',p);state.session={...r.session};save(state.session);await refresh();}catch(err){alert(err.message);b.disabled=false;b.textContent=state.open?'Start live chat':'Send us a message';}};
  const send=body.querySelector('#live-chat-send');if(send)send.onsubmit=async e=>{e.preventDefault();const f=new FormData(send),b=e.submitter;b.disabled=true;try{await api('send',{id:state.session.id,token:state.session.token,message:f.get('message')});send.reset();await refresh();}catch(err){alert(err.message);}finally{b.disabled=false;}};
  const n=body.querySelector('#live-chat-new');if(n)n.onclick=()=>{save(null);state.session=null;state.messages=[];draw();};
  const box=body.querySelector('#live-chat-messages');if(box)requestAnimationFrame(()=>box.scrollTop=box.scrollHeight);
 }
 async function refresh(){
  if(!state.session)return;
  try{const r=await api('messages',{id:state.session.id,token:state.session.token});state.open=!!r.open;state.session={...state.session,...r.session};state.messages=r.messages||[];save(state.session);draw();}catch(e){if(/not found/i.test(e.message)){save(null);state.session=null;state.messages=[];draw();}}
 }
 async function boot(){
  shell();state.session=saved();try{const r=await api('status');state.open=!!r.open;}catch{}draw();if(state.session)await refresh();clearInterval(state.timer);state.timer=setInterval(()=>{if(state.session&&(state.visible||document.visibilityState==='visible'))refresh();},4000);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();