import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { site } from '../src/lib/config.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';

const image = process.env.CONTAINER_IMAGE || 'konda-services:local';
const platform = process.env.CONTAINER_PLATFORM ? ['--platform', process.env.CONTAINER_PLATFORM] : [];
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const hardened = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--pids-limit=100'];

async function startContainer(t, port, environment = []) {
  const name = `konda-test-${randomUUID()}`;
  const id = docker(['create', '--name', name, ...platform, ...hardened, '--health-interval=1s', '--health-start-period=1s', '--publish', `127.0.0.1::${port}`, ...environment, image]);
  t.after(() => docker(['rm', '--force', id]));
  docker(['start', id]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
    if (!state.Running) assert.fail(`Container exited: ${docker(['logs', id])}`);
    if (state.Health?.Status === 'healthy') {
      const address = docker(['port', id, `${port}/tcp`]);
      assert.match(address, /^127\.0\.0\.1:\d+$/);
      return { id, url: `http://${address}` };
    }
    await delay(250);
  }
  assert.fail(`Container did not become healthy: ${docker(['logs', id])}`);
}

async function request(url, path, { status = 200, cache = 'no-cache', method = 'GET' } = {}) {
  const response = await fetch(new URL(path, url), { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, status, `${method} ${path}`);
  for (const [name, value] of Object.entries(createSecurityHeaders(site))) {
    assert.equal(response.headers.get(name), value, `${path}: ${name}`);
  }
  assert.equal(response.headers.get('cache-control'), cache, `${path}: Cache-Control`);
  assert.equal(response.headers.get('server'), 'nginx');
  return response;
}

test('the non-root image serves only static content on a read-only filesystem', async (t) => {
  const configuration = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config}}', image]));
  assert.equal(configuration.User, '101:101');
  assert.equal(configuration.StopSignal, 'SIGQUIT');
  assert.ok(configuration.Healthcheck.Test.join(' ').includes('/healthz'));
  const { id, url } = await startContainer(t, 8080);
  assert.equal(docker(['exec', id, 'id', '-u']), '101');
  docker(['exec', id, 'sh', '-c', '! command -v node && ! command -v npm && test ! -w /srv/site/index.html && test ! -e /srv/site/_headers && test ! -e /srv/site/site.config.json']);

  const home = await request(url, '/');
  assert.match(home.headers.get('content-type'), /^text\/html/);
  const { document } = parseHTML(await home.text());
  assert.equal(document.title, site.site.title);
  assert.equal(document.querySelector('header a').getAttribute('aria-label'), site.ui.homeLabel);
  assert.ok(document.querySelector('header').textContent.includes(site.site.name));
  assert.ok(document.querySelector('footer').textContent.includes(site.footer.copyright));
  assert.deepEqual([...document.querySelectorAll('[data-service] h3')].map((heading) => heading.textContent), site.services.items.map(({ title }) => title));
  assert.equal(document.querySelectorAll('script, style, [style]').length, 0);

  const cssPath = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute('href')).find((href) => href.startsWith('/_astro/'));
  assert.ok(cssPath, 'A hashed stylesheet must be present');
  const css = await request(url, cssPath, { cache: 'public, max-age=31536000, immutable' });
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.ok((await css.text()).length > 0);
  for (const [path, mime] of [['/theme.css', 'text/css'], ['/favicon.svg', 'image/svg+xml'], ['/robots.txt', 'text/plain'], ['/sitemap.xml', 'text/xml']]) {
    const response = await request(url, path);
    assert.ok(response.headers.get('content-type').startsWith(mime), path);
    await response.arrayBuffer();
  }

  const privacy = await request(url, site.routes.privacy);
  assert.equal(parseHTML(await privacy.text()).document.querySelector('h1').textContent, site.privacy.title);
  for (const path of ['/missing-page', '/404.html', '/_astro/missing.css', '/_headers', '/.git/config', '/site.config.json', '/package.json', '/src/lib/config.mjs']) {
    const response = await request(url, path, { status: 404 });
    assert.equal(parseHTML(await response.text()).document.querySelector('h1').textContent, site.notFound.title);
  }
  assert.equal(await (await request(url, '/', { method: 'HEAD' })).text(), '');
  for (const path of ['/', cssPath, '/healthz']) {
    const rejected = await request(url, path, { method: 'POST', status: 405 });
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
    await rejected.arrayBuffer();
  }
  assert.equal(await (await request(url, '/healthz')).text(), 'ok\n');
});

test('the same image honors a cloud-supplied PORT', async (t) => {
  const { url } = await startContainer(t, 9090, ['--env', 'PORT=9090']);
  assert.equal(await (await request(url, '/healthz')).text(), 'ok\n');
  assert.equal(parseHTML(await (await request(url, '/')).text()).document.title, site.site.title);
});

test('invalid and privileged ports fail closed before starting Nginx', async (t) => {
  for (const port of ['0', '80', '1023', '65536', '-1', 'abc', '8080;return 200', '12345678901234567890']) {
    const name = `konda-invalid-${randomUUID()}`;
    const id = docker(['create', '--name', name, ...platform, ...hardened, '--env', `PORT=${port}`, image]);
    t.after(() => docker(['rm', '--force', id]));
    const result = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, port);
    assert.match(`${result.stdout}${result.stderr}`, /PORT must be an integer between 1024 and 65535/);
  }
});