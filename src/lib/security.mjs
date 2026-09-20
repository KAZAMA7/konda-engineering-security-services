export function createCsp(config, { meta = false } = {}) {
  const formSource = config.contact.form.endpoint ? new URL(config.contact.form.endpoint).origin : "'none'";
  const directives = [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    `form-action ${formSource}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    ...(!meta ? ["frame-ancestors 'none'"] : []),
    "manifest-src 'none'",
    'upgrade-insecure-requests',
  ];
  return `${directives.join('; ')};`;
}

export function createSecurityHeaders(config) {
  return {
    'Content-Security-Policy': createCsp(config),
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

export function createCloudFrontPolicy(config) {
  const headers = createSecurityHeaders(config);
  return {
    Comment: 'Static site security headers generated from site.config.json',
    SecurityHeadersConfig: {
      ContentSecurityPolicy: { ContentSecurityPolicy: headers['Content-Security-Policy'], Override: true },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: 'DENY', Override: true },
      ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: false, Preload: false, Override: true },
    },
    CustomHeadersConfig: {
      Items: ['Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy'].map((name) => ({ Header: name, Value: headers[name], Override: true })),
      Quantity: 3,
    },
  };
}

export function renderNginxHeaders(config) {
  const quote = (value) => `"${value.replace(/[\\"$]/g, '\\$&')}"`;
  return `${Object.entries(createSecurityHeaders(config)).map(([name, value]) => `add_header ${name} ${quote(value)} always;`).join('\n')}\n`;
}

export function renderTheme(config) {
  const { colors, fonts, radius, maxWidth } = config.theme;
  const tokens = [
    ...Object.entries(colors).map(([key, value]) => [`color-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value]),
    ['font-body', fonts.body], ['font-mono', fonts.mono],
    ['radius-card', radius.card], ['radius-button', radius.button], ['max-width', maxWidth],
  ];
  return `:root {\n${tokens.map(([key, value]) => `  --site-${key}: ${value};`).join('\n')}\n}\n`;
}