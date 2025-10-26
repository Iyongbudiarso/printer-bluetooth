'use strict';

const SHARE_TARGET_PATH = '/share-target';
const SHARE_REDIRECT_URL = '/?share-target=1';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== SHARE_TARGET_PATH) {
    return;
  }
  if (event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event));
    return;
  }
  if (event.request.method === 'GET') {
    event.respondWith(Response.redirect(SHARE_REDIRECT_URL, 303));
  }
});

async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const incomingFiles = (formData.getAll('files') || []).filter(Boolean);
    const buffers = [];
    const payload = await Promise.all(
      incomingFiles.map(async (file) => {
        const buffer = await file.arrayBuffer();
        buffers.push(buffer);
        return {
          name: file.name || 'shared-image.png',
          type: file.type || 'image/png',
          lastModified: file.lastModified || Date.now(),
          buffer
        };
      })
    );

    const targetClient = await resolveShareClient(event);
    if (payload.length && targetClient) {
      targetClient.postMessage({ type: 'share-target-files', files: payload }, buffers);
      targetClient.focus?.();
    }
  } catch (error) {
    console.error('Failed to process shared content:', error);
  }

  return Response.redirect(SHARE_REDIRECT_URL, 303);
}

async function resolveShareClient(event) {
  if (event.resultingClientId) {
    const resultingClient = await self.clients.get(event.resultingClientId);
    if (resultingClient) {
      return resultingClient;
    }
  }
  if (event.clientId) {
    const existingClient = await self.clients.get(event.clientId);
    if (existingClient) {
      return existingClient;
    }
  }

  const matched = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (matched && matched.length) {
    return matched[0];
  }

  return self.clients.openWindow(SHARE_REDIRECT_URL);
}
