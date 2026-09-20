import { site, parseSiteConfig } from '../src/lib/config.mjs';

const fixture = structuredClone(site);
fixture.contact.form.endpoint = 'https://formspree.io/f/ci-smoke-test';
fixture.contact.form.providerName = 'Formspree';
export const formConfig = parseSiteConfig(fixture);