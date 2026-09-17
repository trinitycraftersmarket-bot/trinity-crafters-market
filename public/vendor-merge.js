(()=>{
  const originalFetch=window.fetch.bind(window);
  const normEmail=v=>String(v||'').trim().toLowerCase();
  const uniq=(items,keyFn)=>{const out=[],seen=new Set();for(const x of items||[]){const k=keyFn(x);if(!k||seen.has(k))continue;seen.add(k);out.push(x);}return out;};
  const mergeRows=rows=>{
    if(!Array.isArray(rows))return rows;
    const grouped=new Map(),unkeyed=[];
    for(const row of rows){
      const email=normEmail(row.email);
      if(!email){unkeyed.push(row);continue;}
      if(!grouped.has(email))grouped.set(email,[]);
      grouped.get(email).push(row);
    }
    const merged=[];
    for(const group of grouped.values()){
      if(group.length===1){merged.push(group[0]);continue;}
      const preferred=group.find(x=>x.source!=='pdf')||group[0];
      const dates=uniq(group.flatMap(x=>Array.isArray(x.dates)?x.dates:[]),x=>String(x.id||'')+'|'+String(x.date||'')+'|'+String(x.space||''));
      const payments=uniq(group.flatMap(x=>Array.isArray(x.payments)?x.payments:[]),x=>String(x.id||'')+'|'+String(x.paid_at||'')+'|'+String(x.amount||''));
      const regular=group.some(x=>x.regular_vendor===true);
      const monthly=group.map(x=>x.monthly_billing_amount).find(v=>v!=null)??null;
      merged.push({
        ...preferred,
        regular_vendor:regular,
        monthly_billing_amount:monthly,
        dates:dates.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))),
        payments,
        shows:dates.filter(x=>String(x.status||'').toLowerCase()==='paid').length,
        booking_spend:dates.filter(x=>String(x.status||'').toLowerCase()==='paid').reduce((n,x)=>n+Number(x.price||0),0),
        recorded_payments:payments.reduce((n,x)=>n+Number(x.amount||0),0),
        source:group.every(x=>x.source==='pdf')?'pdf':'merged',
        _merged_ids:group.map(x=>x.id)
      });
    }
    return [...merged,...unkeyed];
  };
  window.fetch=async(...args)=>{
    const res=await originalFetch(...args);
    try{
      const url=String(args[0]?.url||args[0]||'');
      if(url.includes('/.netlify/functions/api?action=vendor-list')&&res.ok){
        const clone=res.clone();
        const data=await clone.json();
        const merged=mergeRows(data);
        return new Response(JSON.stringify(merged),{status:res.status,statusText:res.statusText,headers:res.headers});
      }
    }catch{}
    return res;
  };
})();