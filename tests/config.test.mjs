import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSiteConfig, validateProductionConfig } from '../src/lib/config.mjs';

const fixture = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);

test('the central configuration contains all five required services and leadership credentials', () => {
  const config = parseSiteConfig(copy());
  assert.equal(config.site.name, 'Konda Engineering and security services');
  assert.equal(config.site.url, 'https://konda.com');
  assert.equal(config.ui.homeLabel, `${config.site.name} home`);
  assert.ok(config.site.title.startsWith(config.site.name));
  assert.ok(config.about.paragraphs[0].includes(config.site.name));
  assert.ok(config.footer.copyright.startsWith(config.site.name));
  assert.deepEqual(config.services.items.map(({ title }) => title), [
    'DevSecOps', 'Security Architecture', 'Governance, Risk, & Compliance (GRC)', 'Pentesting', 'Platform Engineering',
  ]);
  assert.deepEqual(config.about.credentials.map(({ name }) => name), ['CISSP', 'SABSA', 'RHCA']);
  assert.deepEqual(config.about.regions, ['Netherlands', 'United Arab Emirates']);
  assert.equal(config.site.locale, 'en-NL');
  assert.equal(config.contact.phone, '+31 626798365');
  assert.doesNotMatch(JSON.stringify(config), /\bIndia\b|en-IN/i);
  assert.ok(config.services.items[0].description.startsWith('Accelerate delivery without compromising safety.'));
});

test('the default contact details include the Arnhem address and WhatsApp number', () => {
  const config = parseSiteConfig(copy());
  assert.equal(config.contact.address, 'Charles Dickensstraat 35, Rijkerswoerd, Arnhem 6836 TR');
  assert.equal(config.contact.whatsappUrl, 'https://wa.me/31626798365');
  assert.equal(config.contact.whatsappUrl, `https://wa.me/${config.contact.phone.replace(/\D/g, '')}`);
});

test('the address and WhatsApp link can be changed or disabled in configuration', () => {
  const config = copy();
  config.contact.address = '  Nieuwegracht 1, Utrecht  ';
  config.contact.whatsappUrl = 'https://wa.me/441234567890';
  const parsed = parseSiteConfig(config);
  assert.equal(parsed.contact.address, 'Nieuwegracht 1, Utrecht');
  assert.equal(parsed.contact.whatsappUrl, config.contact.whatsappUrl);
  config.contact.address = '';
  config.contact.whatsappUrl = '';
  assert.equal(parseSiteConfig(config).contact.address, '');
  assert.equal(parseSiteConfig(config).contact.whatsappUrl, '');
  config.contact.address = 'a'.repeat(501);
  assert.throws(() => parseSiteConfig(config), /contact.address/);
});

test('WhatsApp links require the HTTPS click-to-chat host and an international number', () => {
  for (const whatsappUrl of [
    'javascript:alert(1)', 'http://wa.me/31626798365', '//wa.me/31626798365',
    'https://attacker.test/31626798365', 'https://wa.me.attacker.test/31626798365', 'https://wa.me@attacker.test/31626798365',
    'https://wa.me/+31626798365', 'https://wa.me/31 626798365', 'https://wa.me/031626798365',
    'https://wa.me/123456', 'https://wa.me/1234567890123456', 'https://wa.me/not-a-number',
    'https://wa.me/31626798365?redirect=elsewhere', 'https://wa.me/31626798365#fragment',
  ]) {
    const config = copy();
    config.contact.whatsappUrl = whatsappUrl;
    assert.throws(() => parseSiteConfig(config), /contact.whatsappUrl/, whatsappUrl);
  }
});

test('phone numbers require a country code and seven to fifteen digits', () => {
  for (const phone of ['31626798365', '+------', '+      ', '+0000000', '+123456', '+1234567890123456', 'javascript:alert(1)']) {
    const config = copy();
    config.contact.phone = phone;
    assert.throws(() => parseSiteConfig(config), /contact.phone/, phone);
  }
});

test('each capability has a distinct static page with its own scope and outcomes', () => {
  const config = parseSiteConfig(copy());
  assert.deepEqual(config.services.items.map(({ href }) => href), [
    '/devsecops.html', '/security-architecture.html', '/grc.html', '/pentesting.html', '/platform-engineering.html',
  ]);
  for (const service of config.services.items) {
    assert.ok(service.scope.length > 0);
    assert.ok(service.outcomes.length > 0);
  }
});

test('new services can be added without editing a component', () => {
  const config = copy();
  config.services.items.push({ ...config.services.items[0], id: 'new-capability', href: '/new-capability.html', title: 'New capability' });
  assert.equal(parseSiteConfig(config).services.items.length, 6);
});

test('capability routes reject unsafe URLs and collisions with existing pages', () => {
  for (const href of ['/index.html', '/nested/page.html', '/../escape.html', '/devsecops', '/devsecops.html#scope', '/devsecops.html?query=1', '//attacker.test', 'https://attacker.test/page.html', 'javascript:alert(1)']) {
    const config = copy();
    config.services.items[0].href = href;
    assert.throws(() => parseSiteConfig(config), /Invalid site configuration/, href);
  }
  for (const href of ['/privacy.html', '/404.html', '/security-architecture.html']) {
    const config = copy();
    config.services.items[0].href = href;
    assert.throws(() => parseSiteConfig(config), /unique/, href);
  }
});

