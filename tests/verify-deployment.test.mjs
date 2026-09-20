import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { cacheControl, releaseProbes, validatePublicOrigin, verifyDeployment, verifyHttpsRedirect } from '../scripts/verify-deployment.mjs';
import { site } from '../src/lib/config.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';

const executeFile = promisify(execFile);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'konda-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A loopback stand-in for S3 behind CloudFront: existing objects are 200 with their upload metadata, unknown keys become the
// 404 page, and the response headers policy applies to every response.
async function releaseFixture(t) {
  const directory = await temporaryDirectory(t);
  const escape = (value) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  const html = (route, title) => `<!doctype html><html><head><title>${escape(title)}</title><link rel="icon" href="/favicon.svg"><link rel="canonical" href="${new URL(route, site.site.url).href}"></head><body><h1>${escape(title)}</h1></body></html>`;
  const objects = new Map([
    ['/', Buffer.from(html('/', site.site.title))],
    ['/404.html', Buffer.from(html('/404.html', site.notFound.title))],
    [site.routes.privacy, Buffer.from(html(site.routes.privacy, site.privacy.title))],
    ...site.services.items.map((service) => [service.href, Buffer.from(html(service.href, service.title))]),
    ['/theme.css', Buffer.from('body { color: #fff; }')],
    ['/_astro/site.hash.css', Buffer.from('html { background: #000; }')],
    ['/favicon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['/robots.txt', Buffer.from('User-agent: *\nDisallow: /\n')],
    ['/sitemap.xml', Buffer.from('<?xml version="1.0"?><urlset></urlset>')],
  ]);
  await mkdir(join(directory, 'dist', '_astro'), { recursive: true });
  for (const [route, body] of objects) await writeFile(join(directory, 'dist', route === '/' ? 'index.html' : route.slice(1)), body);
  const headersPath = join(directory, 'security-headers.json');
  await writeFile(headersPath, JSON.stringify(createSecurityHeaders(site)));
  const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml' };
  const state = { requests: [], change: null };
  const server = createServer((request, response) => {
    state.requests.push(request.url);
    const route = request.url === '/index.html' ? '/' : request.url;
    const found = objects.has(route);
    const body = found ? objects.get(route) : objects.get('/404.html');
    response.statusCode = found ? 200 : 404;
    for (const [name, value] of Object.entries(createSecurityHeaders(site))) response.setHeader(name, value);
    response.setHeader('Content-Type', found ? types[route === '/' ? '.html' : route.slice(route.lastIndexOf('.'))] : 'text/html');
    if (found) response.setHeader('Cache-Control', route.startsWith('/_astro/') ? cacheControl.immutable : cacheControl.revalidate);
    if (state.change?.(request, response, body)) return;
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { url, dist: join(directory, 'dist'), headers: headersPath, allowLocal: true, attempts: 1 };
  return { directory, objects, state, url, options };
}

test('public origins must be bare HTTPS hostnames unless a loopback test server is explicitly allowed', () => {
  assert.equal(validatePublicOrigin('https://konda.com'), 'https://konda.com');
  assert.equal(validatePublicOrigin('https://konda.com/'), 'https://konda.com');
  assert.equal(validatePublicOrigin('https://d1234abcd.cloudfront.net'), 'https://d1234abcd.cloudfront.net');
  for (const value of ['http://konda.com', 'https://konda.com/path', 'https://konda.com:8443', 'https://user:secret@konda.com', 'https://konda.com?x=1',
    'https://203.0.113.10', 'https://konda.local', 'https://konda.internal', 'http://127.0.0.1:8080', 'konda.com', '', undefined, 'https://konda.com\n']) {
    assert.throws(() => validatePublicOrigin(value), /public HTTPS origin/, String(value));
  }
  assert.equal(validatePublicOrigin('http://127.0.0.1:8080', { allowLocal: true }), 'http://127.0.0.1:8080');
  assert.throws(() => validatePublicOrigin('http://192.168.1.10:8080', { allowLocal: true }), /public HTTPS origin/);
});

test('release probes cover every built object, the index alias and unknown keys with S3/CloudFront status semantics', () => {
  const files = new Map([['/', Buffer.from('home')], ['/404.html', Buffer.from('missing')], ['/_astro/a.css', Buffer.from('css')]]);
  const probes = releaseProbes(files);
  const byRoute = Object.fromEntries(probes.map((probe) => [probe.route, probe]));
  assert.equal(byRoute['/'].status, 200);
  assert.equal(byRoute['/404.html'].status, 200, 'the 404 object itself is an ordinary S3 object');
  assert.equal(byRoute['/index.html'].body, files.get('/'));
  assert.equal(byRoute['/_astro/a.css'].cache, cacheControl.immutable);
  assert.equal(byRoute['/'].cache, cacheControl.revalidate);
  for (const route of ['/missing-directory/', '/site.config.json', '/.deploy/csp.txt']) {
    assert.equal(byRoute[route].status, 404);
    assert.equal(byRoute[route].body, files.get('/404.html'));
    assert.equal(byRoute[route].cache, undefined, 'error responses are not held to upload metadata');
  }
  assert.ok(probes.some(({ route, status }) => /^\/__deployment-probe-[0-9a-f-]+\.html$/.test(route) && status === 404));
});

test('deployment verification checks every built byte, content types, cache metadata, security headers and real 404s', async (t) => {
  const { state, url, options, objects } = await releaseFixture(t);
  const result = await verifyDeployment(options);
  assert.equal(result.url, url);
  assert.equal(result.canonical, new URL(site.site.url).origin);
  assert.equal(result.httpsRedirectChecked, false, 'a loopback HTTP server has no HTTPS redirect to check');
  for (const route of [...objects.keys(), '/index.html', '/site.config.json', '/missing-directory/', '/.deploy/csp.txt']) assert.ok(state.requests.includes(route), route);
  assert.ok(state.requests.some((route) => route.startsWith('/__deployment-probe-')));
  assert.equal(result.checkedRoutes.length, objects.size + 5);
});

test('deployment verification rejects redirects, stale bytes, wrong metadata, missing headers and soft 404s', async (t) => {
  const { state, options } = await releaseFixture(t);
  const cases = [
    ['redirect', (request, response) => { if (request.url !== '/') return false; response.writeHead(302, { Location: '/theme.css' }).end(); return true; }, /expected HTTP 200, received 302 redirecting to \/theme\.css/],
    ['stale content', (request, response) => { if (request.url !== '/') return false; response.end('old release'); return true; }, /deployed bytes differ/],
    ['stale index alias', (request, response) => { if (request.url !== '/index.html') return false; response.end('old release'); return true; }, /\/index\.html: deployed bytes differ/],
    ['missing CSP', (request, response) => { if (request.url === '/theme.css') response.removeHeader('Content-Security-Policy'); return false; }, /Content-Security-Policy/],
    ['missing HSTS on error', (request, response) => { if (request.url.startsWith('/__deployment-probe-')) response.removeHeader('Strict-Transport-Security'); return false; }, /Strict-Transport-Security/],
    ['mutable hashed asset', (request, response) => { if (request.url === '/_astro/site.hash.css') response.setHeader('Cache-Control', cacheControl.revalidate); return false; }, /_astro\/site\.hash\.css: Cache-Control/],
    ['cached HTML', (request, response) => { if (request.url === '/') response.setHeader('Cache-Control', 'public, max-age=86400'); return false; }, /\/: Cache-Control/],
    ['wrong stylesheet type', (request, response) => { if (request.url === '/theme.css') response.setHeader('Content-Type', 'application/octet-stream'); return false; }, /nosniff/],
    ['soft 404', (request, response) => { if (request.url !== '/site.config.json') return false; response.statusCode = 200; return false; }, /site\.config\.json: expected HTTP 404/],
    ['wrong error page', (request, response) => { if (!request.url.startsWith('/__deployment-probe-')) return false; response.end('<h1>Forbidden</h1>'); return true; }, /deployed bytes differ/],
    ['non-HTML error', (request, response) => { if (request.url === '/missing-directory/') response.setHeader('Content-Type', 'application/xml'); return false; }, /expected an HTML response/],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async () => {
      state.change = change;
      await assert.rejects(verifyDeployment(options), expected);
    });
  }
});

test('deployment verification retries transient failures within bounded attempts and never implies a local origin', async (t) => {
  const { state, options } = await releaseFixture(t);
  let failures = 1;
  state.change = (request, response) => {
    if (request.url === '/theme.css' && failures-- > 0) { response.statusCode = 503; response.end('warming up'); return true; }
    return false;
  };
  await verifyDeployment({ ...options, attempts: 2, intervalMs: 1 });
  assert.equal(state.requests.filter((route) => route === '/theme.css').length, 2);
  await assert.rejects(verifyDeployment({ ...options, allowLocal: false }), /public HTTPS origin/);
  await assert.rejects(verifyDeployment({ ...options, attempts: 0 }), /attempts/);
  await assert.rejects(verifyDeployment({ ...options, timeoutMs: 10 }), /timeoutMs/);
});

test('deployment verification validates the built release and generated headers before touching the network', async (t) => {
  const { directory, state, options } = await releaseFixture(t);
  await assert.rejects(verifyDeployment({ ...options, expectCanonical: true }), /not the canonical site URL/);
  assert.deepEqual(state.requests, []);
  const unsafe = join(directory, 'unsafe-headers.json');
  await writeFile(unsafe, JSON.stringify({ ...createSecurityHeaders(site), 'Content-Security-Policy': "default-src 'unsafe-inline'" }));
  await assert.rejects(verifyDeployment({ ...options, headers: unsafe }), /unsafe sources/);
  await writeFile(unsafe, JSON.stringify({ 'X-Frame-Options': 'DENY' }));
  await assert.rejects(verifyDeployment({ ...options, headers: unsafe }), /must define Content-Security-Policy/);
  const home = join(directory, 'dist', 'index.html');
  const original = await readFile(home, 'utf8');
  await writeFile(home, original.replace(new URL('/', site.site.url).href, 'https://wrong-domain.example/'));
  await assert.rejects(verifyDeployment(options), /disagree about the canonical origin/);
  await writeFile(home, original.replace(new URL('/', site.site.url).href, new URL('/other.html', site.site.url).href));
  await assert.rejects(verifyDeployment(options), /canonical path does not match/);
  await writeFile(home, original.replace(/<link rel="canonical"[^>]*>/, ''));
  await assert.rejects(verifyDeployment(options), /no canonical URL/);
  await rm(join(directory, 'dist', '404.html'));
  await writeFile(home, original);
  await assert.rejects(verifyDeployment(options), /Missing built 404\.html/);
  assert.deepEqual(state.requests, []);
});

test('deployment verification bounds requests to an unresponsive endpoint', async (t) => {
  const { state, options } = await releaseFixture(t);
  state.change = (request) => request.url === '/theme.css';
  await assert.rejects(verifyDeployment({ ...options, timeoutMs: 100 }), /timeout|timed out|abort/i);
  assert.equal(state.requests.filter((route) => route === '/theme.css').length, 1);
});

test('the HTTPS redirect check accepts only permanent redirects to the verified origin', async (t) => {
  const { state, url } = await releaseFixture(t);
  state.change = (request, response) => {
    if (request.url !== '/') return false;
    response.writeHead(...(state.redirect ?? [200])).end();
    return true;
  };
  const insecureUrl = `${url}/`;
  await assert.rejects(verifyHttpsRedirect('https://konda.com', { insecureUrl }), /expected a permanent redirect to HTTPS, received HTTP 200/);
  state.redirect = [302, { Location: 'https://konda.com/' }];
  await assert.rejects(verifyHttpsRedirect('https://konda.com', { insecureUrl }), /received HTTP 302/);
  state.redirect = [301, { Location: 'https://other.example/' }];
  await assert.rejects(verifyHttpsRedirect('https://konda.com', { insecureUrl }), /must lead to https:\/\/konda\.com\//);
  state.redirect = [301, { Location: 'https://konda.com/' }];
  await verifyHttpsRedirect('https://konda.com', { insecureUrl });
  state.redirect = [308, { Location: 'https://konda.com' }];
  await verifyHttpsRedirect('https://konda.com', { insecureUrl });
});

test('the documented command-line entry point verifies a loopback release and refuses insecure origins by default', async (t) => {
  const { url, options } = await releaseFixture(t);
  const args = ['scripts/verify-deployment.mjs', '--url', url, '--dist', options.dist, '--headers', options.headers, '--attempts', '1'];
  const run = { env: { ...process.env, GITHUB_STEP_SUMMARY: '' }, timeout: 10_000 };
  const verified = await executeFile(process.execPath, [...args, '--allow-local'], run);
  assert.match(verified.stdout, /Deployment verification passed/);
  await assert.rejects(executeFile(process.execPath, args, run), /public HTTPS origin/);
  await assert.rejects(executeFile(process.execPath, [...args, '--allow-local', '--expect-canonical'], run), /not the canonical site URL/);
  const help = await executeFile(process.execPath, ['scripts/verify-deployment.mjs', '--help'], run);
  assert.match(help.stdout, /--expect-canonical/);
});
