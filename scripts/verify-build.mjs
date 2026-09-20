import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHTML } from 'linkedom';
import { site } from '../src/lib/config.mjs';
import { createCloudFrontPolicy, createCsp, createSecurityHeaders, renderTheme } from '../src/lib/security.mjs';

const root = new URL('../dist/', import.meta.url);
const documents = new Map();
const files = [];
for (const name of await readdir(root, { recursive: true })) {
  if (!(await stat(new URL(name, root))).isFile()) continue;
  files.push(name);
  assert.ok(['.html', '.css', '.svg', '.txt', '.xml'].includes(extname(name)), `Unexpected runtime or source artifact: ${name}`);
  assert.ok(!name.split('/').some((part) => part.startsWith('.') || part.startsWith('_')) || name.startsWith('_astro/'), `Only hashed _astro assets may use a reserved prefix: ${name}`);
  if (name.endsWith('.html')) documents.set(`/${name}`, parseHTML(await readFile(new URL(name, root), 'utf8')).document);
}

const routes = [...Object.values(site.routes), ...site.services.items.map((service) => service.href)];
assert.equal(documents.size, routes.length, 'Generate exactly the configured pages, including every capability');
for (const route of routes) assert.ok(documents.has(route === '/' ? '/index.html' : route), `Missing static route ${route}`);

for (const [path, document] of documents) {
  assert.equal(document.querySelectorAll('h1').length, 1, `${path}: require one main heading`);
  assert.equal(document.documentElement.lang, site.site.locale);
  assert.equal(document.querySelector('link[rel="canonical"]')?.getAttribute('href'), new URL(path === '/index.html' ? '/' : path, site.site.url).href);
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
    if (site.contact.whatsappUrl && href === site.contact.whatsappUrl) {
      assert.ok(link.getAttribute('rel')?.split(/\s+/).includes('noreferrer'), `${path}: WhatsApp links must not send a referrer`);
      continue;
    }
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
  assert.equal(card.querySelector('a[aria-label]')?.getAttribute('href'), service.href);
  const page = documents.get(service.href);
  assert.equal(page.querySelector('h1')?.textContent, service.title);
  assert.equal(page.title, `${service.title} | ${site.site.name}`);
  assert.equal(page.querySelector('meta[name="description"]')?.getAttribute('content'), service.description);
  assert.deepEqual([...page.querySelectorAll('[data-capability-scope] h3')].map((heading) => heading.textContent), service.scope.map((item) => item.title));
  assert.deepEqual([...page.querySelectorAll('[data-capability-scope] p')].map((paragraph) => paragraph.textContent), service.scope.map((item) => item.description));
  assert.deepEqual([...page.querySelectorAll('[data-capability-outcomes] li')].map((item) => item.textContent), service.outcomes);
}

for (const page of [home, ...site.services.items.map((service) => documents.get(service.href))]) {
  const contact = page.getElementById(site.contact.id);
  if (site.contact.phone) {
    assert.equal(contact.querySelector('a[href^="tel:"]')?.getAttribute('href'), `tel:${site.contact.phone.replace(/[ ()-]/g, '')}`);
    assert.equal(contact.querySelector('a[href^="tel:"]')?.textContent, site.contact.phone);
  }
  assert.equal(contact.querySelectorAll('address').length, site.contact.address ? 1 : 0);
  if (site.contact.address) assert.equal(contact.querySelector('address').textContent, site.contact.address);
  if (site.contact.whatsappUrl) {
    assert.equal(contact.querySelector(`a[href="${site.contact.whatsappUrl}"]`)?.textContent, site.ui.whatsappCtaLabel);
  } else {
    assert.equal(contact.querySelectorAll('a[href^="https://wa.me/"]').length, 0);
  }
  if (site.contact.phone || site.contact.email || site.contact.whatsappUrl || site.contact.form.endpoint) assert.ok(!contact.textContent.includes(site.contact.unavailableDescription));
  const forms = [...page.querySelectorAll('form')];
  assert.equal(forms.length, site.contact.form.endpoint ? 1 : 0, 'Never render a dead or unconfigured form');
  if (forms.length) {
    assert.equal(forms[0].getAttribute('action'), site.contact.form.endpoint);
    assert.equal(forms[0].getAttribute('method').toLowerCase(), 'post');
    for (const name of ['name', 'email', 'message']) assert.ok(forms[0].querySelector(`[name="${name}"][required]`));
  }
}

const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
assert.deepEqual(sitemapUrls.sort(), routes.filter((route) => route !== site.routes.notFound).map((route) => new URL(route, site.site.url).href).sort());

const deployDir = new URL('../.deploy/', import.meta.url);
const policy = JSON.parse(await readFile(new URL('response-headers-policy.json', deployDir), 'utf8'));
assert.deepEqual(policy, createCloudFrontPolicy(site));
assert.equal(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, createCsp(site));
assert.equal((await readFile(new URL('csp.txt', deployDir), 'utf8')).trim(), createCsp(site));
assert.deepEqual(JSON.parse(await readFile(new URL('security-headers.json', deployDir), 'utf8')), createSecurityHeaders(site));
assert.equal(await readFile(new URL('theme.css', root), 'utf8'), renderTheme(site));
for (const name of files.filter((file) => file.endsWith('.css'))) {
  const css = await readFile(new URL(name, root), 'utf8');
  assert.ok(!/@import|url\(\s*['"]?(?:https?:|\/\/|data:)/i.test(css), `${name}: external or inline resources are not permitted`);
}
console.log(`Verified ${documents.size} static pages and ${files.length} assets: links, content, CSP, external-only CSS and zero browser JavaScript.`);