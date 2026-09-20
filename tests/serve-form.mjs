import { fileURLToPath } from 'node:url';
import { startPreview } from '../scripts/preview.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';
import { formConfig } from './form-config.mjs';

await startPreview({ directory: fileURLToPath(new URL('../.test-build/form-site/', import.meta.url)), headers: createSecurityHeaders(formConfig), port: 4322 });