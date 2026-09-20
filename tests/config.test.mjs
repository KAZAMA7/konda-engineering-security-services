import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSiteConfig, validateProductionConfig } from '../src/lib/config.mjs';

const fixture = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);

test('the central configuration contains all five required services and leadership credentials', () => {
  const config = parseSiteConfig(copy());
  assert.equal(config.site.name, 'Konda Engineering and security services');
  assert.equal(config.ui.homeLabel, `${config.site.name} home`);
  assert.ok(config.site.title.startsWith(config.site.name));
  assert.ok(config.about.paragraphs[0].includes(config.site.name));
  assert.ok(config.footer.copyright.startsWith(config.site.name));
  assert.deepEqual(config.services.items.map(({ title }) => title), [
    'DevSecOps', 'Security Architecture', 'Governance, Risk, & Compliance (GRC)', 'Pentesting', 'Platform Engineering',
  ]);
  assert.deepEqual(config.about.credentials.map(({ name }) => name), ['CISSP', 'SABSA', 'RHCA']);
  assert.deepEqual(config.about.regions, ['India', 'United Arab Emirates']);
  assert.ok(config.services.items[0].description.startsWith('Accelerate delivery without compromising safety.'));
});

test('new services can be added without editing a component', () => {
  const config = copy();
  config.services.items.push({ ...config.services.items[0], id: 'new-capability', title: 'New capability' });
  assert.equal(parseSiteConfig(config).services.items.length, 6);
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
  assert.throws(() => validateProductionConfig(parseSiteConfig(copy())), /canonical/);
  const config = copy();
  config.site.url = 'https://security.consulting';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /contact/);
  config.contact.email = 'hello@example.com';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /placeholder/);
  config.contact.email = 'hello@security.consulting';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
});

test('production permits a configured webhook without publishing an email address', () => {
  const config = copy();
  config.site.url = 'https://security.consulting';
  config.contact.form.endpoint = 'https://formspree.io/f/abc123';
  config.contact.form.providerName = 'Formspree';
  assert.doesNotThrow(() => validateProductionConfig(parseSiteConfig(config)));
  config.contact.form.endpoint = 'https://formspree.io/f/REPLACE_ME';
  assert.throws(() => validateProductionConfig(parseSiteConfig(config)), /placeholder/);
});