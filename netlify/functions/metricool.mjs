import {identity} from '../../server/core.mjs';

const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const BLOG_ID=process.env.METRICOOL_BLOG_ID||'4075755';
const USER_ID=process.env.METRICOOL_USER_ID||'3204449';
const TOKEN=()=>process.env.METRICOOL_TOKEN||'';

export default async req=>{try{
 const u=await identity(req);
 if(!u.admin)return json({error:'Organizer access only.'},403);
 if(req.method==='GET')return json({configured:!!TOKEN(),brand:'Trinity Crafters Market',blogId:BLOG_ID,networks:['facebook','instagram'],timezone:'America/New_York'});
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 if(!TOKEN())return json({error:'Metricool API access is not configured yet. Add METRICOOL_TOKEN in Netlify environment variables.'},400);
 const p=await req.json(),text=String(p.text||'').trim(),media=String(p.media||'').trim(),dateTime=String(p.dateTime||'').trim();
 const providers=[];
 if(p.facebook!==false)providers.push({network:'facebook'});
 if(p.instagram!==false)providers.push({network:'instagram'});
 if(!text)throw Error('Post text is required.');
 if(!providers.length)throw Error('Choose Facebook, Instagram, or both.');
 if(providers.some(x=>x.network==='instagram')&&!media)throw Error('Instagram requires an image or video URL.');
 if(!dateTime)throw Error('Choose a future publish date and time.');
 const body={publicationDate:{dateTime,timezone:'America/New_York'},text,providers,autoPublish:false,draft:true,shortener:false,saveExternalMediaFiles:!!media,facebookData:{type:'POST'},instagramData:{type:'POST',showReelOnFeed:true,isAiGenerated:false}};
 if(media)body.media=[media];
 if(!providers.some(x=>x.network==='facebook'))delete body.facebookData;
 if(!providers.some(x=>x.network==='instagram'))delete body.instagramData;
 const r=await fetch(`https://app.metricool.com/api/v2/scheduler/posts?blogId=${encodeURIComponent(BLOG_ID)}&userId=${encodeURIComponent(USER_ID)}`,{method:'POST',headers:{'Content-Type':'application/json','X-Mc-Auth':TOKEN()},body:JSON.stringify(body)});
 const raw=await r.text();let out;try{out=JSON.parse(raw);}catch{out={message:raw.slice(0,500)}}
 if(!r.ok)return json({error:out?.message||out?.error||`Metricool returned ${r.status}.`,details:out},r.status);
 return json({ok:true,result:out});
}catch(e){console.error(e);return json({error:e.message||'Could not schedule social post.'},400);}};
