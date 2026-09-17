const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const SITE_URL=(process.env.URL||'https://trinitylutzmarkets.com').replace(/\/$/,'');
const APP_ID=()=>process.env.META_APP_ID||'';
const CONFIG_ID=()=>process.env.META_LOGIN_CONFIG_ID||'1083862150803166';
const CALLBACK=()=>process.env.META_OAUTH_REDIRECT_URI||`${SITE_URL}/.netlify/functions/meta-oauth-callback`;
export default async()=>{try{
 if(!APP_ID())return json({error:'META_APP_ID must be configured in Netlify before Meta can be connected.'},400);
 const url=new URL('https://www.facebook.com/dialog/oauth');
 url.searchParams.set('client_id',APP_ID());
 url.searchParams.set('redirect_uri',CALLBACK());
 url.searchParams.set('response_type','code');
 url.searchParams.set('config_id',CONFIG_ID());
 return json({url:url.toString()});
}catch(e){console.error('Meta OAuth start failed:',e?.message);return json({error:e.message||'Could not start Meta authorization.'},400);}};
