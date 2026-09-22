import { identity } from '../../server/core.mjs';

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

async function createPost({ channelId, text, media, dateTime }) {
  const input = {
    text,
    channelId,
    schedulingType: 'automatic',
    mode: dateTime ? 'customScheduled' : 'shareNow'
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
      return reply({ ok: true, configured: true, channels });
    }

    if (request.method !== 'POST') {
      return reply({ error: 'Method not allowed.' }, 405);
    }

    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').trim();
    const media = String(body.media || '').trim();
    const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter(Boolean) : [];
    const dateTime = body.dateTime ? new Date(body.dateTime) : null;

    if (!text) return reply({ error: 'Post text is required.' }, 400);
    if (!channelIds.length) return reply({ error: 'Choose at least one Buffer channel.' }, 400);
    if (dateTime && Number.isNaN(dateTime.getTime())) {
      return reply({ error: 'Invalid scheduled date/time.' }, 400);
    }
    if (dateTime && dateTime.getTime() <= Date.now()) {
      return reply({ error: 'Scheduled time must be in the future.' }, 400);
    }

    const isoDate = dateTime ? dateTime.toISOString() : null;
    const created = [];
    const failed = [];

    for (const channelId of channelIds) {
      try {
        const post = await createPost({ channelId, text, media, dateTime: isoDate });
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
