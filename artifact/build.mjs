#!/usr/bin/env node
/**
 * Builds Kiiku as a claude.ai artifact: browser mode, relative asset paths, the
 * site config from artifact/config.json baked in, and index.html turned into the
 * fragment the artifact publisher wraps in its own document skeleton.
 *
 *   npm run build:artifact [-- --out <dir>]
 *
 * Output: <out>/kiiku.html (the page to publish), <out>/assets/… (supporting
 * files), <out>/manifest.json (published path → source, with content types where
 * the publisher cannot infer them) and <out>/index.html (a full document for
 * local previews).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(root, 'dist-artifact'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'artifact', 'config.json'), 'utf8'));

const env = { ...process.env, VITE_BROWSER_MODE: 'true', VITE_BASE: './', VITE_SITE_CONFIG: JSON.stringify(config) };
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const build = spawnSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: root, env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

// The publisher wraps the page in its own doctype/html/head/body, so publish the head and body contents as one fragment.
const document = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const head = document.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = document.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';
const headTags = head
  .split(/\n/)
  .map((line) => line.trim())
  .filter((line) => line && !/^<meta charset/i.test(line) && !/^<meta name="viewport"/i.test(line) && !/^<link rel="icon"/i.test(line))
  .map((line) => line.replace(/<title>.*<\/title>/i, `<title>${config.agentName ?? 'Kiiku'}</title>`));
const title = headTags.find((line) => /^<title>/i.test(line)) ?? `<title>${config.agentName ?? 'Kiiku'}</title>`;
const fragment = [title, ...headTags.filter((line) => line !== title), body.trim()].join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'kiiku.html'), fragment);

// Supporting files: everything under the output directory except the pages and this manifest.
const CONTENT_TYPES = { '.mjs': 'text/javascript', '.map': 'application/json', '.wasm': 'application/wasm' };
const manifest = {};
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = path.relative(outDir, full).split(path.sep).join('/');
    if (['index.html', 'kiiku.html', 'manifest.json', 'config.json', 'favicon.svg', '404.html'].includes(rel)) continue;
    const type = CONTENT_TYPES[path.extname(entry.name)];
    manifest[rel] = type ? { from: rel, contentType: type } : rel;
  }
};
walk(outDir);
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const total = Object.keys(manifest).reduce((sum, rel) => sum + fs.statSync(path.join(outDir, rel)).size, 0);
console.log(`\nArtifact build in ${outDir}: kiiku.html + ${Object.keys(manifest).length} supporting files (${(total / 1024 / 1024).toFixed(1)} MB).`);
