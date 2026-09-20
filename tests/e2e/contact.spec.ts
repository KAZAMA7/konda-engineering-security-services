import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { formConfig } from '../form-config.mjs';

const endpoint = formConfig.contact.form.endpoint;

test('configured form is accessible and browser validation stops empty submissions', async ({ page }) => {
  const requests: string[] = [];
  await page.route(endpoint, async (route) => {
    requests.push(route.request().method());
    await route.abort();
  });
  await page.goto('http://127.0.0.1:4322/');
  await page.getByRole('button', { name: formConfig.contact.form.submitLabel }).click();
  await expect(page.locator('#enquiry-name')).toBeFocused();
  expect(await page.locator('form').evaluate((element) => (element as HTMLFormElement).checkValidity())).toBe(false);
  expect(requests).toEqual([]);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
});

test('native POST sends expected fields directly to the allowed webhook', async ({ page }) => {
  await page.route(endpoint, async (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Test submission accepted</title><h1>Accepted</h1>' }));
  await page.goto('http://127.0.0.1:4322/');
  await page.locator('#enquiry-name').fill('Test Consultant');
  await page.locator('#enquiry-email').fill('test@example.com');
  await page.locator('#enquiry-company').fill('Example organization');
  await page.locator('#enquiry-message').fill('A test enquiry about a cloud architecture assessment.');
  const requestPromise = page.waitForRequest(endpoint);
  await page.getByRole('button', { name: formConfig.contact.form.submitLabel }).click();
  const request = await requestPromise;
  expect(request.method()).toBe('POST');
  expect(request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
  const body = new URLSearchParams(request.postData() ?? '');
  expect(body.get('name')).toBe('Test Consultant');
  expect(body.get('email')).toBe('test@example.com');
  expect(body.get('company')).toBe('Example organization');
  expect(body.get('message')).toBe('A test enquiry about a cloud architecture assessment.');
  expect(body.get('_gotcha')).toBe('');
  expect(body.get('_subject')).toBe(formConfig.contact.form.subject);
  await expect(page).toHaveURL(endpoint);
});

test('CSP blocks form submissions to a different host', async ({ page }) => {
  const outbound: string[] = [];
  const violations: string[] = [];
  await page.route('https://blocked.invalid/**', async (route) => {
    outbound.push(route.request().url());
    await route.abort();
  });
  page.on('console', (message) => {
    if (/form-action/.test(message.text())) violations.push(message.text());
  });
  await page.goto('http://127.0.0.1:4322/');
  await page.locator('form').evaluate((element) => {
    const form = element as HTMLFormElement;
    form.action = 'https://blocked.invalid/submit';
    form.submit();
  });
  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(outbound).toEqual([]);
  expect(await page.evaluate(() => window.location.href)).toBe('http://127.0.0.1:4322/');
  expect(await page.evaluate(() => document.querySelector('form')?.checkVisibility())).toBe(true);
});