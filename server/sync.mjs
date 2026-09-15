import {db,audit} from './core.mjs';
export async function syncCalendar(){
 if(!process.env.GOOGLE_REFRESH_TOKEN||!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)throw Error('Connect Google Calendar in the website settings first.');
 const auth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:process.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})});const token=await auth.json();if(!auth.ok)throw Error('Google Calendar needs reconnection.');
 const items=[];let page;const start=new Date();start.setUTCHours(0,0,0,0);const end=new Date(start);end.setUTCFullYear(end.getUTCFullYear()+2);
 do{const q=new URLSearchParams({timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',showDeleted:'true',maxResults:'2500',timeZone:'America/New_York'});if(page)q.set('pageToken',page);
 const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID||'trinitycraftersmarket@gmail.com')}/events?${q}`,{headers:{Authorization:`Bearer ${token.access_token}`}});const v=await r.json();if(!r.ok)throw Error('Calendar sync failed. Existing dates were preserved.');items.push(...v.items||[]);page=v.nextPageToken;}while(page);
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
