// Printable report documents, ported from the classic UI's two print
// builders so the paper output is unchanged: printTable (the Reports
// tab's generic letter-portrait table) and printExpenseReport (the
// expense reports' letter-landscape itemized sheet). Both open a new
// window with a self-contained document and print it on load — the same
// documents the classic app produces, cell for cell.
import { esc } from './api.js?v=20261023-17';

const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);
const dateKey = v => String(v || '').slice(0, 10);
const niceShortDate = v => {
  const key = dateKey(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || '—';
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function printTable(title, subtitle, headers, rows, summary = '') {
  const w = window.open('', '_blank');
  if (!w) throw Error('Allow pop-ups to print this report.');
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><meta name="viewport" content="width=device-width"><style>@page{size:letter;margin:.5in}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:10pt;margin:0}h1{font-size:19pt;margin:0 0 3px}h2{font-size:12pt;font-weight:normal;margin:0 0 12px}.summary{font-weight:bold;margin:0 0 12px}table{width:100%;border-collapse:collapse;table-layout:auto}th,td{padding:6px 5px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-size:8.5pt;text-transform:uppercase;border-bottom:2px solid #222}tr{break-inside:avoid}footer{margin-top:16px;font-size:8pt;color:#555}</style></head><body><h1>Trinity Crafters Market</h1><h2>${esc(title)}${subtitle ? ' · ' + esc(subtitle) : ''}</h2>${summary ? `<p class="summary">${esc(summary)}</p>` : ''}<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table><footer>Printed ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern</footer><script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// Attendance list print (Attendees): the clean list layout, followed by
// the event's saved floor plans — the ORIGINAL uploaded plan images,
// one plan per page, per the standing floor-plan standard (never a
// redrawn schematic).
export function printAttendance({ market, subtitle, summary, headers, rows, plans = [] }) {
  const w = window.open('', '_blank');
  if (!w) throw Error('Allow pop-ups to print this report.');
  const planPages = plans.map(p => `<section class="plan"><h2>${escHtml(p.title)}</h2><img src="${p.image}" alt="${escHtml(p.title)}"></section>`).join('');
  w.document.write(`<!doctype html><html><head><title>Attendance List</title><meta name="viewport" content="width=device-width"><style>@page{size:letter;margin:.5in}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:10pt;margin:0}h1{font-size:19pt;margin:0 0 3px}h2{font-size:12pt;font-weight:normal;margin:0 0 12px}.summary{font-weight:bold;margin:0 0 12px}table{width:100%;border-collapse:collapse}th,td{padding:6px 5px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-size:8.5pt;text-transform:uppercase;border-bottom:2px solid #222}tr{break-inside:avoid}footer{margin-top:16px;font-size:8pt;color:#555}.plan{break-before:page}.plan h2{font-size:14pt;font-weight:bold}.plan img{width:100%;max-height:9.5in;object-fit:contain}</style></head><body><h1>Trinity Crafters Market</h1><h2>Attendance List · ${escHtml(market || '')}${subtitle ? ' · ' + escHtml(subtitle) : ''}</h2>${summary ? `<p class="summary">${escHtml(summary)}</p>` : ''}<table><thead><tr>${headers.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${escHtml(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>${planPages}<footer>Printed ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern</footer><script>window.onload=()=>setTimeout(()=>window.print(),50)<\/script></body></html>`);
  w.document.close();
}

export function printExpenseReport(rows, filterLabel, isTumblerRow) {
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const quantity = rows.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
  const tumblerOnly = rows.length > 0 && rows.every(isTumblerRow);
  const title = tumblerOnly ? 'Tumbler Credit Reconciliation' : 'Itemized Expense Report';
  const printable = rows.map(r => '<tr><td>' + esc(niceShortDate(r.expense_date)) + '</td><td>' + esc(niceShortDate(r.event_date)) + '</td><td>' + esc(r.market) + '</td><td>' + esc(r.category) + '</td><td><strong>' + esc(r.description) + '</strong>' + (r.payee ? '<div>' + esc(r.payee) + '</div>' : '') + '</td><td style="text-align:right">' + (r.quantity || '—') + '</td><td style="text-align:right">' + esc(usd(r.amount)) + '</td><td>' + esc(r.notes || '') + '</td></tr>').join('');
  const w = window.open('', '_blank');
  if (!w) throw Error('Please allow pop-ups to print this expense report.');
  w.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>@page{size:letter landscape;margin:.45in}body{font-family:Arial,sans-serif;color:#172a24;font-size:10px}header{border-bottom:3px solid #184d42;padding-bottom:12px;margin-bottom:15px}h1{margin:4px 0;font-size:23px}h2{font-size:16px;margin:4px 0}p{margin:6px 0}.sub{color:#475c54}.summary{display:flex;gap:35px;padding:12px 0;font-size:14px;font-weight:bold}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #cdd5d0;padding:6px;overflow-wrap:anywhere}th{background:#e9efec;text-transform:uppercase;font-size:9px}tr{break-inside:avoid}footer{margin-top:18px;display:flex;justify-content:space-between;gap:24px;color:#53635d}button{margin:12px 0;padding:8px 12px}@media print{button{display:none}} </style></head><body><button onclick="window.print()">Print / Save PDF</button><header><strong>TRINITY CRAFTERS MARKET</strong><h1>' + esc(title) + '</h1><p class="sub">' + esc(filterLabel) + ' · Generated ' + esc(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })) + ' Eastern</p></header><div class="summary"><span>' + rows.length + ' expense entries</span><span>Total: ' + esc(usd(total)) + '</span>' + (quantity ? '<span>Tumblers: ' + quantity + '</span>' : '') + '</div><table><thead><tr><th>Expense date</th><th>Market date</th><th>Market</th><th>Category</th><th>Description / Payee</th><th>Qty</th><th>Amount</th><th>Notes</th></tr></thead><tbody>' + printable + '</tbody></table><footer><div>' + (tumblerOnly ? 'Non-cash invoice credits; invoice-level reconciliation is separate.' : 'Internal organizer expense records.') + '</div><div>Reviewed by: ____________________ &nbsp; Date: __________</div></footer></body></html>');
  w.document.close();
  w.focus();
  w.addEventListener('load', () => w.print(), { once: true });
}