test('capability pages cannot have empty scope or outcome content', () => {
  for (const field of ['scope', 'outcomes']) {
    const config = copy();
    config.services.items[0][field] = [];
    assert.throws(() => parseSiteConfig(config), /Invalid site configuration/);
  }
});

test('unknown fields and duplicate section or service identifiers fail closed', () => {
  const unknown = copy();
  unknown.contact.webhok = 'misspelled setting';
  assert.throws(() => parseSiteConfig(unknown), /Invalid site configuration/);
  const duplicate = copy();
  duplicate.services.items[1].id = duplicate.services.items[0].id;
  assert.throws(() => parseSiteConfig(duplicate), /unique/);
  const section = copy();
  section.about.id = section.contact.id;
  assert.throws(() => parseSiteConfig(section), /unique/);
  for (const id of ['capability-scope', 'capability-outcomes', 'capability-related']) {
    const config = copy();
    config.contact.id = id;
    assert.throws(() => parseSiteConfig(config), /unique/);
  }
});

test('navigation and routes must point to real local pages or sections', () => {
  for (const href of ['javascript:alert(1)', '//attacker.test', '#missing', '/missing.html']) {
    const config = copy();
    config.navigation[0].href = href;
    assert.throws(() => parseSiteConfig(config), /Invalid site configuration/);
  }
  const collision = copy();
  collision.routes.privacy = collision.routes.notFound;
  assert.throws(() => parseSiteConfig(collision), /unique/);
});

test('navigation can link directly to configured capability pages', () => {
  const config = copy();
  config.navigation[0].href = '/devsecops.html';
  assert.equal(parseSiteConfig(config).navigation[0].href, '/devsecops.html');
});

test('theme tokens reject CSS injection', () => {
  const color = copy();
  color.theme.colors.accent = 'red; background: url(https://attacker.test)';
  assert.throws(() => parseSiteConfig(color), /Invalid site configuration/);
  const font = copy();
  font.theme.fonts.body = 'sans-serif; } body { display:none';
  assert.throws(() => parseSiteConfig(font), /Invalid site configuration/);
});

test('webhooks must be public HTTPS URLs without credentials, query strings or fragments', () => {
  for (const endpoint of [
    'not-a-url', 'http://formspree.io/f/example', 'javascript:alert(1)', 'https://user:pass@formspree.io/f/example',
    'https://formspree.io/f/example?secret=token', 'https://formspree.io/f/example#fragment',
    'https://localhost/submit', 'https://127.0.0.1/submit', 'https://192.168.1.1/submit',
    'https://formspree.io:8443/f/example', "https://bad;script-src.example/submit",
  ]) {
    const config = copy();
    config.contact.form.endpoint = endpoint;
    config.contact.form.providerName = 'Provider';
    assert.throws(() => parseSiteConfig(config), /Invalid site configuration/, endpoint);
  }
});

test('an enabled form must identify its external provider', () => {
  const config = copy();
  config.contact.form.endpoint = 'https://formspree.io/f/abc123';
  assert.throws(() => parseSiteConfig(config), /providerName/);
  config.contact.form.providerName = 'Formspree';
  assert.equal(parseSiteConfig(config).contact.form.endpoint, config.contact.form.endpoint);
});

test('malformed canonical URLs and same-origin form handlers are rejected clearly', () => {
  const config = copy();
  config.site.url = 'not-a-url';
  assert.throws(() => parseSiteConfig(config), /Invalid site configuration/);
  config.site.url = 'https://security.consulting';
  config.contact.form.endpoint = 'https://security.consulting/submit';
  config.contact.form.providerName = 'Provider';
  assert.throws(() => parseSiteConfig(config), /external provider/);
});

test('production validation refuses starter placeholders and missing contact channels', () => {
  const config = copy();
  config.site.url = 'https://example.com';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /canonical/);
  config.site.url = 'https://security.consulting';
  config.contact.phone = '';
  config.contact.whatsappUrl = '';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /contact/);
  config.contact.email = 'hello@example.com';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /placeholder/);
  config.contact.email = 'hello@security.consulting';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
});

test('production permits a configured webhook without publishing an email address', () => {
  const config = copy();
  config.site.url = 'https://security.consulting';
  config.contact.phone = '';
  config.contact.whatsappUrl = '';
  config.contact.form.endpoint = 'https://formspree.io/f/abc123';
  config.contact.form.providerName = 'Formspree';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
  config.contact.form.endpoint = 'https://formspree.io/f/REPLACE_ME';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /placeholder/);
});

test('production permits the configured domain with phone or WhatsApp contact', () => {
  const config = copy();
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
  config.contact.whatsappUrl = '';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
  config.contact.phone = '';
  config.contact.whatsappUrl = 'https://wa.me/31626798365';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
  config.contact.email = 'hello@example.com';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /placeholder/);
});