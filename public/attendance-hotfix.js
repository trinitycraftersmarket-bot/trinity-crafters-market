// Attendance list hotfix: cancellation, fresh attendance state, and clean report printing.
async function attendanceHotfixApi(action, payload) {
  const token = sessionStorage.getItem('market-token');
  const response = await fetch('/.netlify/functions/api?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Please try again.');
  return value;
}
function addCancelButtons() {
  document.querySelectorAll('.inspection-row .report-actions').forEach(actions => {
    if (actions.querySelector('[data-cancel-attendee]')) return;
    const attendanceButton = actions.querySelector('[data-attendance-id]');
    if (!attendanceButton) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'danger'; button.textContent = 'Cancel Vendor';
    button.dataset.cancelAttendee = attendanceButton.dataset.attendanceId;
    button.dataset.imported = attendanceButton.dataset.imported || '0';
    actions.appendChild(button);
  });
}
const observer = new MutationObserver(addCancelButtons);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', addCancelButtons); addCancelButtons();

// Replace browser "print the website" behavior for the attendance button with a dedicated report.
function cleanText(el) { return (el?.textContent || '').replace(/\s+/g, ' ').trim(); }
function buildAttendanceReport() {
  const rows = [...document.querySelectorAll('.inspection-row')];
  if (!rows.length) return null;
  const heading = [...document.querySelectorAll('h1,h2')].find(x => /crafters market|market/i.test(cleanText(x)));
  const container = rows[0].parentElement?.parentElement || rows[0].parentElement;
  const text = cleanText(container);
  const dateMatch = text.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,?\s+[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}/);
  const locationLine = [...document.querySelectorAll('p,small')].map(cleanText).find(x => /10\s*(?:AM|A\.M\.)\s*[–-]\s*3\s*(?:PM|P\.M\.)/i.test(x)) || '';
  const vendorRows = rows.map((row, i) => {
    const name = cleanText(row.querySelector('h3')) || `Vendor ${i+1}`;
    const firstP = [...row.querySelectorAll('p')].map(cleanText).find(Boolean) || '';
    const parts = firstP.split('·').map(x=>x.trim()).filter(Boolean);
    const business = parts[0] || name, category = parts[1] || '', space = parts[2] || '';
    const phone = parts.find(x=>/[0-9]{3}.*[0-9]{3}.*[0-9]{4}/.test(x)) || '';
    const labels = [...row.querySelectorAll('strong')].map(cleanText);
    const allText = cleanText(row);
    const inspection = /needs correction/i.test(allText) ? 'Needs correction' : /refused compliance/i.test(allText) ? 'Refused' : /inspection approved|approved to sell/i.test(allText) ? 'Approved' : 'Not inspected';
    const attendance = (allText.match(/Attendance:\s*(Checked in|No show|Not marked)/i)||[])[1] || 'Not marked';
    return `<tr><td class="num">${i+1}</td><td><strong>${escapeReport(name)}</strong>${business!==name?`<div>${escapeReport(business)}</div>`:''}</td><td>${escapeReport(category)}</td><td>${escapeReport(space)}</td><td>${escapeReport(phone)}</td><td>${escapeReport(inspection)}</td><td>${escapeReport(attendance)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><title>Attendance Report</title><meta charset="utf-8"><style>
  @page{size:letter portrait;margin:.45in}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;font-size:10pt}.report-head{border-bottom:3px solid #123f38;padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;gap:20px}.brand{font-size:20pt;font-family:Georgia,serif;color:#123f38}.subtitle{font-size:12pt;font-weight:bold;margin-top:4px}.meta{text-align:right;line-height:1.5;color:#333}.summary{margin:0 0 12px;font-size:9.5pt}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#123f38;color:white;text-align:left;padding:7px 6px;font-size:8.5pt}td{padding:7px 6px;border-bottom:1px solid #bbb;vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}.num{width:4%;text-align:center}th:nth-child(2){width:23%}th:nth-child(3){width:18%}th:nth-child(4){width:10%}th:nth-child(5){width:16%}th:nth-child(6){width:16%}th:nth-child(7){width:13%}td div{font-size:8.5pt;color:#444;margin-top:2px}.foot{margin-top:14px;padding-top:8px;border-top:1px solid #aaa;font-size:8pt;color:#555}.no-print{margin:12px 0}@media print{.no-print{display:none}}
  </style></head><body><div class="report-head"><div><div class="brand">Trinity Crafters Market</div><div class="subtitle">Vendor Attendance & Inspection Report</div></div><div class="meta"><strong>${escapeReport(dateMatch?.[0]||'Market Date')}</strong><br>${escapeReport(locationLine)}</div></div><div class="summary"><strong>${rows.length} vendors</strong> &nbsp;•&nbsp; Printed ${new Date().toLocaleString()}</div><table><thead><tr><th>#</th><th>Vendor / Business</th><th>Category</th><th>Space</th><th>Phone</th><th>Inspection</th><th>Attendance</th></tr></thead><tbody>${vendorRows}</tbody></table><div class="foot">Organizer report • Trinity Crafters Market</div><script>window.onload=()=>setTimeout(()=>window.print(),150);<\/script></body></html>`;
}
function escapeReport(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

document.addEventListener('click', async event => {
  const printButton = event.target.closest('button,a');
  if (printButton && /print\s+(attendance|attendee)|attendance\s+(list|report)/i.test(cleanText(printButton))) {
    const report = buildAttendanceReport();
    if (report) {
      event.preventDefault(); event.stopImmediatePropagation();
      const w = window.open('', '_blank');
      if (!w) { alert('Please allow pop-ups to print the attendance report.'); return; }
      w.document.open(); w.document.write(report); w.document.close();
      return;
    }
  }
  const cancelButton = event.target.closest('[data-cancel-attendee]');
  if (cancelButton) {
    event.preventDefault(); event.stopImmediatePropagation();
    const card = cancelButton.closest('.inspection-row');
    const vendor = card?.querySelector('h3')?.textContent?.trim() || 'this vendor';
    if (!confirm(`Cancel ${vendor} for this market date?\n\nTheir booth and category inventory will be released so the space can be sold again.`)) return;
    const originalText = cancelButton.textContent; cancelButton.disabled = true; cancelButton.textContent = 'Cancelling…';
    try {
      const id = cancelButton.dataset.cancelAttendee, imported = cancelButton.dataset.imported === '1';
      if (imported) await attendanceHotfixApi('imported-attendance', { id, state: 'remove' });
      else await attendanceHotfixApi('booking', { id, status: 'cancelled' });
      const notice = document.querySelector('#notice'); if (notice) notice.textContent = 'Vendor cancelled. Inventory has been released for resale.';
      location.reload();
    } catch (error) { const notice = document.querySelector('#notice'); if (notice) notice.textContent = error.message || 'Could not cancel vendor.'; cancelButton.disabled = false; cancelButton.textContent = originalText; }
    return;
  }
  const button = event.target.closest('[data-attendance-id]'); if (!button) return;
  const originalText = button.textContent;
  const expectedNotice = button.dataset.state === 'checked_in' ? 'Vendor checked in.' : button.dataset.state === 'no_show' ? 'Vendor marked no show.' : 'Attendance cleared.';
  let tries=0; const timer=setInterval(()=>{tries++; const n=document.querySelector('#notice')?.textContent?.trim(); if(n===expectedNotice){clearInterval(timer);location.reload();}else if(tries>=30){clearInterval(timer);button.textContent=originalText;}},100);
}, true);
