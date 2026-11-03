// @vitest-environment jsdom
// The public site (deploy/public-site, served by nginx on nolon.dev) is plain HTML + JS with no
// package of its own; it is tested here because this package already runs jsdom.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const siteDir = resolve(__dirname, '../../../../deploy/public-site') + '/';

function loadSite(): void {
  const html = readFileSync(siteDir + 'index.html', 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  document.body.innerHTML = (body?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
  const script = readFileSync(siteDir + 'site.js', 'utf8');
  // The site script is a classic browser IIFE; run it against the jsdom globals.
  runInThisContext(script);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function submit(text: string): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const form = document.getElementById('chat-form') as HTMLFormElement;
  input.value = text;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('public site chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('uses one session for messages sent before /sessions answers', async () => {
    let sessions = 0;
    let answerSession: (r: Response) => void = () => undefined;
    const messageAuth: string[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/sessions')) {
        sessions += 1;
        return new Promise<Response>((resolve) => {
          answerSession = resolve;
        });
      }
      if (url.endsWith('/messages') && init?.method === 'POST') {
        messageAuth.push(new Headers(init.headers).get('authorization') ?? '');
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(json({ messages: [], waiting: false }));
    });
    vi.stubGlobal('fetch', fetchMock);
    loadSite();

    submit('first');
    submit('second');
    await flush();
    answerSession(json({ token: 'tok-A', expiresAt: '2026-12-03T00:00:00Z' }));
    await flush();

    expect(sessions).toBe(1);
    expect(messageAuth).toEqual(['Bearer tok-A', 'Bearer tok-A']);
    expect(localStorage.getItem('nolon-chat-token')).toBe('tok-A');
  });

  it('starts one new session when two calls get 401 on the same expired token', async () => {
    localStorage.setItem('nolon-chat-token', 'old');
    let sessions = 0;
    const messageAuth: string[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/sessions')) {
        sessions += 1;
        return Promise.resolve(
          json({ token: 'tok-' + sessions, expiresAt: '2026-12-03T00:00:00Z' }),
        );
      }
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (auth === 'Bearer old') return Promise.resolve(new Response(null, { status: 401 }));
      if (url.endsWith('/messages') && init?.method === 'POST') {
        messageAuth.push(auth);
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(json({ messages: [], waiting: false }));
    });
    vi.stubGlobal('fetch', fetchMock);
    loadSite();

    submit('first');
    submit('second');
    await flush();
    await flush();

    expect(sessions).toBe(1);
    expect(messageAuth).toEqual(['Bearer tok-1', 'Bearer tok-1']);
    expect(localStorage.getItem('nolon-chat-token')).toBe('tok-1');
  });
});
