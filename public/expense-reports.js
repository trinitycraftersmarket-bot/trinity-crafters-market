// Organizer-only printable expense reports; vendor cancellation credits are intentionally excluded.
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents || 0)/100);
  const dateKey = value => String(value || '').slice(0,10);
  const nice = value => {
    const key=dateKey(value);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || '—';
    return new Date(key+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  };
  const isTumbler = row => String(row.category||'').toLowerCase()==='tumbler credit'||String(row.description||'').toLowerCase().includes('tumbler credit');
  const isAdminTab = () => {
    if(location.hash.split('?')[0]!=='#admin') return '';
    return document.querySelector('#app .tabs [data-tab].selected')?.dataset.tab || '';
  };
  let loading=false, renderedPanel=null;

  function csvDownload(rows) {
    const header=['Expense date','Market date','Market','Category','Description','Payee','Tumblers','Amount ($)','Notes'];
    const guard = v => {const s=String(v??'');return /^[=+@-]/.test(s)?("'"+s):s;};
    const quote = v => '"'+guard(v).replace(/"/g,'""')+'"';
    const csv=[header,...rows.map(r=>[dateKey(r.expense_date),dateKey(r.event_date),r.market,r.category,r.description,r.payee,r.quantity,(Number(r.amount)/100).toFixed(2),r.notes])].map(row=>row.map(quote).join(',')).join('\r\n');
    const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);
    anchor.download='trinity-expenses-'+new Date().toISOString().slice(0,10)+'.csv';anchor.click();
    setTimeout(()=>URL.revokeObjectURL(anchor.href),1500);
  }
  function printReport(rows, filterLabel) {
    const total=rows.reduce((sum,r)=>sum+Number(r.amount||0),0);
    const quantity=rows.reduce((sum,r)=>sum+Number(r.quantity||0),0);
    const tumblerOnly=rows.length>0&&rows.every(isTumbler);
    const title=tumblerOnly?'Tumbler Credit Reconciliation':'Itemized Expense Report';
    const printable=rows.map(r=>'<tr><td>'+esc(nice(r.expense_date))+'</td><td>'+esc(nice(r.event_date))+'</td><td>'+esc(r.market)+'</td><td>'+esc(r.category)+'</td><td><strong>'+esc(r.description)+'</strong>'+(r.payee?'<div>'+esc(r.payee)+'</div>':'')+'</td><td style="text-align:right">'+(r.quantity||'—')+'</td><td style="text-align:right">'+esc(money(r.amount))+'</td><td>'+esc(r.notes||'')+'</td></tr>').join('');
    const w=window.open('','_blank');
    if(!w){alert('Please allow pop-ups to print this expense report.');return;}
    w.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+esc(title)+'</title><style>@page{size:letter landscape;margin:.45in}body{font-family:Arial,sans-serif;color:#172a24;font-size:10px}header{border-bottom:3px solid #184d42;padding-bottom:12px;margin-bottom:15px}h1{margin:4px 0;font-size:23px}h2{font-size:16px;margin:4px 0}p{margin:6px 0}.sub{color:#475c54}.summary{display:flex;gap:35px;padding:12px 0;font-size:14px;font-weight:bold}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #cdd5d0;padding:6px;overflow-wrap:anywhere}th{background:#e9efec;text-transform:uppercase;font-size:9px}tr{break-inside:avoid}footer{margin-top:18px;display:flex;justify-content:space-between;gap:24px;color:#53635d}button{margin:12px 0;padding:8px 12px}@media print{button{display:none}} </style></head><body><button onclick="window.print()">Print / Save PDF</button><header><strong>TRINITY CRAFTERS MARKET</strong><h1>'+esc(title)+'</h1><p class="sub">'+esc(filterLabel)+' · Generated '+esc(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}))+' Eastern</p></header><div class="summary"><span>'+rows.length+' expense entries</span><span>Total: '+esc(money(total))+'</span>'+(quantity?'<span>Tumblers: '+quantity+'</span>':'')+'</div><table><thead><tr><th>Expense date</th><th>Market date</th><th>Market</th><th>Category</th><th>Description / Payee</th><th>Qty</th><th>Amount</th><th>Notes</th></tr></thead><tbody>'+printable+'</tbody></table><footer><div>'+ (tumblerOnly?'Non-cash invoice credits; invoice-level reconciliation is separate.':'Internal organizer expense records.')+'</div><div>Reviewed by: ____________________ &nbsp; Date: __________</div></footer></body></html>');
    w.document.close();
    w.focus();
    w.addEventListener('load',()=>w.print(),{once:true});
  }

  function build(panel, data, mode) {
    const events=new Map((data.allEvents||[]).map(e=>[String(e.id),e]));
    const locations=new Map((data.locations||[]).map(l=>[String(l.id),l]));
    const all=(data.expenses||[]).map(r=>{
      const event=events.get(String(r.event_id))||{};
      const location=locations.get(String(event.location_id))||{};
      const tumbler=isTumbler(r);
      return {...r,market:event.title?(location.market_name||event.title):'General / Not assigned',
        quantity:tumbler?Number(r.tumbler_quantity||0):0};
    });
    const section=document.createElement('section');section.className='card section';section.id='itemized-expense-report';
    section.innerHTML='<h2>Itemized Expense Report</h2><p>Print all expenses or a separate reconciliation for Ashley / Salty Luna Co. Cancellation credits are not included.</p>'+
      '<div class="grid2"><label>Report type<select id="expense-rpt-kind"><option value="all">All expenses</option><option value="tumbler">Tumbler Credits — Ashley</option><option value="other">Other expenses</option></select></label>'+
      '<label>Market date<select id="expense-rpt-market"><option value="">All market dates</option><option value="general">General / No market assigned</option>'+[...events.values()].sort((a,b)=>dateKey(b.date).localeCompare(dateKey(a.date))).map(e=>'<option value="'+esc(e.id)+'">'+esc(nice(e.date)+' — '+(locations.get(String(e.location_id))?.market_name||e.title||'Market'))+'</option>').join('')+'</select></label>'+
      '<label>Expense date from<input type="date" id="expense-rpt-from"></label><label>Expense date through<input type="date" id="expense-rpt-to"></label></div>'+
      '<div class="actions"><button id="expense-rpt-print" type="button">Print Expense Report</button><button class="secondary" id="expense-rpt-csv" type="button">Export CSV</button><button class="secondary" id="expense-rpt-tumblers" type="button">Ashley Tumbler Credits</button></div>'+
      '<p id="expense-rpt-summary"></p><div id="expense-rpt-table" class="table-wrap"></div>'+
      '<p class="muted">Tumbler credits are recorded as non-cash invoice deductions, not as payments made to Ashley. This expense report does not yet prove the invoice itself was adjusted.</p>';
    if(mode==='expenses') {
      const h=[...panel.querySelectorAll('h2')].find(x=>x.textContent.trim()==='Expense log');
      if(h) panel.insertBefore(section,h); else panel.append(section);
    } else panel.prepend(section);

    const $=id=>section.querySelector('#'+id);
    const rows=()=>{
      const kind=$('expense-rpt-kind').value,market=$('expense-rpt-market').value,from=$('expense-rpt-from').value,to=$('expense-rpt-to').value;
      return all.filter(r=>{
        const expenseDate=dateKey(r.expense_date);
        if(kind==='tumbler'&&!isTumbler(r))return false;
        if(kind==='other'&&isTumbler(r))return false;
        if(market==='general'&&r.event_id)return false;
        if(market&&market!=='general'&&String(r.event_id)!==market)return false;
        if(from&&expenseDate<from)return false;if(to&&expenseDate>to)return false;
        return true;
      }).sort((a,b)=>dateKey(a.event_date||a.expense_date).localeCompare(dateKey(b.event_date||b.expense_date))||String(a.description).localeCompare(String(b.description)));
    };
    const draw=()=>{
      const shown=rows(),total=shown.reduce((n,r)=>n+Number(r.amount||0),0),qty=shown.reduce((n,r)=>n+Number(r.quantity||0),0);
      $('expense-rpt-summary').innerHTML='<strong>'+shown.length+'</strong> entries · <strong>'+esc(money(total))+'</strong> total'+(qty?' · <strong>'+qty+'</strong> tumblers':'');
      $('expense-rpt-table').innerHTML='<table><thead><tr><th>Expense date</th><th>Market date</th><th>Market</th><th>Description / Payee</th><th>Category</th><th>Tumblers</th><th>Amount</th></tr></thead><tbody>'+
        (shown.map(r=>'<tr><td>'+esc(nice(r.expense_date))+'</td><td>'+esc(nice(r.event_date))+'</td><td>'+esc(r.market)+'</td><td><strong>'+esc(r.description)+'</strong>'+(r.payee?'<div><small>'+esc(r.payee)+'</small></div>':'')+'</td><td>'+esc(r.category)+'</td><td>'+(r.quantity||'—')+'</td><td>'+esc(money(r.amount))+'</td></tr>').join('')||'<tr><td colspan="7">No expenses match these filters.</td></tr>')+'</tbody></table>';
      $('expense-rpt-print').disabled=shown.length===0;
      $('expense-rpt-csv').disabled=shown.length===0;
    };
    section.querySelectorAll('input,select').forEach(el=>el.addEventListener('change',draw));
    $('expense-rpt-tumblers').onclick=()=>{$('expense-rpt-kind').value='tumbler';$('expense-rpt-market').value='';$('expense-rpt-from').value='';$('expense-rpt-to').value='';draw();};
    $('expense-rpt-print').onclick=()=>{const shown=rows(),filter=$('expense-rpt-kind').selectedOptions[0]?.textContent||'All expenses';printReport(shown,filter);};
    $('expense-rpt-csv').onclick=()=>csvDownload(rows());
    draw();
  }

  async function enhance() {
    const mode=isAdminTab(),panel=document.querySelector('#panel');
    if(!['reports','expenses'].includes(mode)||!panel||panel.querySelector('#itemized-expense-report')||loading)return;
    if(renderedPanel===panel&&panel.querySelector('#expense-rpt-loading'))return;
    const loadingNode=document.createElement('p');loadingNode.id='expense-rpt-loading';loadingNode.textContent='Loading itemized expenses…';
    panel.append(loadingNode);loading=true;renderedPanel=panel;
    try {
      const token=sessionStorage.getItem('market-token');
      if(!token)throw Error('Sign in as organizer to view expense reports.');
      const res=await fetch('/.netlify/functions/api?action=admin',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const data=await res.json();if(!res.ok)throw Error(data.error||'Unable to retrieve expenses.');
      if(panel.isConnected&&isAdminTab()===mode)build(panel,data,mode);
    } catch(error) {
      if(panel.isConnected)loadingNode.textContent='Expense report unavailable: '+error.message;
    } finally {loadingNode.remove();loading=false;}
  }
  let queued=false;
  const observer=new MutationObserver(()=>{
    if(queued)return;queued=true;
    queueMicrotask(()=>{queued=false;enhance();});
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',enhance);
  enhance();
})();
