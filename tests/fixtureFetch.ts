// Record / replay HTTP responses so adapter tests run offline against REAL
// chain data captured once by `npm run record:fixtures`.

import type { FetchFn } from '../src/chains/http.js';

export type FixtureResponses = Record<string, unknown>;

/** Stable key for a request. JSON-RPC ids are dropped so call order doesn't matter. */
export function requestKey(url: string, init?: RequestInit): string {
  const method = init?.method ?? 'GET';
  let body = '';
  if (typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      delete parsed.id;
      body = JSON.stringify(parsed);
    } catch {
      body = init.body;
    }
  }
  return `${method} ${url} ${body}`.trim();
}

export function recordingFetch(target: FixtureResponses): FetchFn {
  return async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.ok) target[requestKey(url, init)] = JSON.parse(text);
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
}

export function replayFetch(responses: FixtureResponses, overrides: FixtureResponses = {}): FetchFn {
  return async (url, init) => {
    const key = requestKey(url, init);
    const body = key in overrides ? overrides[key] : responses[key];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: `No fixture for ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
