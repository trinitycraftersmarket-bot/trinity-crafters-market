import {db,identity,queue,flushMail,audit,supa} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);
const emailOk=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneNorm=v=>String(v??'').replace(/\D/g,'').slice(-15);
const chatOpen=async sql=>{const [r]=await sql`select value from market.settings where key='chat_open'`;return String(r?.value||'false').toLowerCase()==='true';};
const adminEmail=()=>process.env.ADMIN_EMAIL||'trinitycraftersmarket@gmail.com';
const ATTACH_BUCKET='chat-attachments',MAX_ATTACHMENT=10*1024*1024;
const ATTACH_TYPES=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif'],['application/pdf','pdf']]);
function uploadInfo(p,sessionId){
 const name=clean(p?.name,240),type=clean(p?.type,100).toLowerCase(),size=Number(p?.size||0),ext=ATTACH_TYPES.get(type);
 if(!name||!ext||!Number.isFinite(size)||size<1||size>MAX_ATTACHMENT)throw Error('Attach a JPG, PNG, WEBP, GIF, or PDF up to 10 MB.');
 return {name,type,size,path:sessionId+'/'+crypto.randomUUID()+'.'+ext};
}
function attachmentInfo(p,sessionId){
 const a=p?.attachment;if(!a)return null;
 const path=clean(a.path,600),name=clean(a.name,240),type=clean(a.type,100).toLowerCase(),size=Number(a.size||0);
 if(!path.startsWith(sessionId+'/')||!name||!ATTACH_TYPES.has(type)||!Number.isFinite(size)||size<1||size>MAX_ATTACHMENT)throw Error('The attachment is invalid. Please choose the file again.');
 return {path,name,type,size};
}
async function uploadTicket(sessionId,p){
 const a=uploadInfo(p,sessionId),client=supa();
 const {data,error}=await client.storage.from(ATTACH_BUCKET).createSignedUploadUrl(a.path);
 if(error||!data?.token)throw Error('Could not prepare the attachment upload. Please try again.');
 return {bucket:ATTACH_BUCKET,path:a.path,token:data.token,url:process.env.SUPABASE_URL||'',key:process.env.SUPABASE_PUBLISHABLE_KEY||'',name:a.name,type:a.type,size:a.size};
}
async function signAttachments(rows){
 const paths=[...new Set((rows||[]).map(x=>x.attachment_path).filter(Boolean))];if(!paths.length)return rows;
 const {data}=await supa().storage.from(ATTACH_BUCKET).createSignedUrls(paths,3600);
 const map=new Map((data||[]).map(x=>[x.path,x.signedUrl||null]));
 return (rows||[]).map(x=>({...x,attachment_url:x.attachment_path?map.get(x.attachment_path)||null:null}));
}

async function publicSession(sql,id,token){
 const [s]=await sql`select id,vendor_id,visitor_name,visitor_email,visitor_phone,selling,status,started_at,last_message_at,closed_at from market.chat_sessions where id=${id} and client_token=${token}`;
 return s||null;
}
async function offlineNotice(tx,s,message,attachmentName=''){
 const subject=`Website message from ${s.visitor_name}`;
 const body=`New website message received while live chat is closed.

Name: ${s.visitor_name}
Email: ${s.visitor_email}
Phone: ${s.visitor_phone}
What they sell: ${s.selling}
${s.vendor_id?'Existing vendor: Yes':'Existing vendor: No'}

Message:
${message||'(No text message)'}${attachmentName?'\n\nAttachment: '+attachmentName:''}

The conversation is saved in Organizer > Live Chat.`;
 await queue(tx,adminEmail(),subject,body);
}

