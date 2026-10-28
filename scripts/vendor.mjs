// Copies the speech runtime and fonts from node_modules into public/ so the app has no CDN dependency.
// Run once after `npm install`; the copied files are committed, so Netlify needs no build step for them.
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const nm = 'node_modules';
const out = 'public';
mkdirSync(join(out, 'vendor'), { recursive: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

cpSync(join(nm, '@huggingface/transformers/dist/transformers.min.js'), join(out, 'vendor/transformers.min.js'));
// CPU (WASM) runtime only. WebGPU builds are deliberately left out to keep the install small.
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(join(nm, 'onnxruntime-web/dist', f), join(out, 'vendor', f));
}
const want = {
  poppins: ['latin-400', 'latin-500', 'latin-600', 'latin-700'],
  'noto-sans-devanagari': ['devanagari-400', 'devanagari-500'],
  'ibm-plex-mono': ['latin-400', 'latin-500'],
  'noto-sans-tamil': ['tamil-400', 'tamil-500']
};
for (const [pkg, subs] of Object.entries(want)) {
  const dir = join(nm, '@fontsource', pkg, 'files');
  for (const s of subs) {
    const f = `${pkg}-${s}-normal.woff2`;
    if (existsSync(join(dir, f))) cpSync(join(dir, f), join(out, 'fonts', f));
    else console.warn('missing font', f, readdirSync(dir).filter((x) => x.includes(s.split('-')[0])).slice(0, 3));
  }
}
console.log('vendored');
