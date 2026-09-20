import { mkdir, rm, writeFile } from 'node:fs/promises';
import { site } from '../src/lib/config.mjs';
import { createCloudFrontPolicy, createCsp, createSecurityHeaders, renderTheme } from '../src/lib/security.mjs';

const publicDir = new URL('../public/', import.meta.url);
const deployDir = new URL('../.deploy/', import.meta.url);
await Promise.all([mkdir(publicDir, { recursive: true }), mkdir(deployDir, { recursive: true })]);
// Builds from the container branch leave host-specific files behind; S3 publishes every file in dist, so remove them.
await Promise.all([rm(new URL('_headers', publicDir), { force: true }), rm(new URL('nginx-security-headers.conf', deployDir), { force: true })]);
const headers = createSecurityHeaders(site);
const escapeXml = (value) => value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
const urls = [site.routes.home, site.routes.privacy, ...site.services.items.map((service) => service.href)].map((route) => new URL(route, site.site.url).href);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeXml(url)}</loc></url>`).join('')}</urlset>\n`;
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${site.theme.colors.canvas}"/><path d="M32 10 49 17v14c0 12-8 20-17 25-9-5-17-13-17-25V17Z" fill="none" stroke="${site.theme.colors.accent}" stroke-width="4"/><path d="m24 32 6 6 12-13" fill="none" stroke="${site.theme.colors.accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;

await Promise.all([
  writeFile(new URL('theme.css', publicDir), renderTheme(site)),
  writeFile(new URL('favicon.svg', publicDir), favicon),
  writeFile(new URL('robots.txt', publicDir), site.site.indexable ? `User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml', site.site.url).href}\n` : 'User-agent: *\nDisallow: /\n'),
  writeFile(new URL('sitemap.xml', publicDir), sitemap),
  writeFile(new URL('response-headers-policy.json', deployDir), `${JSON.stringify(createCloudFrontPolicy(site), null, 2)}\n`),
  writeFile(new URL('security-headers.json', deployDir), `${JSON.stringify(headers, null, 2)}\n`),
  writeFile(new URL('csp.txt', deployDir), `${createCsp(site)}\n`),
]);
console.log('Validated site.config.json; generated theme, CloudFront security policy, favicon and crawl metadata.');