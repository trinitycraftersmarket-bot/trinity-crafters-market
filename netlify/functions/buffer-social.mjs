import { identity, db, supa } from '../../server/core.mjs';

const BUFFER_API = 'https://api.buffer.com';

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function bufferGraphQL(query, variables = {}) {
  const key = Netlify.env.get('BUFFER_API_KEY');
  if (!key) {
    const error = new Error('Buffer API key is not configured.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(BUFFER_API, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || ('Buffer request failed (' + response.status + ').'));
    error.status = response.status;
    error.detail = payload;
    throw error;
  }

  if (Array.isArray(payload.errors) && payload.errors.length) {
    const error = new Error(payload.errors.map((item) => item.message).filter(Boolean).join(' | ') || 'Buffer GraphQL request failed.');
    error.status = 400;
    error.detail = payload.errors;
    throw error;
  }

  return payload.data || {};
}

async function getChannels() {
  const accountData = await bufferGraphQL(`
    query GetOrganizations {
      account {
        organizations {
          id
          name
          ownerEmail
        }
      }
    }
  `);

  const organizations = accountData?.account?.organizations || [];
  if (!organizations.length) {
    const error = new Error('No Buffer organization was found for this API key.');
    error.status = 404;
    throw error;
  }

  const channels = [];
  for (const organization of organizations) {
    const channelData = await bufferGraphQL(
      `
        query GetChannels($organizationId: OrganizationId!) {
          channels(input: { organizationId: $organizationId }) {
            id
            name
            displayName
            service
            isLocked
            isDisconnected
          }
        }
      `,
      { organizationId: organization.id }
    );

    for (const channel of channelData?.channels || []) {
      channels.push({
        id: channel.id,
        service: channel.service,
        name: channel.displayName || channel.name || channel.service,
        locked: Boolean(channel.isLocked),
        disconnected: Boolean(channel.isDisconnected),
        organizationId: organization.id,
        organizationName: organization.name
      });
    }
  }

  return channels;
}

function channelService(value) {
  return String(value || '').toLowerCase();
}

async function createPost({ channelId, service, text, media, dateTime }) {
  const input = {
    text,
    channelId,
    schedulingType: 'automatic',
    mode: dateTime ? 'customScheduled' : 'shareNow',
    metadata: service === 'instagram'
      ? { instagram: { type: 'post', shouldShareToFeed: true } }
      : { facebook: { type: 'post' } }
  };

  if (dateTime) input.dueAt = dateTime;
  if (media) input.assets = [{ image: { url: media } }];

  const data = await bufferGraphQL(
    `
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess {
            post {
              id
              text
              dueAt
              channelId
              status
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `,
    { input }
  );

  const result = data?.createPost;
  if (!result?.post) {
    const error = new Error(result?.message || 'Buffer did not create the post.');
    error.status = 400;
    error.detail = result;
    throw error;
  }
  return result.post;
}

export default async (request) => {
  try {
    const who = await identity(request);
    if (!who?.admin && !who?.manager) {
      return reply({ error: 'Organizer access required.' }, 403);
    }

    if (request.method === 'GET') {
      const channels = await getChannels();
      const events = await db()`select id,date::text as date,title,facebook_event_url from market.events where date >= current_date order by date`;
      return reply({ ok: true, configured: true, channels, events });
    }

    if (request.method !== 'POST') {
      return reply({ error: 'Method not allowed.' }, 405);
    }

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('image');
      if (!(file instanceof File) || !file.size) return reply({ error: 'Choose an image to upload.' }, 400);
      if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) return reply({ error: 'Use a JPG, PNG, WEBP, or GIF image.' }, 400);
      if (file.size > 10 * 1024 * 1024) return reply({ error: 'Image must be 10 MB or smaller.' }, 400);
      const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      try {
        const { data: oldFiles } = await supa().storage.from('social-media').list('', { limit: 100, sortBy: { column: 'created_at', order: 'asc' } });
        const expired = (oldFiles || []).filter((item) => item.created_at && new Date(item.created_at) < cutoff).map((item) => item.name);
        if (expired.length) await supa().storage.from('social-media').remove(expired);
      } catch {}
      const path = Date.now() + '-' + crypto.randomUUID() + '.' + ext;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { error: uploadError } = await supa().storage.from('social-media').upload(path, bytes, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      const { data } = supa().storage.from('social-media').getPublicUrl(path);
      return reply({ ok: true, url: data.publicUrl });
    }

    const body = await request.json().catch(() => ({}));
    if (body.action === 'saveFacebookEvent') {
      const eventId = String(body.eventId || '');
      const url = String(body.url || '').trim();
      if (!eventId) return reply({ error: 'Choose a market date.' }, 400);
      if (url && !/^https:\/\/(www\.)?facebook\.com\//i.test(url)) return reply({ error: 'Enter a valid Facebook Event URL.' }, 400);
      const rows = await db()`update market.events set facebook_event_url=${url || null} where id=${eventId} returning id,date,title,facebook_event_url`;
      if (!rows.length) return reply({ error: 'Market date not found.' }, 404);
      return reply({ ok: true, event: rows[0] });
    }
    const text = String(body.text || '').trim();
    const media = String(body.media || '').trim();
    const requestedChannels = Array.isArray(body.channels) ? body.channels.filter((item) => item && item.id) : [];
    const channelIds = requestedChannels.map((item) => item.id);
    const dateTime = body.dateTime ? new Date(body.dateTime) : null;

    if (!text) return reply({ error: 'Post text is required.' }, 400);
    if (!channelIds.length) return reply({ error: 'Choose at least one Buffer channel.' }, 400);
    if (dateTime && Number.isNaN(dateTime.getTime())) {
      return reply({ error: 'Invalid scheduled date/time.' }, 400);
    }
    if (dateTime && dateTime.getTime() < Date.now() + 5 * 60 * 1000) {
      return reply({ error: 'Scheduled time must be at least 5 minutes from now.' }, 400);
    }

    const liveChannels = await getChannels();
    const allowed = new Map(
      liveChannels
        .filter((channel) => ['facebook','instagram'].includes(channelService(channel.service)) && !channel.locked && !channel.disconnected)
        .map((channel) => [String(channel.id), channelService(channel.service)])
    );
    for (const requested of requestedChannels) {
      const actualService = allowed.get(String(requested.id));
      if (!actualService) return reply({ error: 'One of the selected Buffer channels is no longer available. Refresh and try again.' }, 400);
      requested.service = actualService;
    }

    const isoDate = dateTime ? dateTime.toISOString() : null;
    const created = [];
    const failed = [];

    for (const requested of requestedChannels) {
      const channelId = requested.id;
      const service = channelService(requested.service);
      if (!['facebook','instagram'].includes(service)) {
        failed.push({ channelId, error: 'Unsupported social channel.' });
        continue;
      }
      try {
        const post = await createPost({ channelId, service, text, media, dateTime: isoDate });
        created.push(post);
      } catch (error) {
        failed.push({
          channelId,
          error: error.message
        });
      }
    }

    if (!created.length) {
      return reply({
        error: failed.map((item) => item.error).join(' | ') || 'Buffer did not create any posts.',
        failed
      }, 400);
    }

    return reply({
      ok: true,
      created,
      failed,
      partial: failed.length > 0
    });
  } catch (error) {
    return reply({
      error: error.message || 'Buffer request failed.',
      detail: error.detail || undefined
    }, error.status || 500);
  }
};
