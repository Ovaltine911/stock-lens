import { readFile } from 'node:fs/promises';
import { checkPage } from './design-checker.mjs';

const root = new URL('../', import.meta.url);
let total = 0;
for (const name of ['public/index.html', 'scripts/setup/index.html']) {
  const issues = checkPage(await readFile(new URL(name, root), 'utf8'));
  total += issues.length;
  console.log(`${name}: ${issues.length ? JSON.stringify(issues) : '全部合规'}`);
}
const css = await readFile(new URL('public/styles.css', root), 'utf8');
const issues = checkPage(`<style>${css}</style>`);
total += issues.length;
console.log(`public/styles.css: ${issues.length ? JSON.stringify(issues) : '全部合规'}`);
if (total) process.exitCode = 1;
