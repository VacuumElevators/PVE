import { handleIdentify } from './handlers/identify.js';
import { handleLookup } from './handlers/lookup.js';
import { handleDelete } from './handlers/delete.js';

const ALLOWED_ORIGINS = new Set([
  'https://vacuumelevators.com',
  'https://www.vacuumelevators.com',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight: only /identify is browser-facing.
    if (method === 'OPTIONS') {
      if (path === '/identify') return handlePreflight(request);
      return new Response(null, { status: 405 });
    }

    // Health check.
    if (path === '/' && method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (path === '/identify') {
      if (method === 'POST') return handleIdentify(request, env);
      if (method === 'DELETE') return handleDelete(request, env);
      return methodNotAllowed(['POST', 'DELETE', 'OPTIONS']);
    }

    if (path === '/lookup') {
      if (method === 'GET') return handleLookup(request, env);
      return methodNotAllowed(['GET']);
    }

    return new Response('Not Found', { status: 404 });
  },
};

function handlePreflight(request) {
  const origin = request.headers.get('origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

function methodNotAllowed(allowed) {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allowed.join(', ') },
  });
}
