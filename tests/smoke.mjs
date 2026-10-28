import { chromium } from './pw.mjs';
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 420, height: 900 } }); const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push('PAGEERR ' + e.message)); p.on('console', m => { if (['error','warning'].includes(m.type())) errs.push(m.type() + ' ' + m.text()); });
await p.goto('http://localhost:8099/?stub=1'); await p.waitForSelector('#app:not([hidden])', { timeout: 10000 });
console.log('chips', await p.locator('.bchip').count(), 'zones', await p.locator('#zones button').allTextContents());
await p.screenshot({ path: process.argv[2] || '/tmp/s.png' });
console.log(errs);
await b.close();
