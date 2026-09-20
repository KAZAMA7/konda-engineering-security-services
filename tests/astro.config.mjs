import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import config from '../astro.config.mjs';

export default defineConfig({
  ...config,
  srcDir: fileURLToPath(new URL('./fixtures/', import.meta.url)),
  outDir: fileURLToPath(new URL('../.test-build/form-site/', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../.test-build/astro-cache/', import.meta.url)),
});