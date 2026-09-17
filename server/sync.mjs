import crypto from 'node:crypto';
import {db,audit} from './core.mjs';

const b64url=v=>Buffer.from(v).toString('base64url');
async function googleToken(){
 const raw=process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
 if(raw){
  let sa;try{sa=JSON.parse(raw);}catch{throw Error('Google service account JSON is invalid. Re-paste the complete JSON into Netlify.');}
  if(!sa.client_email||!sa.private_key)throw Error('Google service account JSON is missing client_email or private_key.');
  const now=Math.floor(Date.now()/1000),header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'})),claims=b64url(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/calendar',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const unsigned=header+'.'+claims,signature=crypto.sign('RSA-SHA256',Buffer.from(unsigned),sa.private_key).toString('base64url');
  const auth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature})});
  const token=await auth.json();if(!auth.ok||!token.access_token)throw Error('Google service account authentication failed.');return token.access_token;
 }
 if(process.env.GOOGLE_REFRESH_TOKEN&&process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET){
  const auth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:process.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})});const token=await auth.json();if(!auth.ok)throw Error('Google Calendar needs reconnection.');return token.access_token;
 }
 throw Error('Connect Google Calendar in the website settings first.');
}
export async function syncCalendar(){
 const accessToken=await googleToken();
 const items=[];let page;const start=new Date();start.setUTCHours(0,0,0,0);const end=new Date(start);end.setUTCFullYear(end.getUTCFullYear()+2);
 do{const q=new URLSearchParams({timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',showDeleted:'true',maxResults:'2500',timeZone:'America/New_York'});if(page)q.set('pageToken',page);
 const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID||'trinitycraftersmarket@gmail.com')}/events?${q}`,{headers:{Authorization:`Bearer ${accessToken}`}});const v=await r.json();if(!r.ok){console.error('Calendar API failed',r.status,v?.error?.message||'');throw Error(r.status===403?'Calendar access denied. Make sure the Trinity Crafters Market calendar is shared with the service account with permission to make changes.':'Calendar sync failed. Existing dates were preserved.');}items.push(...v.items||[]);page=v.nextPageToken;}while(page);
 let added=0,flagged=0;
 await db().begin(async tx=>{await tx`select pg_advisory_xact_lock(708821)`;
 for(const item of items){const [existing]=await tx`select * from market.events where calendar_id=${item.id}`;
 const matches=/^trinity crafters market(?:\b|$)/i.test(item.summary||'');
 if(item.status==='cancelled'||!matches){if(existing){await tx`update market.events set sync_alert='Calendar event cancelled or renamed; review bookings and close this date if needed.' where id=${existing.id}`;flagged++;}continue;}
 const raw=item.start?.dateTime||item.start?.date;if(!raw)continue;
 const date=item.start.date||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(raw));
 if(existing){if(String(existing.date).slice(0,10)!==date){await tx`update market.events set sync_alert=${'Calendar date changed to '+date+'. Review before moving bookings.'} where id=${existing.id}`;flagged++;}continue;}
 const [location]=await tx`select * from market.locations where id='11111111-1111-4111-8111-111111111111'`;
 const [duplicate]=await tx`select * from market.events where location_id=${location.id} and date=${date}`;
 if(duplicate){if(!duplicate.calendar_id)await tx`update market.events set calendar_id=${item.id} where id=${duplicate.id}`;continue;}
 await tx`insert into market.events(location_id,date,title,calendar_id,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${location.id},${date},${item.summary},${item.id},${location.indoor_capacity},${location.outdoor_capacity},${location.indoor_price},${location.outdoor_price})`;added++;
 }
 await tx`insert into market.settings(key,value) values('last_sync',${new Date().toISOString()}) on conflict(key) do update set value=excluded.value`;await audit(tx,'calendar','sync',{added,flagged});});return {added,flagged};
}
