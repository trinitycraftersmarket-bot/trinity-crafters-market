const SITE_URL=(process.env.URL||'https://trinitylutzmarkets.com').replace(/\/$/,'');
const GRAPH_VERSION=process.env.META_GRAPH_VERSION||'v24.0';
const APP_ID=()=>process.env.META_APP_ID||'';
const APP_SECRET=()=>process.env.META_APP_SECRET||'';
const CALLBACK=()=>process.env.META_OAUTH_REDIRECT_URI||`${SITE_URL}/.netlify/functions/meta-oauth-callback`;
const page=(title,message,status=200)=>new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px;line-height:1.5}a{color:#0866ff}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="${SITE_URL}/#admin">Return to Trinity Crafters Market</a></p></body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
export default async req=>{
 try{
  const url=new URL(req.url);
  const error=url.searchParams.get('error_description')||url.searchParams.get('error');
  if(error)return page('Meta connection cancelled',String(error),400);
  const code=url.searchParams.get('code');
  if(!code)return page('Meta connection incomplete','Meta did not return an authorization code.',400);
  if(!APP_ID()||!APP_SECRET())return page('Meta setup incomplete','META_APP_ID and META_APP_SECRET must be configured in Netlify before authorization can finish.',500);
  const tokenUrl=new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id',APP_ID());
  tokenUrl.searchParams.set('client_secret',APP_SECRET());
  tokenUrl.searchParams.set('redirect_uri',CALLBACK());
  tokenUrl.searchParams.set('code',code);
  const r=await fetch(tokenUrl,{headers:{Accept:'application/json'}});
  const v=await r.json().catch(()=>({}));
  if(!r.ok||!v.access_token)throw Error(v?.error?.message||'Meta did not return an access token.');
  // Never render or log the token. This callback validates the OAuth exchange only;
  // the site's publishing credential remains the Page access token stored in Netlify.
  return page('Meta authorization successful','Meta accepted the authorization. You can return to the Social Media Center.');
 }catch(e){console.error('Meta OAuth callback failed:',e?.message);return page('Meta authorization failed',String(e?.message||'Could not complete Meta authorization.'),400);}
};
