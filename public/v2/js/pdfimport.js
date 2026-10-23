// Attendee PDF parsing: reads a vendor-list PDF in the browser and
// extracts editable attendee rows (name, business, email, phone,
// category, space). Ported verbatim from the classic parseAttendeePdf
// in the legacy front end: same pdf.js build, same column-header detection
// (header aliases + x-position cuts), same line-based fallback, same
// email/phone rescue regexes, same dedupe and 500-row cap. Nothing is
// saved by this module — the caller reviews the rows and posts them to
// the 'import-attendees' action.
export async function parseAttendeePdf(file, onStatus = () => {}) {
  if (!file || file.type !== 'application/pdf') throw Error('Choose a PDF file.');
  if (file.size > 12 * 1024 * 1024) throw Error('PDF must be 12 MB or smaller.');
  onStatus('Reading PDF…');
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.mjs';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9/@.+ -]+/g, ' ').replace(/\s+/g, ' ').trim();
  const aliases = {
    first: ['first name', 'firstname', 'first'],
    last: ['last name', 'lastname', 'last'],
    phone: ['phone number', 'telephone', 'mobile', 'cell', 'phone'],
    email: ['email address', 'e-mail', 'email'],
    category: ['vendor category', 'product category', 'category'],
    business: ['business name', 'company name', 'vendor business', 'business', 'company'],
    space: ['inside/outside', 'inside outside', 'indoor/outdoor', 'indoor outdoor', 'location', 'space']
  };
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n), content = await page.getTextContent();
    const items = content.items.map(z => ({ str: String(z.str || '').trim(), x: Number(z.transform?.[4] || 0), y: Number(z.transform?.[5] || 0), w: Number(z.width || 0) })).filter(z => z.str);
    const rows = []; items.sort((a, b) => b.y - a.y || a.x - b.x).forEach(it => { let r = rows.find(q => Math.abs(q.y - it.y) < 4); if (!r) { r = { y: it.y, items: [] }; rows.push(r); } r.items.push(it); }); rows.sort((a, b) => b.y - a.y).forEach(r => r.items.sort((a, b) => a.x - b.x));
    let headerMap = {}, headerBottom = Infinity;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const r = rows[i], joined = norm(r.items.map(x => x.str).join(' '));
      for (const [key, list] of Object.entries(aliases)) {
        if (headerMap[key] != null) continue;
        let hit = r.items.find(x => list.some(a => norm(x.str) === a || norm(x.str).includes(a)));
        if (!hit && list.some(a => joined.includes(a))) {
          const words = list.flatMap(a => a.split(' ')).filter(w => w.length > 3), candidates = r.items.filter(x => words.some(w => norm(x.str).includes(w)));
          if (candidates.length) hit = candidates[0];
        }
        if (hit) { headerMap[key] = hit.x; headerBottom = Math.min(headerBottom, r.y); }
      }
    }
    const keys = Object.entries(headerMap).sort((a, b) => a[1] - b[1]);
    if (keys.length >= 3) {
      const centers = keys.map(x => x[1]), cuts = [-Infinity, ...centers.slice(1).map((x, i) => (centers[i] + x) / 2), Infinity];
      for (const r of rows.filter(r => r.y < headerBottom - 2)) {
        const obj = { name: '', business: '', email: '', phone: '', category: '', space: '' };
        keys.forEach(([key], i) => { const val = r.items.filter(z => z.x >= cuts[i] && z.x < cuts[i + 1]).map(z => z.str).join(' ').trim(); if (key === 'first') obj.name = val; else if (key === 'last') obj.name = [obj.name, val].filter(Boolean).join(' '); else if (key === 'space') obj.space = val; else obj[key] = val; });
        const rowText = r.items.map(x => x.str).join(' ');
        if (!obj.email) { const m = rowText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); if (m) obj.email = m[0]; }
        if (!obj.phone) { const m = rowText.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/); if (m) obj.phone = m[0]; }
        if (/^(inside|indoor)$/i.test(obj.space)) obj.space = 'Inside'; else if (/^(outside|outdoor)$/i.test(obj.space)) obj.space = 'Outside';
        if ((obj.name || obj.business) && (obj.email || obj.phone || obj.category || obj.space)) out.push(obj);
      }
    } else {
      for (const r of rows) {
        const text = r.items.map(x => x.str).join(' '), email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '', phone = text.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/)?.[0] || '';
        const space = /\b(inside|indoor)\b/i.test(text) ? 'Inside' : /\b(outside|outdoor)\b/i.test(text) ? 'Outside' : '';
        if (email || phone) { const cleaned = text.replace(email, '').replace(phone, '').replace(/\b(inside|indoor|outside|outdoor)\b/ig, '').replace(/\s+/g, ' ').trim(); out.push({ name: cleaned, business: '', email, phone, category: '', space }); }
      }
    }
  }
  const unique = [], seen = new Set();
  for (const r of out) { const key = (r.email || r.phone || [r.name, r.business].join('|')).toLowerCase().replace(/\s+/g, ''); if (!key || seen.has(key)) continue; seen.add(key); unique.push(r); }
  if (unique.length) return unique.slice(0, 500);
  throw Error('I could not read vendor rows from this PDF. You can still use Add row to enter the attendees manually.');
}
