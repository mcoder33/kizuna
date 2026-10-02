import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys = new Set();
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (['node_modules','dist','.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!/\.(?:js|swift|html)$/.test(file) || entry.name === 'i18n-catalog.js') continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      if (!/\b(?:t|L|translate|requestText)\(|\b(?:source|message)\s*:/.test(line)) continue;
      for (const match of line.matchAll(/(['"])((?:\\.|(?!\1).)*?)\1/g)) if (/[А-Яа-яёЁ]/.test(match[2])) keys.add(match[2].replaceAll('\\n','\n'));
    }
    for (const pattern of [/\b(?:t|L)\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g, /(?:source|message):\s*(['"])((?:\\.|(?!\1).)*?)\1/g]) {
      for (const match of source.matchAll(pattern)) if (/[А-Яа-яёЁ]/.test(match[2])) keys.add(match[2].replaceAll('\\n','\n'));
    }
  }
}
for (const directory of (process.argv.includes('--core') ? ['server','desktop/macos/Sources'] : ['public','server','desktop/macos/Sources'])) scan(path.join(root,directory));
process.stdout.write(JSON.stringify([...keys].sort(),null,2)+'\n');
