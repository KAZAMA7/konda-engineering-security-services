import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { site } from '../src/lib/config.mjs';
import { createCsp, createCloudFrontPolicy, createSecurityHeaders, renderTheme } from '../src/lib/security.mjs';

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

test('the CloudFront response headers policy carries exactly the generated security headers', () => {
  const config = structuredClone(site);
  for (const endpoint of ['', 'https://formspree.io/f/abc123']) {
    config.contact.form.endpoint = endpoint;
    const headers = createSecurityHeaders(config);
    const policy = createCloudFrontPolicy(config);
    const security = policy.SecurityHeadersConfig;
    assert.equal(security.ContentSecurityPolicy.ContentSecurityPolicy, headers['Content-Security-Policy']);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(security.ContentSecurityPolicy.ContentSecurityPolicy));
    assert.deepEqual(security.StrictTransportSecurity, { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true });
    assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000', 'the JSON headers must describe what CloudFront will emit');
    assert.equal(security.FrameOptions.FrameOption, headers['X-Frame-Options']);
    assert.equal(security.ReferrerPolicy.ReferrerPolicy, headers['Referrer-Policy']);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.ok(security.ContentTypeOptions.Override);
    const custom = Object.fromEntries(policy.CustomHeadersConfig.Items.map(({ Header, Value }) => [Header, Value]));
    assert.equal(policy.CustomHeadersConfig.Quantity, policy.CustomHeadersConfig.Items.length);
    assert.ok(policy.CustomHeadersConfig.Items.every(({ Override }) => Override === true));
    assert.deepEqual({
      'Content-Security-Policy': security.ContentSecurityPolicy.ContentSecurityPolicy,
      'Strict-Transport-Security': `max-age=${security.StrictTransportSecurity.AccessControlMaxAgeSec}`,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': security.FrameOptions.FrameOption,
      'Referrer-Policy': security.ReferrerPolicy.ReferrerPolicy,
      ...custom,
    }, headers, 'every header in security-headers.json must be delivered by the CloudFront policy');
    assert.ok(headers['Permissions-Policy'].includes('camera=()'));
    assert.equal(Object.hasOwn(policy, 'Name'), false, 'the workflow merges the existing policy name');
    assert.deepEqual(Object.keys(policy).sort(), ['Comment', 'CustomHeadersConfig', 'SecurityHeadersConfig']);
  }
});

test('Tailwind scans only the site templates, so builds are reproducible across machines and CI runners', async () => {
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