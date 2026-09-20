import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { site } from '../src/lib/config.mjs';
import { createCsp, createCloudFrontPolicy, createSecurityHeaders, renderNginxHeaders, renderTheme } from '../src/lib/security.mjs';

test('the default CSP disallows scripts, connections, framing, objects and form submissions', () => {
  const csp = createCsp(site);
  for (const directive of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp));
  assert.ok(csp.includes("style-src 'self'"));
});

test('only the configured HTTPS form provider is permitted by form-action', () => {
  const config = structuredClone(site);
  config.contact.form.endpoint = 'https://formspree.io/f/abc123';
  const csp = createCsp(config);
  assert.ok(csp.includes('form-action https://formspree.io;'));
  assert.ok(csp.includes("connect-src 'none'"));
  assert.ok(!csp.includes('https:;'));
});

test('all hosts share the same CSP and security header values', () => {
  const headers = createSecurityHeaders(site);
  const policy = createCloudFrontPolicy(site);
  assert.equal(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, headers['Content-Security-Policy']);
  assert.equal(policy.SecurityHeadersConfig.StrictTransportSecurity.AccessControlMaxAgeSec, 31536000);
  assert.equal(policy.SecurityHeadersConfig.StrictTransportSecurity.IncludeSubdomains, false);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.ok(headers['Permissions-Policy'].includes('camera=()'));
  assert.equal(Object.hasOwn(policy, 'Name'), false);
});

test('Tailwind scans only the site templates, so builds are reproducible across machines and containers', async () => {
  const stylesheet = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  assert.match(stylesheet, /^@import "tailwindcss" source\(none\);$/m, 'automatic source detection would leak README, script and generated-file tokens into the CSS hash');
  assert.deepEqual(stylesheet.match(/^@source .*$/gm), ['@source "../**/*.astro";']);
});

test('theme CSS derives all editable tokens from configuration, with no external imports', () => {
  const css = renderTheme(site);
  for (const color of Object.values(site.theme.colors)) assert.ok(css.includes(color));
  assert.ok(css.includes('--site-max-width: 80rem'));
  assert.ok(css.includes('--site-font-body:'));
  assert.ok(!/@import|url\(/.test(css));
});

test('Nginx emits the same security headers on all response statuses', () => {
  const config = structuredClone(site);
  for (const endpoint of ['', 'https://formspree.io/f/abc123']) {
    config.contact.form.endpoint = endpoint;
    const directives = renderNginxHeaders(config).trim().split('\n');
    assert.deepEqual(directives, Object.entries(createSecurityHeaders(config)).map(([name, value]) => `add_header ${name} "${value}" always;`));
    assert.ok(!/unsafe-inline|unsafe-eval/.test(directives.join('\n')));
  }
});