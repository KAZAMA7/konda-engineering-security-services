import { isIP } from 'node:net';
import { z } from 'zod';
import source from '../../site.config.json' with { type: 'json' };

const text = z.string().trim().min(1).max(5000);
const label = text.max(240);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const pageRoute = z.string().regex(/^\/[a-z][a-z0-9-]*\.html$/).refine((value) => value !== '/index.html', 'The index route is reserved');
const icon = z.enum(['terminal', 'layers', 'compass', 'target', 'search', 'arrow', 'shield', 'check']);
const link = z.strictObject({ label, href: z.string().regex(/^(?:\/(?:[a-z0-9-]+\.html)?|#[a-z][a-z0-9-]*)$/) });
const field = z.strictObject({ label, placeholder: label });
const description = z.strictObject({ title: label, description: text });

function isPublicHttps(value) {
  try {
    if (/[\s\\<>"'\u0000-\u001f\u007f]/.test(value)) return false;
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && isIP(host) === 0 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) &&
      !/(?:^|\.)(?:localhost|local|internal|lan)$/.test(host);
  } catch {
    return false;
  }
}

const httpsUrl = z.string().refine(isPublicHttps, 'Use a public HTTPS URL without credentials, a custom port, query string, or fragment');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const font = z.string().min(1).max(240).regex(/^[a-zA-Z0-9 ,"-]+$/);
const radius = z.string().regex(/^(?:0|[0-3](?:\.\d{1,3})?rem)$/);
const section = { id, eyebrow: label, title: text };

const schema = z.strictObject({
  schemaVersion: z.literal(1),
  site: z.strictObject({
    name: label,
    monogram: z.string().regex(/^[A-Z0-9]{1,4}$/),
    url: httpsUrl.refine((value) => isPublicHttps(value) && new URL(value).pathname === '/', 'The canonical URL must be an origin, without a path'),
    locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    title: label,
    description: text,
    indexable: z.boolean(),
  }),
  routes: z.strictObject({
    home: z.literal('/'),
    privacy: pageRoute,
    notFound: z.literal('/404.html'),
  }),
  theme: z.strictObject({
    colors: z.strictObject({ canvas: color, surface: color, elevated: color, border: color, text: color, muted: color, accent: color, secondary: color, onAccent: color }),
    fonts: z.strictObject({ body: font, mono: font }),
    radius: z.strictObject({ card: radius, button: radius }),
    maxWidth: z.string().regex(/^(?:[5-9]\d|1[0-2]\d)rem$/),
  }),
  ui: z.strictObject({ skipLink: label, mainNavigation: label, mobileNavigation: label, menuLabel: label, homeLabel: label, legalNavigation: label, emailLabel: label, phoneLabel: label, whatsappLabel: label, whatsappCtaLabel: label, addressLabel: label, requiredLabel: label, backToTop: label }),
  navigation: z.array(link).min(1).max(8),
  header: z.strictObject({ descriptor: label, contactCta: link }),
  hero: z.strictObject({
    id,
    eyebrow: label,
    headline: label,
    accentLine: label,
    description: text,
    primaryCta: link,
    secondaryCta: link,
    signals: z.array(label).min(1).max(6),
    visual: z.strictObject({
      eyebrow: label, title: label, description: text,
      layers: z.array(description.extend({ icon })).min(1).max(5),
      footer: label,
    }),
  }),
  services: z.strictObject({
    ...section, intro: text, capabilityLabel: label, ctaLabel: label,
    page: z.strictObject({ backLabel: label, scopeTitle: label, outcomesTitle: label, contactCtaLabel: label, relatedTitle: label }),
    items: z.array(z.strictObject({
      id, href: pageRoute, icon, title: label, description: text,
      tags: z.array(label).min(1).max(6),
      scope: z.array(description).min(1).max(12),
      outcomes: z.array(text).min(1).max(12),
    })).min(1).max(30),
  }),
  approach: z.strictObject({ ...section, intro: text, steps: z.array(description).min(1).max(6) }),
  about: z.strictObject({
    ...section,
    paragraphs: z.array(text).min(1),
    credentialsLabel: label,
    credentials: z.array(z.strictObject({ name: label, detail: label })).min(1),
    regionLabel: label,
    regions: z.array(label).min(1),
  }),
  contact: z.strictObject({
    ...section, intro: text,
    email: z.union([z.literal(''), z.email()]),
    phone: z.union([z.literal(''), z.string().regex(/^\+[0-9 ()-]{6,25}$/).refine((value) => /^\+[1-9][0-9]{6,14}$/.test(value.replace(/[ ()-]/g, '')), 'Use an international phone number with a country code')]),
    whatsappUrl: z.union([z.literal(''), z.string().trim().regex(/^https:\/\/wa\.me\/[1-9][0-9]{6,14}$/, 'Use https://wa.me/ followed by an international number without +, spaces, or punctuation')]),
    address: z.string().trim().max(500),
    safetyNote: text, unavailableTitle: label, unavailableDescription: text,
    form: z.strictObject({
      endpoint: z.union([z.literal(''), httpsUrl]),
      providerName: z.string().trim().max(120),
      title: label, intro: text,
      fields: z.strictObject({ name: field, email: field, company: field, message: field }),
      honeypotLabel: label, submitLabel: label, externalNotice: text,
      privacyPrefix: text, privacyLabel: label, subject: label,
    }),
  }),
  privacy: z.strictObject({
    eyebrow: label, title: text, intro: text,
    sections: z.array(z.strictObject({ title: label, paragraphs: z.array(text).min(1) })).min(1),
    backLabel: label,
  }),
  notFound: z.strictObject({ eyebrow: label, title: text, description: text, backLabel: label }),
  footer: z.strictObject({ tagline: label, copyrightStartYear: z.number().int().min(2000).max(2100), copyright: label, links: z.array(link).min(1) }),
}).superRefine((config, context) => {
  const sections = [config.hero, config.services, config.approach, config.about, config.contact];
  const contentIds = [...sections, ...config.services.items].map((item) => item.id);
  const renderedIds = [...contentIds, ...contentIds.map((value) => `${value}-heading`), 'main-content', 'enquiry-name', 'enquiry-email', 'enquiry-company', 'enquiry-message', 'enquiry-note', 'contact-form-heading', 'capability-scope-heading', 'capability-outcomes-heading', 'capability-related-heading'];
  if (new Set(renderedIds).size !== renderedIds.length) {
    context.addIssue({ code: 'custom', path: ['services'], message: 'Section, service and generated HTML identifiers must be unique' });
  }
  const routes = [...Object.values(config.routes), ...config.services.items.map((service) => service.href)];
  if (new Set(routes).size !== routes.length) {
    context.addIssue({ code: 'custom', path: ['routes'], message: 'Routes must be unique' });
  }
  const targets = new Set([...routes, ...contentIds.map((value) => `#${value}`)]);
  const links = [...config.navigation, ...config.footer.links, config.header.contactCta, config.hero.primaryCta, config.hero.secondaryCta];
  for (const item of links) {
    if (!targets.has(item.href)) context.addIssue({ code: 'custom', path: ['navigation'], message: `Unknown link target: ${item.href}` });
  }
  if (config.contact.form.endpoint && !config.contact.form.providerName) {
    context.addIssue({ code: 'custom', path: ['contact', 'form', 'providerName'], message: 'Identify the external service before enabling the form' });
  }
  if (isPublicHttps(config.contact.form.endpoint) && isPublicHttps(config.site.url) && new URL(config.contact.form.endpoint).origin === new URL(config.site.url).origin) {
    context.addIssue({ code: 'custom', path: ['contact', 'form', 'endpoint'], message: 'The form must submit to an external provider, not the static website' });
  }
});

export function parseSiteConfig(value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid site configuration:\n${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}`);
  }
  return result.data;
}

function isPlaceholder(value) {
  return /(?:^|[.@/])example\.(?:com|org|net)(?:$|[/:])|\.(?:test|invalid|localhost)(?:$|[/:])|replace[_-]?me|your[_-]?(?:domain|form|email)|placeholder/i.test(value);
}

export function validateProductionConfig(config) {
  if (isPlaceholder(config.site.url)) throw new Error('Set a real canonical site.url before production deployment.');
  if (!config.contact.email && !config.contact.phone && !config.contact.whatsappUrl && !config.contact.form.endpoint) throw new Error('Configure a verified contact email, phone, WhatsApp link, or HTTPS form endpoint before production deployment.');
  if ([config.contact.email, config.contact.form.endpoint].some(isPlaceholder)) throw new Error('Replace placeholder contact details before production deployment.');
  return config;
}

export const site = parseSiteConfig(source);

export function homeHref(href) {
  return href.startsWith('#') ? `${site.routes.home}${href}` : href;
}