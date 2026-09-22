import { identity } from '../../server/core.mjs';

const API='https://api.buffer.com';

function json(status, body){return {statusCode:status,headers:{'content-type':'application/json'},body:JSON.stringify(body)};}
async function call(path, opts={}){
  const key=process.env.BUFFER_API_KEY||'';
  if(!key) throw Object.assign(new Error('Buffer API key is not configured.'),{status:503});
  const r=await fetch(API+path,{...opts,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(opts.headers||{})}});
  const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
  if(!r.ok) throw Object.assign(new Error(data?.message||data?.error||('Buffer request failed ('+r.status+').')),{status:r.status,detail:data});
  return data;
}
export async function handler(event){
  try{
    const req={headers:new Headers(event.headers||{})};\n    const who=await identity(req); if(!who?.admin&&!who?.manager) return json(403,{error:'Organizer access required.'});
    if(event.httpMethod==='GET'){
      const data=await call('/channels');
      const rows=Array.isArray(data)?data:(data?.data||data?.channels||[]);
      const channels=rows.map(c=>({id:String(c.id||c._id||''),service:c.service||c.network||c.type||'',name:c.name||c.display_name||c.username||'',username:c.username||''}));
      return json(200,{ok:true,configured:true,channels});
    }
    if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed.'});
    const b=JSON.parse(event.body||'{}'), text=String(b.text||'').trim(), media=String(b.media||'').trim();
    if(!text) return json(400,{error:'Post text is required.'});
    const channelIds=Array.isArray(b.channelIds)?b.channelIds.filter(Boolean):[];
    if(!channelIds.length) return json(400,{error:'Choose at least one Buffer channel.'});
    const when=b.dateTime?new Date(b.dateTime):null;
    if(when && isNaN(when.getTime())) return json(400,{error:'Invalid scheduled date/time.'});
    const payload={text,channel_ids:channelIds};
    if(media) payload.media=[{url:media}];
    if(when) payload.scheduled_at=when.toISOString();
    else payload.now=true;
    const data=await call('/posts',{method:'POST',body:JSON.stringify(payload)});
    return json(200,{ok:true,data});
  }catch(e){return json(e.status||500,{error:e.message,detail:e.detail||undefined});}
}