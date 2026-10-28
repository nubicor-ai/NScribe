// Playwright is preinstalled globally; ESM cannot import it directly, so load it through require.
import { createRequire } from 'node:module';
export const { chromium } = createRequire(import.meta.url)('playwright');
