import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHTML } from 'linkedom';
import { site } from '../src/lib/config.mjs';
import { createCsp, createSecurityHeaders, renderNginxHeaders, renderTheme } from '../src/lib/security.mjs';

const root = new URL('../dist/', import.meta.url);
const documents = new Map();
const files = [];
for (const name of await readdir(root, { recursive: true })) {
  if (!(await stat(new URL(name, root))).isFile()) continue;
  files.push(name);
  assert.ok(name === '_headers' || ['.html', '.css', '.svg', '.txt', '.xml'].includes(extname(name)), `Unexpected runtime or source artifact: ${name}`);
  if (name.endsWith('.html')) documents.set(`/${name}`, parseHTML(await readFile(new URL(name, root), 'utf8')).document);
}

assert.equal(documents.size, 3, 'Only the homepage, privacy page and 404 page should be generated');
for (const route of Object.values(site.routes)) assert.ok(documents.has(route === '/' ? '/index.html' : route), `Missing static route ${route}`);

for (const [path, document] of documents) {
  assert.equal(document.querySelectorAll('h1').length, 1, `${path}: require one main heading`);
  assert.equal(document.documentElement.lang, site.site.locale);
  assert.equal(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'), createCsp(site, { meta: true }));
  assert.equal(document.querySelectorAll('script, style, iframe, object, embed, [style], base').length, 0, `${path}: scripts, inline styles and embedded content are forbidden`);
  const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(ids.length, new Set(ids).size, `${path}: duplicate HTML identifiers`);

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) assert.ok(!/^on/i.test(attribute.name), `${path}: inline event handler`);
  }

  for (const asset of document.querySelectorAll('link[rel="stylesheet"], link[rel="icon"], img')) {
    const href = asset.getAttribute('href') ?? asset.getAttribute('src');
    assert.ok(href?.startsWith('/') && !href.startsWith('//'), `${path}: only self-hosted assets are permitted`);
    assert.ok(files.includes(href.slice(1)), `${path}: missing asset ${href}`);
  }

  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (/^(mailto:|tel:)/.test(href)) continue;
    const target = new URL(href, new URL(path === '/index.html' ? '/' : path, site.site.url));
    assert.equal(target.origin, new URL(site.site.url).origin, `${path}: unexpected external link`);
    const targetDocument = documents.get(target.pathname === '/' ? '/index.html' : target.pathname);
    assert.ok(targetDocument, `${path}: broken link ${href}`);
    if (target.hash) assert.ok(targetDocument.getElementById(target.hash.slice(1)), `${path}: missing anchor ${href}`);
  }
}

const home = documents.get('/index.html');
assert.equal(home.querySelectorAll('[data-service]').length, site.services.items.length);
for (const service of site.services.items) {
  const card = home.getElementById(service.id);
  assert.equal(card.querySelector('h3')?.textContent, service.title);
  assert.equal(card.querySelector('p')?.textContent, service.description, 'Service payload must be preserved verbatim');
}

const forms = [...home.querySelectorAll('form')];
assert.equal(forms.length, site.contact.form.endpoint ? 1 : 0, 'Never render a dead or unconfigured form');
if (forms.length) {
  assert.equal(forms[0].getAttribute('action'), site.contact.form.endpoint);
  assert.equal(forms[0].getAttribute('method').toLowerCase(), 'post');
  for (const name of ['name', 'email', 'message']) assert.ok(forms[0].querySelector(`[name="${name}"][required]`));
}

const hostHeaders = await readFile(new URL('_headers', root), 'utf8');
for (const [name, value] of Object.entries(createSecurityHeaders(site))) assert.ok(hostHeaders.includes(`  ${name}: ${value}\n`), `Missing header ${name}`);
const policy = JSON.parse(await readFile(new URL('../.deploy/response-headers-policy.json', import.meta.url), 'utf8'));
assert.equal(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, createCsp(site));
assert.equal(await readFile(new URL('../.deploy/nginx-security-headers.conf', import.meta.url), 'utf8'), renderNginxHeaders(site));
assert.equal(await readFile(new URL('theme.css', root), 'utf8'), renderTheme(site));
for (const name of files.filter((file) => file.endsWith('.css'))) {
  const css = await readFile(new URL(name, root), 'utf8');
  assert.ok(!/@import|url\(\s*['"]?(?:https?:|\/\/|data:)/i.test(css), `${name}: external or inline resources are not permitted`);
}
console.log(`Verified ${documents.size} static pages and ${files.length} assets: links, content, CSP, external-only CSS and zero browser JavaScript.`);