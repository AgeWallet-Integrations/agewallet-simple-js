import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';

// Every case runs against both files customers can load.
const FILES = ['aw-loader.unminified.js', 'aw-loader.min.js'];
const repoFile = name => new URL(`../${name}`, import.meta.url);
const sources = Object.fromEntries(FILES.map(f => [f, readFileSync(repoFile(f), 'utf8')]));

const DEFAULT_LOGO = 'https://www.agewallet.com/wp-content/uploads/2025/07/age-wallet-logo-light-tmb2-cleaned-300x225.png';
const DAY_MS = 1440 * 60 * 1000;

// Base64-URL JSON, the loader's state format
const encodeState = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256Base64Url = s => createHash('sha256').update(s).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = body => ({ json: async () => body });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

// Requests a case made without passing a fetch stub; afterEach fails the case if there are any.
let unstubbedRequests = [];
beforeEach(() => { unstubbedRequests = []; });
afterEach(() => { expect(unstubbedRequests, 'requests sent without a fetch stub').toEqual([]); });

/**
 * Runs one loader file in a fresh jsdom page at `url` with a <script> tag carrying `attrs`.
 * The loader gets a window whose `location` records `href` assignments and reload() in `nav`,
 * Node's WebCrypto and TextEncoder, and `fetch` (recorded in `calls`). `pre(window)` runs first,
 * to seed storage or globals. Returns the jsdom window and document, `nav` and `calls`.
 */
async function boot(file, { url = 'https://shop.example/wine?x=1', attrs = { 'data-client-id': 'cid-1' }, fetch, pre, runs = 1 } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="content">secret</main></body></html>', { url, runScripts: 'outside-only' });
  const w = dom.window;

  // document.currentScript is null under eval, so the loader finds this tag by its data-client-id
  const tag = w.document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) tag.setAttribute(k, v);
  w.document.head.appendChild(tag);

  const u = new URL(url);
  const nav = [];
  const location = {
    origin: u.origin,
    pathname: u.pathname,
    search: u.search,
    get href() { return url; },
    set href(v) { nav.push(v); },
    reload() { nav.push('RELOAD'); },
  };
  const win = new Proxy(w, {
    get(target, prop) {
      if (prop === 'location') return location;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' && !/^[A-Z]/.test(String(prop)) ? value.bind(target) : value;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value); },
  });

  const calls = [];
  const recordingFetch = fetch
    ? async (input, init) => { calls.push({ input, init }); return fetch(input, init); }
    : async input => { unstubbedRequests.push(String(input)); throw new Error('unexpected fetch'); };

  if (pre) pre(w);
  w.__aw = { win, crypto: webcrypto, fetch: recordingFetch, TextEncoder };
  for (let i = 0; i < runs; i++) {
    w.eval(`(function(window,crypto,fetch,TextEncoder){${sources[file]}\n})(__aw.win,__aw.crypto,__aw.fetch,__aw.TextEncoder)`);
  }
  await flush();
  return { w, doc: w.document, nav, calls };
}

// A fetch stub for a successful callback: /embed/token gives an access token, /user/userinfo gives `userinfo`.
const verifiedServer = (userinfo = { age_verified: true }) =>
  async input => (input.endsWith('/embed/token') ? json({ access_token: 'tok' }) : json(userinfo));

