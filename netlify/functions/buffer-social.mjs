import { identity } from '../../server/core.mjs';

const API = 'https://api.buffer.com';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

async function buffer(path, options = {}) {
  const key = process.env.BUFFER_API_KEY || '';
  if (!key) {
    const error = new Error('Buffer API key is not configured.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || ('Buffer request failed (' + response.status + ').'));
    error.status = response.status;
    error.detail = data;
    throw error;
  }
  return data;
}

export async function handler(event) {
  try {
    const requestLike = { headers: new Headers(event.headers || {}) };
    const who = await identity(requestLike);
    if (!who?.admin && !who?.manager) {
      return json(403, { error: 'Organizer access required.' });
    }

    if (event.httpMethod === 'GET') {
      const data = await buffer('/channels');
      const rows = Array.isArray(data) ? data : (data?.data || data?.channels || []);
      const channels = rows.map((channel) => ({
        id: String(channel.id || channel._id || ''),
        service: channel.service || channel.network || channel.type || '',
        name: channel.name || channel.display_name || channel.username || '',
        username: channel.username || ''
      }));
      return json(200, { ok: true, configured: true, channels });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed.' });
    }

    const body = JSON.parse(event.body || '{}');
    const postText = String(body.text || '').trim();
    const media = String(body.media || '').trim();
    const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter(Boolean) : [];

    if (!postText) return json(400, { error: 'Post text is required.' });
    if (!channelIds.length) return json(400, { error: 'Choose at least one Buffer channel.' });

    const when = body.dateTime ? new Date(body.dateTime) : null;
    if (when && Number.isNaN(when.getTime())) {
      return json(400, { error: 'Invalid scheduled date/time.' });
    }

    const payload = { text: postText, channel_ids: channelIds };
    if (media) payload.media = [{ url: media }];
    if (when) payload.scheduled_at = when.toISOString();
    else payload.now = true;

    const data = await buffer('/posts', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return json(200, { ok: true, data });
  } catch (error) {
    return json(error.status || 500, {
      error: error.message,
      detail: error.detail || undefined
    });
  }
}
