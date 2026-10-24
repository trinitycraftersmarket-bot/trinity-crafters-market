// Social Media (Messages group): the Buffer-backed post center from the
// legacy social-media.js — channel status, compose with an image,
// publish now or schedule, and the Facebook Event linker. One deliberate
// difference from the legacy center: it FILTERED OUT locked/disconnected
// channels before rendering, so a dropped Facebook connection simply
// vanished (the Oct 22 "Social Media tab isn't connecting" report).
// Here every Facebook/Instagram channel is shown; a disconnected or
// locked one is greyed, un-selectable, and labelled with the fix —
// reconnect it in Buffer.
import { fnGet, fn, fnForm, esc, nice } from './api.js?v=20261023-14';

export function renderSocial(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Messages</p>
    <h2 class="display">Social Media</h2>
    <p class="lede">Posts go out through Buffer to Facebook and Instagram. Your Buffer key never reaches the browser.</p>
    <div id="v2-social-box"><div class="card empty-card">Checking Buffer connection…</div></div>`;
  const box = root.querySelector('#v2-social-box');

  async function load() {
    let v;
    try {
      v = await fnGet('buffer-social');
    } catch (e) {
      box.innerHTML = `<div class="card empty-card"><p><strong>Buffer couldn't be reached.</strong></p><p class="muted">${esc(e.message)}</p><p class="note">If this says the Buffer API key is not configured, that's a server setting — tell the organizer.</p></div>`;
      return;
    }
    const all = (v.channels || []).filter(c => /^(facebook|instagram)$/i.test(c.service || ''));
    const usable = all.filter(c => !c.locked && !c.disconnected);
    const events = v.events || [];
    box.innerHTML = `
      <section class="card">
        <p class="note" id="v2-social-status">${usable.length ? '<strong>Buffer connected.</strong> Choose Facebook, Instagram, or both.' : '<strong>Buffer is connected, but no channel is ready.</strong> Reconnect a channel below in Buffer, then reload this screen.'}</p>
        <div id="v2-social-channels">
          ${all.map(c => {
            const off = c.disconnected || c.locked;
            return `<label class="checkline channel-row ${off ? 'off' : ''}">
              <input type="checkbox" class="buffer-channel" value="${esc(c.id)}" data-service="${esc(c.service)}" ${off ? 'disabled' : 'checked'}>
              <span><strong>${esc(c.name)}</strong> <span class="muted">(${esc(c.service)})</span>
              ${c.disconnected ? '<br><span class="flag-note">Disconnected — reconnect this channel in Buffer (buffer.com → Channels), then reload here. Posts to it will fail until you do.</span>' : ''}
              ${!c.disconnected && c.locked ? '<br><span class="flag-note">Locked in Buffer — unlock it in Buffer to post here.</span>' : ''}</span>
            </label>`;
          }).join('') || '<p class="note">Buffer returned no Facebook or Instagram channels at all. Add one in Buffer (buffer.com → Channels), then reload here.</p>'}
        </div>
        <label class="sheet-field">Post text<textarea id="v2-social-text" rows="5" placeholder="Write the post…"></textarea></label>
        <label class="sheet-field">Post image<input id="v2-social-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
        <div id="v2-social-preview"></div>
        <input type="hidden" id="v2-social-media-url">
        <p class="note">Choose a photo from your phone or computer. Instagram requires an image; Facebook can use text only or an image.</p>
        <label class="sheet-field">Schedule date &amp; time<input id="v2-social-when" type="datetime-local"></label>
        <p class="note">Leave blank to publish now.</p>
        <div class="vendor-actions">
          <button class="btn primary small" id="v2-social-publish">Post / Schedule</button>
          <button class="btn small" id="v2-social-copy">Copy post</button>
        </div>
      </section>
      <section class="card">
        <h3 class="section-title">Facebook Event</h3>
        <p class="note">Connect each market date to its Facebook Event once. Then you can open that Event with the post already copied and paste it into the Event discussion.</p>
        <label class="sheet-field">Market date
          <select id="v2-fb-event">${['<option value="">Choose a market date</option>', ...events.map(e => `<option value="${esc(e.id)}" data-url="${esc(e.facebook_event_url || '')}">${esc(nice(e.date))}${e.title ? ' — ' + esc(e.title) : ''}</option>`)].join('')}</select>
        </label>
        <label class="sheet-field">Facebook Event URL<input id="v2-fb-url" type="url" placeholder="https://www.facebook.com/events/..."></label>
        <div class="vendor-actions">
          <button class="btn small" id="v2-fb-save">Save Event Link</button>
          <button class="btn small" id="v2-fb-open">Copy Post &amp; Open Event</button>
        </div>
      </section>`;

    const status = msg => { box.querySelector('#v2-social-status').innerHTML = esc(msg); };
    const text = () => box.querySelector('#v2-social-text').value;

    box.querySelector('#v2-social-file').onchange = async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const preview = box.querySelector('#v2-social-preview');
      preview.innerHTML = '<p class="note">Uploading image…</p>';
      try {
        const form = new FormData();
        form.append('image', file);
        const r = await fnForm('buffer-social', form);
        box.querySelector('#v2-social-media-url').value = r.url;
        preview.innerHTML = `<img class="social-preview-img" src="${esc(r.url)}" alt="Selected post image">`;
      } catch (err) { preview.innerHTML = `<p class="note flag-note">${esc(err.message)}</p>`; }
    };

    const eventSel = box.querySelector('#v2-fb-event');
    eventSel.onchange = () => { box.querySelector('#v2-fb-url').value = eventSel.selectedOptions[0]?.dataset.url || ''; };
    box.querySelector('#v2-fb-save').onclick = async () => {
      try {
        const url = box.querySelector('#v2-fb-url').value.trim();
        if (!eventSel.value) throw Error('Choose a market date.');
        if (!url) throw Error('Paste the Facebook Event link first.');
        await fn('buffer-social', { action: 'saveFacebookEvent', eventId: eventSel.value, url });
        eventSel.selectedOptions[0].dataset.url = url;
        ctx.toast('Facebook Event link saved.');
      } catch (e) { ctx.toast(e.message, true); }
    };
    box.querySelector('#v2-fb-open').onclick = async () => {
      try {
        const url = box.querySelector('#v2-fb-url').value.trim();
        if (!eventSel.value) throw Error('Choose a market date.');
        if (!url) throw Error('Save the Facebook Event link for this date first.');
        if (!text().trim()) throw Error('Write or generate the post first.');
        try { await navigator.clipboard.writeText(text()); }
        catch { throw Error('Your browser blocked copying. Tap Copy post first, then open the Facebook Event.'); }
        window.open(url, '_blank', 'noopener');
        ctx.toast('Post copied and Facebook opened. Tap "Say something…" and choose Paste.');
      } catch (e) { ctx.toast(e.message, true); }
    };
    box.querySelector('#v2-social-copy').onclick = async () => {
      try {
        if (!text().trim()) throw Error('Write or generate the post first.');
        await navigator.clipboard.writeText(text());
        ctx.toast('Post copied.');
      } catch (e) { ctx.toast(e.message || 'Your browser blocked copying.', true); }
    };
    box.querySelector('#v2-social-publish').onclick = async e => {
      const btn = e.currentTarget;
      try {
        const selected = [...box.querySelectorAll('.buffer-channel:checked')];
        const channels = selected.map(x => ({ id: x.value, service: x.dataset.service }));
        const media = box.querySelector('#v2-social-media-url').value.trim();
        const dt = box.querySelector('#v2-social-when').value;
        if (!channels.length) throw Error('Choose Facebook, Instagram, or both.');
        if (!text().trim()) throw Error('Write the post first.');
        if (selected.some(x => String(x.dataset.service).toLowerCase() === 'instagram') && !media) throw Error('Instagram requires an image. Choose a photo above.');
        if (dt && new Date(dt).getTime() < Date.now() + 5 * 60 * 1000) throw Error('Scheduled time must be at least 5 minutes from now.');
        if (!confirm(dt ? 'Schedule this post in Buffer?' : 'Publish this post now through Buffer?')) return;
        btn.disabled = true;
        const result = await fn('buffer-social', { text: text(), media, channels, dateTime: dt ? new Date(dt).toISOString() : null });
        if (result.partial || (result.failed || []).length) {
          status('Post created on some channels. ' + (result.failed || []).map(x => x.error).join(' | '));
          ctx.toast('Post created on some channels — see the note at the top.', true);
        } else {
          ctx.toast(dt ? 'Post scheduled successfully in Buffer.' : 'Post sent to Buffer for publishing.');
          status(dt ? 'Post scheduled in Buffer.' : 'Post sent to Buffer for publishing.');
        }
      } catch (err) { ctx.toast(err.message, true); }
      finally { btn.disabled = false; }
    };
  }

  load();
}
