import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// This script uses only Node.js built-ins so the release job can run it from the build artifact without installing
// npm dependencies next to AWS credentials. It compares a live origin with the exact `dist/` and generated headers.

export const cacheControl = {
  immutable: 'public, max-age=31536000, immutable',
  revalidate: 'no-cache, max-age=0, must-revalidate',
};
const requiredHeaders = ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy'];
const contentTypes = {
  '.html': /^text\/html(?:;|$)/i,
  '.css': /^text\/css(?:;|$)/i,
  '.svg': /^image\/svg\+xml(?:;|$)/i,
  '.txt': /^text\/plain(?:;|$)/i,
  '.xml': /^(?:application|text)\/xml(?:;|$)/i,
};

export function validatePublicOrigin(value, { allowLocal = false } = {}) {
  const invalid = () => new Error('The deployment URL must be a public HTTPS origin without a path, credentials, port, query, or fragment (loopback HTTP requires --allow-local).');
  if (typeof value !== 'string' || /[\s\\<>"'\u0000-\u001f\u007f]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (value !== url.origin && value !== `${url.origin}/`) throw invalid();
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (allowLocal && loopback && ['http:', 'https:'].includes(url.protocol)) return url.origin;
  if (url.protocol !== 'https:' || url.port || isIP(url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(url.hostname)) throw invalid();
  return url.origin;
}

export function parseSecurityHeaders(json) {
  const headers = JSON.parse(json);
  assert.ok(headers && typeof headers === 'object' && !Array.isArray(headers), 'security-headers.json must be an object of header names and values');
  for (const name of requiredHeaders) assert.ok(typeof headers[name] === 'string' && headers[name], `security-headers.json must define ${name}`);
  for (const [name, value] of Object.entries(headers)) {
    assert.ok(/^[A-Za-z0-9-]+$/.test(name) && typeof value === 'string' && value && !/[\r\n]/.test(value), `Invalid generated header ${name}`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/i.test(headers['Content-Security-Policy']), 'The generated CSP must not contain unsafe sources');
  return headers;
}

export async function readBuiltFiles(directory, relative = '', files = new Map()) {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await readBuiltFiles(directory, name, files);
    else if (entry.isFile()) files.set(name === 'index.html' ? '/' : `/${name}`, await readFile(join(directory, name)));
    else throw new Error(`The built site must contain only regular files and directories: ${name}`);
  }
  return files;
}

export function verifyBuiltRelease(files) {
  assert.ok(files.has('/'), 'Missing built index.html; build the same release before verifying it.');
  assert.ok(files.has('/404.html'), 'Missing built 404.html; build the same release before verifying it.');
  let origin;
  for (const [route, body] of files) {
    if (route !== '/' && extname(route) !== '.html') continue;
    const match = body.toString('utf8').match(/<link\b(?=[^>]*\brel="canonical")[^>]*\bhref="([^"]*)"/i);
    assert.ok(match, `${route}: built page has no canonical URL`);
    let canonical;
    try { canonical = new URL(match[1]); } catch { assert.fail(`${route}: built canonical URL is not absolute`); }
    assert.equal(canonical.protocol, 'https:', `${route}: the canonical URL must use HTTPS`);
    assert.equal(canonical.pathname, route, `${route}: canonical path does not match the built route`);
    origin ??= canonical.origin;
    assert.equal(canonical.origin, origin, `${route}: pages disagree about the canonical origin; rebuild from one site.config.json`);
  }
  return origin;
}

export function releaseProbes(files) {
  // Every uploaded object, including /404.html itself, is an ordinary 200 from S3; only unknown keys become CloudFront 404 pages.
  const probes = [...files].map(([route, body]) => ({
    route, body, status: 200, cache: route.startsWith('/_astro/') ? cacheControl.immutable : cacheControl.revalidate,
  }));
  probes.push({ route: '/index.html', body: files.get('/'), status: 200, cache: cacheControl.revalidate });
  for (const route of [`/__deployment-probe-${randomUUID()}.html`, '/missing-directory/', '/site.config.json', '/.deploy/csp.txt']) {
    probes.push({ route, body: files.get('/404.html'), status: 404 });
  }
  return probes;
}

async function cancel(response) {
  if (!response.bodyUsed) await response.body?.cancel();
}

async function probe(origin, { route, status, body, cache }, headers, timeoutMs, signal) {
  const response = await fetch(new URL(route, origin), {
    redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
    headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
  });
  try {
    const location = response.headers.get('location');
    assert.equal(response.status, status, `${route}: expected HTTP ${status}, received ${response.status}${location ? ` redirecting to ${location}` : ''}; redirects are not accepted`);
    for (const [name, value] of Object.entries(headers)) {
      assert.equal(response.headers.get(name), value, `${route}: ${name} must match the generated security policy on every response`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (status === 404 || route === '/' || extname(route) === '.html') assert.match(type, contentTypes['.html'], `${route}: expected an HTML response, received "${type}"`);
    else if (contentTypes[extname(route)]) assert.match(type, contentTypes[extname(route)], `${route}: unexpected Content-Type "${type}"; browsers honouring nosniff would reject this asset`);
    if (cache) assert.equal(response.headers.get('cache-control'), cache, `${route}: Cache-Control must match the release upload metadata`);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.ok(actual.equals(body), `${route}: deployed bytes differ from the built release`);
  } finally {
    await cancel(response);
  }
}

export async function verifyHttpsRedirect(origin, { insecureUrl, timeoutMs = 10_000, signal = AbortSignal.timeout(timeoutMs) } = {}) {
  const url = new URL(insecureUrl ?? origin);
  if (!insecureUrl) url.protocol = 'http:';
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) });
  try {
    assert.ok([301, 308].includes(response.status), `${url}: expected a permanent redirect to HTTPS, received HTTP ${response.status}`);
    const location = response.headers.get('location') ?? '';
    assert.ok(location === `${origin}/` || location === origin, `${url}: the redirect must lead to ${origin}/, received "${location}"`);
  } finally {
    await cancel(response);
  }
}

export async function verifyDeployment({
  url = process.env.PUBLIC_URL, dist = 'dist', headers = '.deploy/security-headers.json',
  allowLocal = false, expectCanonical = false, attempts = 12, intervalMs = 5000, timeoutMs = 10_000,
} = {}) {
  const origin = validatePublicOrigin(url, { allowLocal });
  for (const [name, value, minimum, maximum] of [['attempts', attempts, 1, 30], ['intervalMs', intervalMs, 0, 30_000], ['timeoutMs', timeoutMs, 100, 30_000]]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const securityHeaders = typeof headers === 'string' ? parseSecurityHeaders(await readFile(resolve(headers), 'utf8')) : parseSecurityHeaders(JSON.stringify(headers));
  const files = await readBuiltFiles(resolve(dist));
  const canonical = verifyBuiltRelease(files);
  if (expectCanonical) assert.equal(origin, canonical, `The verified origin ${origin} is not the canonical site URL ${canonical} configured in site.config.json.`);
  const probes = releaseProbes(files);
  const signal = AbortSignal.timeout(Math.min(900_000, attempts * (intervalMs + timeoutMs) + timeoutMs));
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const checks = probes.map((request) => probe(origin, request, securityHeaders, timeoutMs, signal));
    if (origin.startsWith('https:')) checks.push(verifyHttpsRedirect(origin, { timeoutMs, signal }));
    const results = await Promise.allSettled(checks);
    failure = results.find(({ status }) => status === 'rejected')?.reason;
    if (!failure) return { url: origin, canonical, checkedRoutes: probes.map(({ route }) => route), httpsRedirectChecked: origin.startsWith('https:') };
    if (attempt === attempts - 1 || signal.aborted) break;
    await delay(intervalMs, undefined, { signal }).catch(() => {});
  }
  throw new Error(`Deployment verification failed: ${failure.message}`, { cause: failure });
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' }, dist: { type: 'string', default: 'dist' }, headers: { type: 'string', default: '.deploy/security-headers.json' },
      'allow-local': { type: 'boolean', default: false }, 'expect-canonical': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
      attempts: { type: 'string', default: '12' }, 'interval-ms': { type: 'string', default: '5000' }, 'timeout-ms': { type: 'string', default: '10000' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log([
      'Usage: node scripts/verify-deployment.mjs --url https://konda.com [--expect-canonical] [--dist dist] [--headers .deploy/security-headers.json]',
      'The URL defaults to PUBLIC_URL. Every built file must be served byte-for-byte with the generated security headers and release',
      'Cache-Control metadata, unknown paths must answer 404 with 404.html, and HTTP must redirect permanently to HTTPS.',
      'Optional bounded controls: --attempts 12 --interval-ms 5000 --timeout-ms 10000. Use --allow-local only for a loopback test server.',
    ].join('\n'));
    return;
  }
  const result = await verifyDeployment({
    url: values.url || process.env.PUBLIC_URL, dist: values.dist, headers: values.headers,
    allowLocal: values['allow-local'], expectCanonical: values['expect-canonical'],
    attempts: Number(values.attempts), intervalMs: Number(values['interval-ms']), timeoutMs: Number(values['timeout-ms']),
  });
  const message = `Deployment verification passed at ${result.url}: ${result.checkedRoutes.length} routes matched the built release, status codes, Cache-Control and strict security headers${result.httpsRedirectChecked ? ', and HTTP redirects to HTTPS' : ''}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n- ${message}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
