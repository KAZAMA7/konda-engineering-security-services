import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { site } from '../../src/lib/config.mjs';
import { createSecurityHeaders } from '../../src/lib/security.mjs';

const contentPaths = [site.routes.home, ...site.services.items.map((service) => service.href)];

test('renders every configured service without third-party requests or CSP violations', async ({ page }) => {
  const requests: string[] = [];
  const violations: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('console', (message) => {
    if (/content security policy|violates.*directive/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  for (const [name, value] of Object.entries(createSecurityHeaders(site))) {
    expect(response?.headers()[name.toLowerCase()]).toBe(value);
  }
  await expect(page).toHaveTitle(site.site.title);
  await expect(page.locator('h1')).toContainText(site.hero.headline);
  await expect(page.locator('[data-service]')).toHaveCount(site.services.items.length);
  for (const service of site.services.items) await expect(page.locator(`#${service.id} p`)).toHaveText(service.description);
  await expect(page.locator(`#${site.about.id}`)).toContainText('Netherlands');
  await expect(page.locator('body')).not.toContainText(/\bIndia\b/);
  await expect(page.locator(`#${site.contact.id}`).getByRole('link', { name: site.contact.phone, exact: true }).first()).toHaveAttribute('href', 'tel:+31626798365');
  await expect(page.locator(`#${site.contact.id} address`)).toHaveText(site.contact.address);
  await expect(page.locator(`#${site.contact.id}`).getByRole('link', { name: site.ui.whatsappCtaLabel, exact: true })).toHaveAttribute('href', site.contact.whatsappUrl);
  await expect(page.getByText(site.contact.unavailableDescription, { exact: true })).toHaveCount(0);
  await expect(page.locator('script, style, [style]')).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(site.contact.form.endpoint ? 1 : 0);
  expect(requests.every((url) => new URL(url).origin === 'http://127.0.0.1:4321')).toBe(true);
  expect(violations).toEqual([]);
});

for (const service of site.services.items) {
  test(`${service.title} has a dedicated, directly accessible capability page`, async ({ page }) => {
    const requests: string[] = [];
    const violations: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (/content security policy|violates.*directive/i.test(message.text())) violations.push(message.text());
    });
    await page.goto('/');
    await page.getByRole('link', { name: `${site.services.ctaLabel}: ${service.title}`, exact: true }).click();
    await expect(page).toHaveURL(service.href);
    const response = await page.reload();
    expect(response?.status()).toBe(200);
    for (const [name, value] of Object.entries(createSecurityHeaders(site))) {
      expect(response?.headers()[name.toLowerCase()]).toBe(value);
    }
    await expect(page).toHaveTitle(`${service.title} | ${site.site.name}`);
    await expect(page.locator('h1')).toHaveText(service.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new URL(service.href, site.site.url).href);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', service.description);
    await expect(page.locator('[data-capability-scope] h3')).toHaveText(service.scope.map((item) => item.title));
    await expect(page.locator('[data-capability-scope] p')).toHaveText(service.scope.map((item) => item.description));
    await expect(page.locator('[data-capability-outcomes] li')).toHaveText(service.outcomes);
    await expect(page.locator('script, style, [style]')).toHaveCount(0);
    await page.getByRole('link', { name: site.services.page.contactCtaLabel, exact: true }).click();
    await expect(page).toHaveURL(`${service.href}#${site.contact.id}`);
    await expect(page.locator(`#${site.contact.id}-heading`)).toBeInViewport();
    await expect(page.locator(`#${site.contact.id}`).getByRole('link', { name: site.contact.phone, exact: true }).first()).toHaveAttribute('href', 'tel:+31626798365');
    await expect(page.locator(`#${site.contact.id} address`)).toHaveText(site.contact.address);
    await expect(page.locator(`#${site.contact.id}`).getByRole('link', { name: site.ui.whatsappCtaLabel, exact: true })).toHaveAttribute('href', site.contact.whatsappUrl);
    await expect(page.getByText(site.contact.unavailableDescription, { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: site.ui.backToTop, exact: true }).click();
    await expect(page).toHaveURL(`${service.href}#main-content`);
    await expect(page.locator('h1')).toBeInViewport();
    const related = page.getByRole('navigation', { name: site.services.page.relatedTitle, exact: true });
    const otherServices = site.services.items.filter((item) => item.id !== service.id);
    await expect(related.getByRole('link')).toHaveCount(otherServices.length);
    for (const other of otherServices) {
      await expect(related.getByRole('link', { name: other.title, exact: true })).toHaveAttribute('href', other.href);
    }
    await related.getByRole('link').first().click();
    await expect(page).toHaveURL(otherServices[0].href);
    await expect(page.locator('h1')).toHaveText(otherServices[0].title);
    await page.getByRole('link', { name: site.services.page.backLabel, exact: true }).click();
    await expect(page).toHaveURL(`/#${site.services.id}`);
    await expect(page.locator(`#${site.services.id}-heading`)).toBeInViewport();
    expect(requests.every((url) => new URL(url).origin === 'http://127.0.0.1:4321')).toBe(true);
    expect(violations).toEqual([]);
  });
}

test('navigation, keyboard access and content work with JavaScript disabled', async ({ browser, isMobile }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4321/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: site.ui.skipLink })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  if (isMobile) {
    await page.locator('summary').click();
    await expect(page.getByRole('navigation', { name: site.ui.mobileNavigation })).toBeVisible();
    await page.getByRole('navigation', { name: site.ui.mobileNavigation }).getByRole('link', { name: site.navigation[0].label }).click();
  } else {
    await page.getByRole('navigation', { name: site.ui.mainNavigation }).getByRole('link', { name: site.navigation[0].label }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${site.navigation[0].href}$`));
  await expect(page.locator(`#${site.services.id}-heading`)).toBeInViewport();
  const service = site.services.items[0];
  await page.getByRole('link', { name: `${site.services.ctaLabel}: ${service.title}`, exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:4321${service.href}`);
  await expect(page.locator('h1')).toHaveText(service.title);
  await page.getByRole('link', { name: site.services.page.contactCtaLabel, exact: true }).click();
  await expect(page.locator(`#${site.contact.id}-heading`)).toBeInViewport();
  await expect(page.locator('a[href="tel:+31626798365"]').first()).toBeVisible();
  if (isMobile) await page.locator('summary').click();
  await page.getByRole('navigation', { name: isMobile ? site.ui.mobileNavigation : site.ui.mainNavigation, exact: true }).getByRole('link', { name: site.navigation[0].label, exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:4321/#${site.services.id}`);
  await expect(page.locator(`#${site.services.id}-heading`)).toBeInViewport();
  await expect(page.locator(`#${site.contact.id} address`)).toHaveText(site.contact.address);
  await page.route(site.contact.whatsappUrl, async (route) => {
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>WhatsApp conversation</title>' });
  });
  await page.getByRole('link', { name: site.ui.whatsappCtaLabel, exact: true }).click();
  await expect(page).toHaveURL(site.contact.whatsappUrl);
  await expect(page).toHaveTitle('WhatsApp conversation');
  await context.close();
});

test('home and capability pages have no horizontal overflow at narrow and wide viewports', async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of contentPaths) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} at ${width}px`).toBe(true);
      await expect(page.getByRole('link', { name: site.ui.homeLabel, exact: true })).toBeVisible();
    }
  }
});

test('home, privacy and all capability pages pass automated WCAG accessibility checks', async ({ page }) => {
  for (const path of [...contentPaths, site.routes.privacy]) {
    await page.goto(path);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations, path).toEqual([]);
  }
});

test('static privacy and missing-page routes are served with security headers', async ({ page }) => {
  await page.goto(site.routes.privacy);
  await expect(page.locator('h1')).toHaveText(site.privacy.title);
  const response = await page.goto('/a-page-that-does-not-exist');
  expect(response?.status()).toBe(404);
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  await expect(page.locator('h1')).toHaveText(site.notFound.title);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('the enforced CSP blocks an injected inline script', async ({ page }) => {
  await page.goto('/');
  const blocked = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'document.documentElement.dataset.compromised = "true"';
    document.body.append(script);
    return document.documentElement.dataset.compromised === undefined;
  });
  expect(blocked).toBe(true);
});