export default async req=>{
 try{
  const url=new URL(req.url),action=url.searchParams.get('action')||'status',sql=db();

  if(action==='status'&&req.method==='GET')return json({open:await chatOpen(sql)});

  if(action==='start'&&req.method==='POST'){
   const p=await req.json(),name=clean(p.name,160),email=clean(p.email,320).toLowerCase(),phone=clean(p.phone,60),normalized=phoneNorm(phone),selling=clean(p.selling,1000),message=clean(p.message,3000),hasAttachment=p.has_attachment===true;
   if(!name||!email||!phone||!selling||(!message&&!hasAttachment))throw Error('Name, email, phone, what you sell, and either a question or attachment are required.');
   if(!emailOk(email))throw Error('Enter a valid email address.');
   if(normalized.length<7)throw Error('Enter a valid phone number.');
   const [rate]=await sql`select count(*)::int n from market.chat_sessions where (lower(visitor_email)=${email} or normalized_phone=${normalized}) and started_at>now()-interval '1 hour'`;
   if(Number(rate?.n||0)>=5)throw Error('Too many new conversations were started recently. Please use your existing chat or try again later.');
   const [vendor]=await sql`select id,business from market.vendors where lower(email)=${email} or (regexp_replace(phone,'\\D','','g')<>'' and regexp_replace(phone,'\\D','','g')=${normalized}) order by updated_at desc limit 1`;
   const open=await chatOpen(sql);
   let session;
   await sql.begin(async tx=>{
    [session]=await tx`insert into market.chat_sessions(vendor_id,visitor_name,visitor_email,visitor_phone,normalized_phone,selling,status)
      values(${vendor?.id||null},${name},${email},${phone},${normalized},${selling},${open?'open':'offline'})
      returning id,client_token,vendor_id,visitor_name,visitor_email,visitor_phone,selling,status,started_at,last_message_at`;
    if(message&&!hasAttachment){
     await tx`insert into market.chat_messages(session_id,sender,body) values(${session.id},'visitor',${message})`;
     await tx`update market.chat_sessions set last_message_at=now() where id=${session.id}`;
     if(!open)await offlineNotice(tx,session,message);
    }
   });
   if(!open&&message&&!hasAttachment)await flushMail();
   return json({session:{id:session.id,token:session.client_token,status:session.status,existing_vendor:!!session.vendor_id},open});
  }

  if(action==='create-upload'&&req.method==='POST'){
   const p=await req.json(),s=await publicSession(sql,clean(p.id,80),clean(p.token,80));if(!s)return json({error:'Conversation not found.'},404);
   if(s.status==='closed')throw Error('This conversation has been closed.');
   return json(await uploadTicket(s.id,p));
  }

  if(action==='messages'&&req.method==='POST'){
   const p=await req.json(),s=await publicSession(sql,clean(p.id,80),clean(p.token,80));if(!s)return json({error:'Conversation not found.'},404);
   let messages=await sql`select id,sender,body,attachment_path,attachment_name,attachment_type,attachment_size,created_at from market.chat_messages where session_id=${s.id} order by created_at`;
   messages=await signAttachments(messages);return json({session:s,messages,open:await chatOpen(sql)});
  }

  if(action==='send'&&req.method==='POST'){
   const p=await req.json(),s=await publicSession(sql,clean(p.id,80),clean(p.token,80));if(!s)return json({error:'Conversation not found.'},404);
   if(s.status==='closed')throw Error('This conversation has been closed. Start a new chat if you still need help.');
   const message=clean(p.message,3000),attachment=attachmentInfo(p,s.id);if(!message&&!attachment)throw Error('Enter a message or attach a file.');
   const open=await chatOpen(sql);
   await sql.begin(async tx=>{
    await tx`insert into market.chat_messages(session_id,sender,body,attachment_path,attachment_name,attachment_type,attachment_size)
      values(${s.id},'visitor',${message},${attachment?.path||null},${attachment?.name||null},${attachment?.type||null},${attachment?.size||null})`;
    await tx`update market.chat_sessions set status=${open?'open':'offline'},last_message_at=now() where id=${s.id}`;
    if(!open)await offlineNotice(tx,s,message,attachment?.name||'');
   });
   if(!open)await flushMail();
   return json({ok:true,open,status:open?'open':'offline'});
  }

  const u=await identity(req);if(!u.admin)return json({error:'Administrator access only'},403);

  if(action==='admin-create-upload'&&req.method==='POST'){
   const p=await req.json(),id=clean(p.id,80),[s]=await sql`select id,status from market.chat_sessions where id=${id}`;
   if(!s)return json({error:'Conversation not found.'},404);if(s.status==='closed')throw Error('Reopen the conversation before attaching a file.');
   return json(await uploadTicket(id,p));
  }

  if(action==='admin-dashboard'&&req.method==='GET'){
   const open=await chatOpen(sql);
   const sessions=await sql`select s.id,s.vendor_id,s.visitor_name,s.visitor_email,s.visitor_phone,s.selling,s.status,s.started_at,s.last_message_at,s.closed_at,
     v.business vendor_business,v.account_number,
     (select coalesce(nullif(body,''),case when attachment_name is not null then '[Attachment: '||attachment_name||']' else '' end) from market.chat_messages m where m.session_id=s.id order by m.created_at desc limit 1) last_message,
     (select count(*)::int from market.chat_messages m where m.session_id=s.id and m.sender='visitor' and m.created_at>coalesce(s.admin_seen_at,'1970-01-01'::timestamptz)) unread
     from market.chat_sessions s left join market.vendors v on v.id=s.vendor_id order by s.last_message_at desc limit 100`;
   return json({open,sessions});
  }

  if(action==='admin-search'&&req.method==='POST'){
   const p=await req.json(),q=clean(p.q,200).toLowerCase(),phoneQ=phoneNorm(q),filter=['all','active','unread','closed','existing','new'].includes(p.filter)?p.filter:'all',
     page=Math.max(1,Math.min(5000,Number.parseInt(p.page,10)||1)),pageSize=Math.max(10,Math.min(50,Number.parseInt(p.page_size,10)||20)),offset=(page-1)*pageSize;
   const sessions=await sql`select s.id,s.vendor_id,s.visitor_name,s.visitor_email,s.visitor_phone,s.selling,s.status,s.started_at,s.last_message_at,s.closed_at,s.admin_seen_at,
     v.business vendor_business,v.name vendor_name,v.email vendor_email,v.phone vendor_phone,v.account_number,
     (select coalesce(nullif(body,''),case when attachment_name is not null then '[Attachment: '||attachment_name||']' else '' end) from market.chat_messages m where m.session_id=s.id order by m.created_at desc limit 1) last_message,
     (select count(*)::int from market.chat_messages m where m.session_id=s.id and m.sender='visitor' and m.created_at>coalesce(s.admin_seen_at,'1970-01-01'::timestamptz)) unread,
     count(*) over()::int total_count
     from market.chat_sessions s left join market.vendors v on v.id=s.vendor_id
     where (
       ${q}='' or
       position(${q} in lower(coalesce(s.visitor_name,'')))>0 or
       position(${q} in lower(coalesce(s.visitor_email,'')))>0 or
       position(${q} in lower(coalesce(v.business,'')))>0 or
       position(${q} in lower(coalesce(v.name,'')))>0 or
       position(${q} in lower(coalesce(v.email,'')))>0 or
       (${phoneQ}<>'' and (
         position(${phoneQ} in regexp_replace(coalesce(s.visitor_phone,''),'[^0-9]','','g'))>0 or
         position(${phoneQ} in regexp_replace(coalesce(v.phone,''),'[^0-9]','','g'))>0
       ))
     )
     and (
       ${filter}='all' or
       (${filter}='active' and s.status<>'closed') or
       (${filter}='closed' and s.status='closed') or
       (${filter}='existing' and s.vendor_id is not null) or
       (${filter}='new' and s.vendor_id is null) or
       (${filter}='unread' and exists(
         select 1 from market.chat_messages um
         where um.session_id=s.id and um.sender='visitor' and um.created_at>coalesce(s.admin_seen_at,'1970-01-01'::timestamptz)
       ))
     )
     order by s.last_message_at desc
     limit ${pageSize} offset ${offset}`;
   const total=Number(sessions[0]?.total_count||0);
   return json({sessions:sessions.map(({total_count,...s})=>s),total,page,page_size:pageSize,pages:Math.max(1,Math.ceil(total/pageSize)),q,filter});
  }

  if(action==='admin-messages'&&req.method==='POST'){
   const p=await req.json(),id=clean(p.id,80);
   const [s]=await sql`select s.id,s.vendor_id,s.visitor_name,s.visitor_email,s.visitor_phone,s.selling,s.status,s.started_at,s.last_message_at,s.closed_at,v.business vendor_business,v.account_number from market.chat_sessions s left join market.vendors v on v.id=s.vendor_id where s.id=${id}`;
   if(!s)return json({error:'Conversation not found.'},404);
   let messages=await sql`select id,sender,body,attachment_path,attachment_name,attachment_type,attachment_size,created_at from market.chat_messages where session_id=${id} order by created_at`;
   messages=await signAttachments(messages);await sql`update market.chat_sessions set admin_seen_at=now() where id=${id}`;
   return json({session:s,messages,open:await chatOpen(sql)});
  }

  if(action==='admin-reply'&&req.method==='POST'){
   const p=await req.json(),id=clean(p.id,80),message=clean(p.message,3000);
   const [s]=await sql`select * from market.chat_sessions where id=${id}`;if(!s)return json({error:'Conversation not found.'},404);
   if(s.status==='closed')throw Error('Reopen the conversation before replying.');
   const attachment=attachmentInfo(p,id);if(!message&&!attachment)throw Error('Enter a reply or attach a file.');
   await sql.begin(async tx=>{
    await tx`insert into market.chat_messages(session_id,sender,body,attachment_path,attachment_name,attachment_type,attachment_size)
      values(${id},'organizer',${message},${attachment?.path||null},${attachment?.name||null},${attachment?.type||null},${attachment?.size||null})`;
    await tx`update market.chat_sessions set last_message_at=now(),admin_seen_at=now() where id=${id}`;
    if(s.status==='offline')await queue(tx,s.visitor_email,'Reply from Trinity Crafters Market',`Hi ${s.visitor_name},

We received your website message. Here is our reply:

${message||'(No text message)'}${attachment?'\n\nAttachment included: '+attachment.name+' — return to the website chat to view it securely.':''}

If you have another question, reply to this email or return to the website chat.

Trinity Crafters Market`);
    await audit(tx,u,'live chat reply',{session_id:id,recipient:s.visitor_email,attachment:attachment?.name||null});
   });
   if(s.status==='offline')await flushMail();
   return json({ok:true});
  }

  if((action==='admin-close'||action==='admin-reopen')&&req.method==='POST'){
   const p=await req.json(),id=clean(p.id,80);
   if(action==='admin-close')await sql`update market.chat_sessions set status='closed',closed_at=now() where id=${id}`;
   else {const open=await chatOpen(sql);await sql`update market.chat_sessions set status=${open?'open':'offline'},closed_at=null where id=${id}`;}
   await audit(sql,u,action==='admin-close'?'live chat closed':'live chat reopened',{session_id:id});
   return json({ok:true});
  }

  if(action==='admin-toggle'&&req.method==='POST'){
   const p=await req.json(),open=p.open===true;
   await sql`insert into market.settings(key,value) values('chat_open',${open?'true':'false'}) on conflict(key) do update set value=excluded.value`;
   await audit(sql,u,open?'live chat opened':'live chat closed for new visitors',{open});
   return json({ok:true,open});
  }

  return json({error:'Unknown action'},400);
 }catch(e){console.error('Live chat failed',e);return json({error:e.message||'Chat is temporarily unavailable.'},400);}
};