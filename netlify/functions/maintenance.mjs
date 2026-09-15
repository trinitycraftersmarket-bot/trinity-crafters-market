import {ready,db,expire,flushMail} from '../../server/core.mjs';
import {syncCalendar} from '../../server/sync.mjs';
export default async()=>{if(!ready())return;await expire();await flushMail();const [last]=await db()`select value from market.settings where key='last_sync'`;if(process.env.GOOGLE_REFRESH_TOKEN&&(!last||Date.now()-new Date(last.value).getTime()>3600000)){try{await syncCalendar();}catch(e){await db()`insert into market.settings(key,value) values('sync_error',${e.message}) on conflict(key) do update set value=excluded.value`;}}};