describe.each(FILES)('%s', file => {
  describe('gate', () => {
    it('hides the page and shows the gate when there is no session', async () => {
      const { doc, nav } = await boot(file);
      expect(doc.getElementById('aw-content-hider')).not.toBeNull();
      expect(doc.querySelectorAll('.aw-gate-overlay').length).toBe(1);
      expect(doc.getElementById('aw-verify')).not.toBeNull();
      expect(nav).toEqual([]);
    });

    it('shows the deny message without leaving the page', async () => {
      const { doc, nav } = await boot(file);
      doc.getElementById('aw-deny').click();
      expect(doc.getElementById('aw-error-msg').style.display).toBe('block');
      expect(nav).toEqual([]);
    });

    it('uses the default texts and logo', async () => {
      const { doc } = await boot(file);
      expect(doc.querySelector('.aw-gate-title').textContent).toBe('Age Verification');
      expect(doc.querySelector('.aw-gate-desc').textContent).toBe('You must verify your age to view this content.');
      expect(doc.getElementById('aw-verify').textContent).toBe('Verify with AgeWallet');
      expect(doc.getElementById('aw-deny').textContent).toBe('I Disagree');
      expect(doc.getElementById('aw-error-msg').textContent).toBe('Sorry, you do not meet the minimum requirements.');
      expect(doc.querySelector('.aw-gate-logo').getAttribute('src')).toBe(DEFAULT_LOGO);
    });

    it('uses the texts and logo from the data- attributes', async () => {
      const { doc } = await boot(file, {
        attrs: {
          'data-client-id': 'cid-1',
          'data-title': 'Over 21?',
          'data-description': 'Wine ahead.',
          'data-yes-label': 'Check my age',
          'data-no-label': 'Leave',
          'data-error-msg': 'Come back when you are 21.',
          'data-logo': 'https://shop.example/logo.png',
        },
      });
      expect(doc.querySelector('.aw-gate-title').textContent).toBe('Over 21?');
      expect(doc.querySelector('.aw-gate-desc').textContent).toBe('Wine ahead.');
      expect(doc.getElementById('aw-verify').textContent).toBe('Check my age');
      expect(doc.getElementById('aw-deny').textContent).toBe('Leave');
      expect(doc.getElementById('aw-error-msg').textContent).toBe('Come back when you are 21.');
      expect(doc.querySelector('.aw-gate-logo').getAttribute('src')).toBe('https://shop.example/logo.png');
    });

    it('adds the data-css stylesheet once with the gate', async () => {
      const { doc } = await boot(file, { attrs: { 'data-client-id': 'cid-1', 'data-css': 'https://shop.example/gate.css' } });
      expect(doc.querySelectorAll('link[rel="stylesheet"][href="https://shop.example/gate.css"]').length).toBe(1);
    });

    it('shows one gate when the loader is injected twice', async () => {
      const { doc } = await boot(file, { runs: 2 });
      expect(doc.querySelectorAll('.aw-gate-overlay').length).toBe(1);
    });

    it('reloads the page when it is restored from the back-forward cache', async () => {
      const { w, nav } = await boot(file);
      const event = new w.Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: true });
      w.dispatchEvent(event);
      expect(nav).toContain('RELOAD');
    });
  });

  describe('configuration errors', () => {
    it('shows an error when no script tag has data-client-id', async () => {
      const { doc } = await boot(file, { attrs: {} });
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Could not locate AgeWallet configuration.');
    });

    it('shows an error when data-client-id is empty', async () => {
      const { doc } = await boot(file, { attrs: { 'data-client-id': '' } });
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Missing Client ID.');
    });
  });

  describe('saved session', () => {
    const session = e => JSON.stringify({ v: 1, e });

    it('reveals the page for an unexpired localStorage session', async () => {
      const { doc } = await boot(file, { pre: w => w.localStorage.setItem('aw_session_cid-1', session(Date.now() + 60000)) });
      expect(doc.getElementById('aw-content-hider')).toBeNull();
      expect(doc.querySelector('.aw-gate-overlay')).toBeNull();
    });

    it('reveals the page for an unexpired cookie-only session', async () => {
      const { doc } = await boot(file, {
        pre: w => { w.document.cookie = `aw_session_cid-1=${encodeURIComponent(session(Date.now() + 60000))}; path=/`; },
      });
      expect(doc.querySelector('.aw-gate-overlay')).toBeNull();
    });

    it('clears the body styles when it reveals the page', async () => {
      const { doc } = await boot(file, {
        pre: w => {
          w.document.body.style.overflow = 'hidden';
          w.document.body.style.backgroundColor = 'black';
          w.localStorage.setItem('aw_session_cid-1', session(Date.now() + 60000));
        },
      });
      expect(doc.body.style.overflow).toBe('');
      expect(doc.body.style.backgroundColor).toBe('');
    });

    it('does not add the data-css stylesheet when the page is revealed', async () => {
      const { doc } = await boot(file, {
        attrs: { 'data-client-id': 'cid-1', 'data-css': 'https://shop.example/gate.css' },
        pre: w => w.localStorage.setItem('aw_session_cid-1', session(Date.now() + 60000)),
      });
      expect(doc.querySelectorAll('link[rel="stylesheet"]').length).toBe(0);
    });

    it('removes an expired session from localStorage and the cookie, and shows the gate', async () => {
      const { w, doc } = await boot(file, {
        pre: w => {
          w.localStorage.setItem('aw_session_cid-1', session(Date.now() - 1));
          w.document.cookie = `aw_session_cid-1=${encodeURIComponent(session(Date.now() - 1))}; path=/`;
        },
      });
      expect(w.localStorage.getItem('aw_session_cid-1')).toBeNull();
      expect(doc.cookie).not.toContain('aw_session_cid-1=');
      expect(doc.querySelector('.aw-gate-overlay')).not.toBeNull();
    });

    it('ignores a session for another client id', async () => {
      const { doc } = await boot(file, { pre: w => w.localStorage.setItem('aw_session_cid-2', session(Date.now() + 60000)) });
      expect(doc.querySelector('.aw-gate-overlay')).not.toBeNull();
    });
  });

  describe('authorize link', () => {
    const verify = async options => {
      const result = await boot(file, options);
      result.doc.getElementById('aw-verify').click();
      await flush();
      return { ...result, link: new URL(result.nav[0]) };
    };

    it('sends PKCE S256 with a challenge that matches the verifier carried in state', async () => {
      const { link } = await verify();
      const p = link.searchParams;
      expect(link.origin + link.pathname).toBe('https://app.agewallet.io/user/authorize');
      expect(p.get('response_type')).toBe('code');
      expect(p.get('client_id')).toBe('cid-1');
      expect(p.get('redirect_uri')).toBe('https://shop.example');
      expect(p.get('scope')).toBe('openid');
      expect(p.get('code_challenge_method')).toBe('S256');
      expect(p.get('nonce')).toMatch(/^[0-9a-f]{32}$/);

      const state = JSON.parse(Buffer.from(p.get('state').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
      expect(state.v).toMatch(/^[0-9a-f]{64}$/);
      expect(state.r).toBe('/wine?x=1');
      expect(p.get('code_challenge')).toBe(sha256Base64Url(state.v));
    });

    it('makes a new verifier and nonce each time', async () => {
      const first = (await verify()).link.searchParams;
      const second = (await verify()).link.searchParams;
      expect(second.get('state')).not.toBe(first.get('state'));
      expect(second.get('nonce')).not.toBe(first.get('nonce'));
      expect(second.get('code_challenge')).not.toBe(first.get('code_challenge'));
    });

    it('URL-encodes the client id', async () => {
      const { nav, link } = await verify({ attrs: { 'data-client-id': 'cid 1&x=2' } });
      expect(link.searchParams.get('client_id')).toBe('cid 1&x=2');
      expect(nav[0]).toContain('client_id=cid%201%26x%3D2&');
    });

    it('adds window.__awMetadata, URL-encoded', async () => {
      const { link } = await verify({ pre: w => { w.__awMetadata = 'order:42 & co'; } });
      expect(link.searchParams.get('metadata')).toBe('order:42 & co');
    });

    it('leaves metadata out when window.__awMetadata is not set', async () => {
      const { link } = await verify();
      expect(link.searchParams.has('metadata')).toBe(false);
    });

    it('uses https://<env>.agewallet.io for data-env', async () => {
      const { link } = await verify({ attrs: { 'data-client-id': 'cid-1', 'data-env': 'dev3' } });
      expect(link.origin + link.pathname).toBe('https://dev3.agewallet.io/user/authorize');
    });
  });

  describe('callback', () => {
    const callbackUrl = (r = '/wine?x=1') => `https://shop.example/?code=abc&state=${encodeState({ v: 'verifier-1', r })}`;

    it('exchanges the code at /embed/token, calls /user/userinfo, saves the session and returns to the page', async () => {
      const before = Date.now();
      const { w, nav, calls } = await boot(file, { url: callbackUrl(), fetch: verifiedServer({ age_verified: true, metadata: 'm1' }) });
      const after = Date.now();

      expect(calls.map(c => c.input)).toEqual(['https://app.agewallet.io/embed/token', 'https://app.agewallet.io/user/userinfo']);
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(calls[0].init.body.toString()))).toEqual({
        client_id: 'cid-1',
        code: 'abc',
        code_verifier: 'verifier-1',
        redirect_uri: 'https://shop.example',
      });
      expect(calls[1].init.headers.Authorization).toBe('Bearer tok');

      const saved = JSON.parse(w.localStorage.getItem('aw_session_cid-1'));
      expect(saved.v).toBe(1);
      expect(saved.m).toBe('m1');
      expect(saved.e).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(saved.e).toBeLessThanOrEqual(after + DAY_MS);
      expect(w.document.cookie).toContain('aw_session_cid-1=');
      expect(nav).toEqual(['https://shop.example/wine?x=1']);
    });

    it('sets the session to expire after data-expiry minutes', async () => {
      const before = Date.now();
      const { w } = await boot(file, { url: callbackUrl(), attrs: { 'data-client-id': 'cid-1', 'data-expiry': '60' }, fetch: verifiedServer() });
      const after = Date.now();

      const saved = JSON.parse(w.localStorage.getItem('aw_session_cid-1'));
      expect(saved.e).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
      expect(saved.e).toBeLessThanOrEqual(after + 60 * 60 * 1000);
    });

    it('uses the data-env server for both calls', async () => {
      const { calls } = await boot(file, { url: callbackUrl(), attrs: { 'data-client-id': 'cid-1', 'data-env': 'dev3' }, fetch: verifiedServer() });
      expect(calls.map(c => c.input)).toEqual(['https://dev3.agewallet.io/embed/token', 'https://dev3.agewallet.io/user/userinfo']);
    });

    it('reads the callback from window.__awParams before the page address', async () => {
      const state = encodeState({ v: 'verifier-1', r: '/' });
      const { calls } = await boot(file, { url: 'https://shop.example/wine', pre: w => { w.__awParams = `?code=abc&state=${state}`; }, fetch: verifiedServer() });
      expect(calls[0].input).toBe('https://app.agewallet.io/embed/token');
    });

    it.each([
      ['false', false],
      ['the string "true"', 'true'],
      ['1', 1],
      ['missing', undefined],
    ])('saves no session when age_verified is %s', async (_, ageVerified) => {
      const { w, doc, nav } = await boot(file, { url: callbackUrl(), fetch: verifiedServer({ age_verified: ageVerified }) });
      expect(w.localStorage.getItem('aw_session_cid-1')).toBeNull();
      expect(nav).toEqual([]);
      expect(doc.querySelector('.aw-error-title').textContent).toBe('Verification Failed');
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Age requirement not met.');
    });

    it('shows the token error and does not call userinfo', async () => {
      const { w, doc, calls } = await boot(file, { url: callbackUrl(), fetch: async () => json({ error: 'invalid_grant', error_description: 'Code expired' }) });
      expect(calls.length).toBe(1);
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Code expired');
      expect(w.localStorage.getItem('aw_session_cid-1')).toBeNull();
    });

    it('shows an error when the token request fails', async () => {
      const { w, doc, calls } = await boot(file, { url: callbackUrl(), fetch: async () => { throw new TypeError('Failed to fetch'); } });
      expect(calls.length).toBe(1);
      expect(doc.querySelector('.aw-error-title').textContent).toBe('Verification Error');
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Failed to fetch');
      expect(w.localStorage.getItem('aw_session_cid-1')).toBeNull();
    });

    it('shows an error when the token reply is not JSON', async () => {
      const { w, doc } = await boot(file, {
        url: callbackUrl(),
        fetch: async () => ({ json: async () => { throw new SyntaxError('Unexpected token <'); } }),
      });
      expect(doc.querySelector('.aw-error-title').textContent).toBe('Verification Error');
      expect(w.localStorage.getItem('aw_session_cid-1')).toBeNull();
    });

    it('rejects a state with no verifier without any request', async () => {
      const { doc, calls } = await boot(file, { url: 'https://shop.example/?code=abc&state=garbage', fetch: async () => json({}) });
      expect(calls.length).toBe(0);
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Invalid state parameter.');
    });
  });

  describe('error in the link', () => {
    it('shows the error description as text with a Try Again button back to the site', async () => {
      const { doc, nav } = await boot(file, { url: 'https://shop.example/?error=server_error&error_description=Something%20failed' });
      expect(doc.querySelector('.aw-error-title').textContent).toBe('Verification Error');
      expect(doc.querySelector('.aw-error-desc').textContent).toBe('Something failed');
      const button = doc.getElementById('aw-err-btn');
      expect(button.textContent).toBe('Try Again');
      button.click();
      expect(nav).toEqual(['https://shop.example']);
    });
  });
});

describe('shipped files', () => {
  it('aw-loader.js is byte-identical to aw-loader.min.js', () => {
    expect(readFileSync(repoFile('aw-loader.js')).equals(readFileSync(repoFile('aw-loader.min.js')))).toBe(true);
  });
});
