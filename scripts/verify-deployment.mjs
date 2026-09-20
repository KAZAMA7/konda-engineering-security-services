import assert from 'node:assert/strict';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseHTML } from 'linkedom';
import { site } from '../src/lib/config.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';
import { validatePublicOrigin } from './deploy-container.mjs';

async function builtFiles(directory, relative = '', files = new Map()) {
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await builtFiles(directory, name, files);
    else if (entry.isFile()) {
      if (name === '_headers') continue;
      const route = name === 'index.html' ? '/' : `/${name}`;
      files.set(route, await readFile(join(directory, name)));
    } else throw new Error(`The built artifact must contain only regular files and directories: ${name}`);
  }
  return files;
}

function verifyBuiltPages(files) {
  const pages = [
    { route: '/', title: site.site.title },
    ...site.services.items.map((service) => ({ route: service.href, title: `${service.title} | ${site.site.name}`, heading: service.title })),
    { route: site.routes.privacy, heading: site.privacy.title },
  ];
  for (const { route, title, heading } of pages) {
    assert.ok(files.has(route), `Missing built page ${route}; build the same release before verification.`);
    const { document } = parseHTML(files.get(route).toString('utf8'));
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
    assert.ok(canonical, `${route}: built page is missing its canonical URL`);
    assert.equal(new URL(canonical).href, new URL(route, site.site.url).href, `${route}: built canonical does not match site.config.json`);
    if (title) assert.equal(document.title, title, `${route}: built title does not match site.config.json`);
    if (heading) assert.equal(document.querySelector('h1')?.textContent, heading, `${route}: built heading does not match site.config.json`);
  }
  assert.ok(files.has('/404.html'), 'Missing built 404.html; build the same release before verification.');
}

async function probe(origin, { route, status, body }, timeoutMs, overallSignal) {
  const response = await fetch(new URL(route, origin), {
    redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), overallSignal]),
    headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
  });
  try {
    assert.equal(response.status, status, `${route}: expected HTTP status ${status}; redirects are not accepted`);
    for (const [name, value] of Object.entries(createSecurityHeaders(site))) {
      assert.equal(response.headers.get(name), value, `${route}: ${name} must match the built security policy`);
    }
    if (route === '/' || route.endsWith('.html')) assert.match(response.headers.get('content-type') || '', /^text\/html(?:;|$)/i, `${route}: expected HTML`);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.ok(actual.equals(body), `${route}: deployed bytes differ from the tested build${route === '/healthz' ? ' (expected ok\\n)' : ''}`);
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

export async function verifyDeployment({ url = process.env.CONTAINER_PUBLIC_URL, dist = 'dist', allowLocal = false, attempts = 12, intervalMs = 5000, timeoutMs = 10_000 } = {}) {
  const origin = validatePublicOrigin(url, { allowLocal });
  for (const [name, value, minimum, maximum] of [
    ['attempts', attempts, 1, 30], ['intervalMs', intervalMs, 0, 30_000], ['timeoutMs', timeoutMs, 100, 30_000],
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const files = await builtFiles(resolve(dist));
  verifyBuiltPages(files);
  const probes = [
    { route: '/healthz', status: 200, body: Buffer.from('ok\n') },
    ...[...files].map(([route, body]) => ({ route, status: route === '/404.html' ? 404 : 200, body })),
    ...['/__deployment-probe-missing__.html', '/_headers', '/site.config.json'].map((route) => ({ route, status: 404, body: files.get('/404.html') })),
  ];
  const overallSignal = AbortSignal.timeout(300_000);
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const results = await Promise.allSettled(probes.map((request) => probe(origin, request, timeoutMs, overallSignal)));
    failure = results.find(({ status }) => status === 'rejected')?.reason;
    if (!failure) return { url: origin, checkedRoutes: probes.map(({ route }) => route) };
    if (attempt === attempts - 1 || overallSignal.aborted) break;
    await delay(intervalMs, undefined, { signal: overallSignal }).catch(() => {});
  }
  throw new Error(`Deployment verification failed: ${failure.message}`, { cause: failure });
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' }, dist: { type: 'string', default: 'dist' },
      'allow-local': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
      attempts: { type: 'string', default: '12' }, 'interval-ms': { type: 'string', default: '5000' }, 'timeout-ms': { type: 'string', default: '10000' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: node scripts/verify-deployment.mjs --url https://public-origin.example --dist dist\nThe URL defaults to CONTAINER_PUBLIC_URL. Optional bounded controls: --attempts 12 --interval-ms 5000 --timeout-ms 10000. Use --allow-local only for an explicit loopback test server.');
    return;
  }
  const result = await verifyDeployment({
    url: values.url || process.env.CONTAINER_PUBLIC_URL, dist: values.dist, allowLocal: values['allow-local'],
    attempts: Number(values.attempts), intervalMs: Number(values['interval-ms']), timeoutMs: Number(values['timeout-ms']),
  });
  const message = `Public verification passed at ${result.url}: ${result.checkedRoutes.length} routes matched the tested build, expected status codes, and strict security headers.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n- ${message}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}