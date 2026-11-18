// Printable report documents, ported from the classic UI's two print
// builders so the paper output is unchanged: printTable (the Reports
// tab's generic letter-portrait table) and printExpenseReport (the
// expense reports' letter-landscape itemized sheet). Both open a new
// window with a self-contained document and print it on load — the same
// documents the classic app produces, cell for cell.
import { esc } from './api.js?v=20261118-81';

const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);

// §36: one shared screen-only controls row for every printable document.
// In the Android app WebView window.print() is a no-op and the opened
// document has no tab to close, so a bare print page traps the user on
// whatever backdrop the WebView shows through (and the documents set no
// background of their own, so it rendered black-on-dark-green). The row
// gives Print + Close + the phone hint, and every builder forces a
// light canvas (body background + color-scheme) — all screen only:
// @media print hides the row, so paper output is unchanged.
// §39: Close is a cascade — window.close(); if the window is still
// open after ~300ms and there is history, history.back() (in the app
// the print page is a same-webview navigation, so Back returns to the
// app screen as the user left it); only if STILL open after a further
// ~400ms does it fall back to reloading the app URL.
// §51: the cascade tested green as markup but failed in Scott's hand —
// small targets on a zoomed-out wide-table page, Print a platform
// no-op in the app WebView, and Close depending entirely on JS the app
// window may not honor. The row is robust by construction now: BIG
// targets (min-height 44px, larger text, full-width wrap on narrow
// screens) and a third control that is a PLAIN ANCHOR ("← Back to the
// app", button-styled) — zero JavaScript, always navigates — as the
// guaranteed floor under the JS Close cascade.
const PRINT_CONTROLS_CSS = `:root{color-scheme:light}.print-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin:0 0 12px}.print-controls button,.print-controls .print-back{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;font-size:12pt;font-family:inherit;cursor:pointer}.print-controls .print-back{border:1px solid #888;border-radius:4px;background:#f0f0f0;color:#111;text-decoration:none}.print-controls p{flex:1 1 100%;margin:4px 0 0;font-size:10pt;color:#555}@media(max-width:600px){.print-controls button,.print-controls .print-back{flex:1 1 100%}}@media print{.print-controls{display:none}}`;
// §75 (Nov 18, 2026): the return controls RELOAD. Since §74 the print
// page lives at the app's own URL, so the old chain's last steps were
// no-ops: location.href to the same path only drops the hash (no
// navigation, no reload) and there is no history entry to go back to.
// location.reload() re-fetches the app from the server at this URL —
// hash route intact — and the '?from=print' fallback URL differs from
// the current path, so it really navigates even without JS.
// §78 (Nov 18, 2026): the Print button asks the Android app first.
// window.print() is a no-op inside the app WebView (Capacitor) — the
// native shell exposes a TrinityPrint bridge (MainActivity) that opens
// the Android print dialog for the current page. In a real browser the
// bridge is absent and the button falls back to window.print(). And
// every plan page now also lists its vendor names as plain text under
// the image: the names were always drawn ON the image, but at phone
// size the tags shrink to unreadable specks — Scott, Nov 18, 2026:
// "Names on floor plan on the print screen not listed."
const PRINT_ONCLICK = "if(window.TrinityPrint&&TrinityPrint.print){TrinityPrint.print()}else{window.print()}";
function printControls() {
  return `<div class="print-controls"><button type="button" onclick="${PRINT_ONCLICK}">Print / Save PDF</button> <button type="button" onclick="window.close();setTimeout(function(){if(!window.closed)location.reload()},300);setTimeout(function(){if(!window.closed)location.href='https://trinitylutzmarkets.com/v2/?from=print'},800)">Close</button> <a class="print-back" href="https://trinitylutzmarkets.com/v2/?from=print" onclick="location.reload();return false;">← Back to the app</a><p>On a phone? Printing lives in the browser menu — ⋮ → Share → Print / Save as PDF — or tap Back to the app to return.</p></div>`;
}
const dateKey = v => String(v || '').slice(0, 10);
const niceShortDate = v => {
  const key = dateKey(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || '—';
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// §76 (Nov 18, 2026): the print pages no longer auto-fire window.print()
// on load. The auto-opened print dialog is modal in desktop Chrome —
// while it is up, every click on the page (Close, Back) is swallowed,
// which is what made the return controls look dead in verification;
// in Scott's phone WebView the call was a no-op anyway. The Print
// button is the deliberate way in now.
// §74 (Scott, Nov 18, 2026): every printer in this file opens its page
// in THIS tab ('_self'), never a '_blank' popup — on Scott's phone the
// popups got handed off to the browser app and the generated pages (and
// their buttons) misbehaved there. The shared controls' Close chain
// (close -> reload -> app root, §75) is the way back.
export function printTable(title, subtitle, headers, rows, summary = '') {
  const w = window.open('', '_self');
  if (!w) throw Error('Could not open the print view in this browser.');
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><meta name="viewport" content="width=device-width"><style>@page{size:letter;margin:.5in}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:10pt;margin:0;background:#fff}h1{font-size:19pt;margin:0 0 3px}h2{font-size:12pt;font-weight:normal;margin:0 0 12px}.summary{font-weight:bold;margin:0 0 12px}table{width:100%;border-collapse:collapse;table-layout:auto}th,td{padding:6px 5px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-size:8.5pt;text-transform:uppercase;border-bottom:2px solid #222}tr{break-inside:avoid}footer{margin-top:16px;font-size:8pt;color:#555}${PRINT_CONTROLS_CSS}</style></head><body>${printControls()}<h1>Trinity Crafters Market</h1><h2>${esc(title)}${subtitle ? ' · ' + esc(subtitle) : ''}</h2>${summary ? `<p class="summary">${esc(summary)}</p>` : ''}<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table><footer>Printed ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern</footer></body></html>`);
  w.document.close();
}

// Attendance list print (Attendees): the clean list layout, followed by
// the event's saved floor plans — the ORIGINAL uploaded plan images,
// one plan per page, per the standing floor-plan standard (never a
// redrawn schematic).
export function printAttendance({ market, subtitle, summary, headers, rows, plans = [], legend = '' }) {
  const w = window.open('', '_self');
  if (!w) throw Error('Could not open the print view in this browser.');
  const planPages = plans.map(p => `<section class="plan${p.names && p.names.length ? ' with-names' : ''}"><h2>${esc(p.title)}</h2><img src="${p.image}" alt="${esc(p.title)}">${p.names && p.names.length ? `<div class="plan-names"><h3>Vendor names — ${esc(p.title)}</h3><ul>${p.names.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}</section>`).join('');
  w.document.write(`<!doctype html><html><head><title>Attendance List</title><meta name="viewport" content="width=device-width"><style>@page{size:letter landscape;margin:.5in}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:10pt;margin:0;background:#fff}h1{font-size:19pt;margin:0 0 3px}h2{font-size:12pt;font-weight:normal;margin:0 0 12px}.summary{font-weight:bold;margin:0 0 4px}.legend{font-size:9pt;color:#333;margin:0 0 12px}table{width:100%;border-collapse:collapse}th,td{padding:6px 5px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-size:8.5pt;text-transform:uppercase;border-bottom:2px solid #222}tr{break-inside:avoid}footer{margin-top:16px;font-size:8pt;color:#555}.plan{break-before:page}.plan h2{font-size:14pt;font-weight:bold}.plan img{width:100%;max-height:6.6in;object-fit:contain}.plan.with-names img{max-height:5.3in}.plan-names{margin-top:10px}.plan-names h3{font-size:11pt;margin:0 0 4px}.plan-names ul{columns:3;column-gap:20px;margin:0;padding-left:15px;font-size:9pt;line-height:1.55}@media(max-width:700px){.plan-names ul{columns:2}}@media screen{body{overflow-x:auto}table{min-width:1040px}}${PRINT_CONTROLS_CSS}</style></head><body>${printControls()}<h1>Trinity Crafters Market</h1><h2>Attendance List · ${esc(market || '')}${subtitle ? ' · ' + esc(subtitle) : ''}</h2>${summary ? `<p class="summary">${esc(summary)}</p>` : ''}${legend ? `<p class="legend">${esc(legend)}</p>` : ''}<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>${planPages}<footer>Printed ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern</footer></body></html>`);
  w.document.close();
}

export function printExpenseReport(rows, filterLabel, isTumblerRow) {
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const quantity = rows.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
  const tumblerOnly = rows.length > 0 && rows.every(isTumblerRow);
  const title = tumblerOnly ? 'Tumbler Credit Reconciliation' : 'Itemized Expense Report';
  const printable = rows.map(r => '<tr><td>' + esc(niceShortDate(r.expense_date)) + '</td><td>' + esc(niceShortDate(r.event_date)) + '</td><td>' + esc(r.market) + '</td><td>' + esc(r.category) + '</td><td><strong>' + esc(r.description) + '</strong>' + (r.payee ? '<div>' + esc(r.payee) + '</div>' : '') + '</td><td style="text-align:right">' + (r.quantity || '—') + '</td><td style="text-align:right">' + esc(usd(r.amount)) + '</td><td>' + esc(r.notes || '') + '</td></tr>').join('');
  const w = window.open('', '_self');
  if (!w) throw Error('Could not open the print view in this browser.');
  w.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>@page{size:letter landscape;margin:.45in}body{font-family:Arial,sans-serif;color:#172a24;font-size:10px;background:#fff}header{border-bottom:3px solid #184d42;padding-bottom:12px;margin-bottom:15px}h1{margin:4px 0;font-size:23px}h2{font-size:16px;margin:4px 0}p{margin:6px 0}.sub{color:#475c54}.summary{display:flex;gap:35px;padding:12px 0;font-size:14px;font-weight:bold}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #cdd5d0;padding:6px;overflow-wrap:anywhere}th{background:#e9efec;text-transform:uppercase;font-size:9px}tr{break-inside:avoid}footer{margin-top:18px;display:flex;justify-content:space-between;gap:24px;color:#53635d}button{margin:12px 0;padding:8px 12px}@media print{button{display:none}}' + PRINT_CONTROLS_CSS + '</style></head><body>' + printControls() + '<header><strong>TRINITY CRAFTERS MARKET</strong><h1>' + esc(title) + '</h1><p class="sub">' + esc(filterLabel) + ' · Generated ' + esc(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })) + ' Eastern</p></header><div class="summary"><span>' + rows.length + ' expense entries</span><span>Total: ' + esc(usd(total)) + '</span>' + (quantity ? '<span>Tumblers: ' + quantity + '</span>' : '') + '</div><table><thead><tr><th>Expense date</th><th>Market date</th><th>Market</th><th>Category</th><th>Description / Payee</th><th>Qty</th><th>Amount</th><th>Notes</th></tr></thead><tbody>' + printable + '</tbody></table><footer><div>' + (tumblerOnly ? 'Non-cash invoice credits; invoice-level reconciliation is separate.' : 'Internal organizer expense records.') + '</div><div>Reviewed by: ____________________ &nbsp; Date: __________</div></footer></body></html>');
  w.document.close();
  w.focus();
  // §78: the load-fired w.print() that §76 removed from the other two
  // builders is gone here too — same modal-dialog trap on desktop, same
  // no-op in the app WebView. The shared Print button is the way in.
}
