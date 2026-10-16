import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const output = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const files = readdirSync(output, { recursive: true }).filter(file => file.endsWith('.html'));
assert.equal(files.length, 13, 'Expected root, two landing pages and ten docs');
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
for (const file of files) {
  const html = readFileSync(join(output, file), 'utf8');
  assert(!/javascript:|file:\/\/|\/Users\/|\.project-context\/records/i.test(html), `Unsafe output: ${file}`);
  if (file !== 'index.html') {
    const lang = file.split(sep)[0];
    assert(html.includes(`<html lang="${lang}">`), `Wrong locale: ${file}`);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `Expected one h1: ${file}`);
    if (file.endsWith(`${sep}index.html`)) {
      assert(html.includes(`/releases/tag/v${version}`), `Missing current release link: ${file}`);
      assert(html.includes(`mcp-project-context-router-${version}.tgz`), `Wrong install version: ${file}`);
      assert(html.includes('ZCode') && html.includes('DeepSeek Harness'), `Missing supported clients: ${file}`);
      assert.equal((html.match(/class="doc-row"/g) ?? []).length, 5, `Missing documentation entry points: ${file}`);
      assert(html.includes('href="#workflow"') && html.includes('id="workflow"'), `Missing workflow navigation: ${file}`);
      assert(html.includes('src/auth/session.ts') && html.includes('<dl>'), `Missing readable context example: ${file}`);
      assert(html.includes('JavaScript'), `Missing JavaScript support: ${file}`);
    }
    const other = lang === 'en' ? 'ru' : 'en';
    const paired = relative(dirname(join(output, file)), join(output, file.replace(lang + sep, other + sep))).split(sep).join('/');
    assert(html.includes(`hreflang="${other}" href="${paired}"`), `Missing matching translation: ${file}`);
  }
  for (const [, raw] of html.matchAll(/(?:href|src)="([^" ]+)"/g)) {
    const value = decode(raw);
    if (/^https:\/\//.test(value)) continue;
    assert(!/^(?:[a-z]+:|\/)/i.test(value), `Unsupported URL: ${value}`);
    const [pathname, fragment] = value.split('#');
    let target = pathname ? resolve(dirname(join(output, file)), decodeURIComponent(pathname)) : join(output, file);
    assert(target.startsWith(output + sep) || target === output, `Link escapes site: ${value}`);
    assert(existsSync(target), `Broken link in ${file}: ${value}`);
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    assert(existsSync(target), `Missing index: ${value}`);
    if (fragment) assert(readFileSync(target, 'utf8').includes(`id="${decodeURIComponent(fragment)}"`), `Broken anchor: ${file} → ${value}`);
  }
}
console.log(`Checked ${files.length} pages: locale pairs, headings, local assets, links and anchors.`);
