import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { site } from '../../src/lib/config.mjs';
import { createSecurityHeaders } from '../../src/lib/security.mjs';

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
  await expect(page.locator('script, style, [style]')).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(site.contact.form.endpoint ? 1 : 0);
  expect(requests.every((url) => new URL(url).origin === 'http://127.0.0.1:4321')).toBe(true);
  expect(violations).toEqual([]);
});

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
  await context.close();
});

test('has no horizontal overflow at narrow and wide viewports', async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('link', { name: site.ui.homeLabel, exact: true })).toBeVisible();
  }
});

test('home and privacy pages pass automated WCAG accessibility checks', async ({ page }) => {
  for (const path of [site.routes.home, site.routes.privacy]) {
    await page.goto(path);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
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