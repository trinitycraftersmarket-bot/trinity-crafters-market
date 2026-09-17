import {identity} from '../../server/core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const VERSION=process.env.META_GRAPH_VERSION||'v24.0';
const PAGE_ID=()=>process.env.META_PAGE_ID||'';
const PAGE_TOKEN=()=>process.env.META_PAGE_ACCESS_TOKEN||'';
const IG_ID=()=>process.env.META_INSTAGRAM_ACCOUNT_ID||'';
async function graph(path,params={},method='POST'){
 const body=new URLSearchParams({...params,access_token:PAGE_TOKEN()});
 const r=await fetch(`https://graph.facebook.com/${VERSION}/${path}`,method==='GET'?{headers:{Authorization:`Bearer ${PAGE_TOKEN()}`}}:{method,headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v?.error?.message||`Meta returned ${r.status}.`);return v;
}
export default async req=>{try{
 const u=await identity(req);if(!u.admin)return json({error:'Organizer access only.'},403);
 const configured=!!(PAGE_ID()&&PAGE_TOKEN());
 if(req.method==='GET'){
  if(!configured)return json({configured:false,instagramConnected:!!IG_ID()});
  let pageName='Facebook Page';try{const r=await fetch(`https://graph.facebook.com/${VERSION}/${PAGE_ID()}?fields=name&access_token=${encodeURIComponent(PAGE_TOKEN())}`);const v=await r.json();if(r.ok&&v.name)pageName=v.name;}catch{}
  return json({configured:true,pageName,instagramConnected:!!IG_ID()});
 }
 if(req.method!=='POST')return json({error:'Method not allowed.'},405);
 if(!configured)return json({error:'Meta is not connected yet. Add META_PAGE_ID and META_PAGE_ACCESS_TOKEN in Netlify.'},400);
 const p=await req.json(),text=String(p.text||'').trim(),media=String(p.media||'').trim();if(!text)throw Error('Post text is required.');if(!p.facebook&&!p.instagram)throw Error('Choose Facebook, Instagram, or both.');
 const result={};
 if(p.facebook){result.facebook=media?await graph(`${PAGE_ID()}/photos`,{url:media,caption:text,published:'true'}):await graph(`${PAGE_ID()}/feed`,{message:text});}
 if(p.instagram){if(!IG_ID())throw Error('Instagram is not connected yet. Add META_INSTAGRAM_ACCOUNT_ID in Netlify.');if(!media)throw Error('Instagram requires an image URL.');const container=await graph(`${IG_ID()}/media`,{image_url:media,caption:text});result.instagram=await graph(`${IG_ID()}/media_publish`,{creation_id:container.id});}
 return json({ok:true,result});
}catch(e){console.error(e);return json({error:e.message||'Could not publish social post.'},400);}};
