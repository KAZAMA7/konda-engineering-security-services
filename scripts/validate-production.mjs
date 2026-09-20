import { site, validateProductionConfig } from '../src/lib/config.mjs';

try {
  validateProductionConfig(site);
  console.log('Production configuration checks passed. Verify domain ownership and published contact channels before release.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}