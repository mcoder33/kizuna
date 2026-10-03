import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['public/collaboration-editor.js'], bundle: true, external: ['./browser-i18n.js'], format: 'esm', target: ['es2022'], minify: true, legalComments: 'none', write: false });
const output = result.outputFiles[0].text;
const path = 'public/collaboration.bundle.js';
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== output) throw new Error('Collaboration bundle is stale. Run npm run build:collaboration.');
} else await writeFile(path, output);
