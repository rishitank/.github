// Self-test: the crawler must pass a healthy site and catch every kind of
// breakage in the broken one; the explorer harness must run end to end
// without an API key (fake model) and skip cleanly when no key is given.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const servers = [];

function serve(dir, port) {
  const p = spawn(process.execPath, [path.join(root, 'src/static-server.mjs'), path.join(here, 'fixtures', dir), String(port)], { stdio: 'ignore' });
  servers.push(p);
}

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(url)).status) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not start`);
}

function run(script, env) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  const res = spawnSync(process.execPath, [path.join(root, 'src', script)], {
    env: { ...process.env, RG_OUT: out, RG_MOBILE: 'false', RG_SETTLE_MS: '200', ...env },
    encoding: 'utf8',
    timeout: 180000,
  });
  return { ...res, out };
}

before(async () => {
  serve('good', 4711);
  serve('broken', 4712);
  await waitFor('http://127.0.0.1:4711/');
  await waitFor('http://127.0.0.1:4712/');
});

after(() => { for (const p of servers) p.kill(); });

test('healthy site passes', () => {
  const r = run('crawl.mjs', { RG_URL: 'http://127.0.0.1:4711' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  assert.equal(report.passed, true);
  const urls = report.pages.map((p) => p.url);
  assert.ok(urls.includes('http://127.0.0.1:4711/hidden-from-nav'), 'pages listed only in sitemap.xml are visited');
  assert.ok(!urls.some((u) => u.includes('example.invalid')), 'external links are not followed');
  assert.ok(report.pages.filter((p) => p.url.includes('/items/')).length <= 3, 'at most 3 pages per URL shape');
  const home = report.pages.find((p) => p.url === 'http://127.0.0.1:4711/');
  assert.ok(home.clicked >= 5, `plain buttons, select, search and disclosures are exercised (clicked ${home.clicked})`);
  assert.ok(!report.findings.some((f) => /destructive control was pressed/.test(f.message)), 'controls that read as destructive are never pressed');
});

test('broken site fails with every kind of breakage', () => {
  const r = run('crawl.mjs', { RG_URL: 'http://127.0.0.1:4712', RG_ROUTES: '/items/3', RG_PER_PATTERN: '5' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  const kinds = new Set(report.findings.filter((f) => f.blocking).map((f) => f.kind));
  for (const k of ['uncaught-exception', 'console-error', 'http-error-resource', 'blank-page', 'crash-screen']) {
    assert.ok(kinds.has(k), `expected a ${k} finding, got ${[...kinds].join(', ')}`);
  }
  assert.ok(report.findings.some((f) => /menu exploded/.test(f.message)), 'errors thrown by clicking a control are caught');
  assert.ok(report.findings.some((f) => /undefinedFunctionCall/.test(f.message)), 'errors thrown by a plain button are caught');
  assert.ok(report.findings.some((f) => /null/.test(f.message) && f.kind === 'uncaught-exception'), 'errors thrown by searching are caught');
});

test('ignore list tolerates a known console message', () => {
  const r = run('crawl.mjs', { RG_URL: 'http://127.0.0.1:4712', RG_IGNORE: 'Failed prop type', RG_INTERACT: 'false' });
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  assert.ok(!report.findings.some((f) => /Failed prop type/.test(f.message)));
});

test('explorer harness runs with the fake model and records runtime errors as evidence', () => {
  const r = run('explore.mjs', { RG_URL: 'http://127.0.0.1:4712', RG_EXPLORE_MODEL: 'fake', RG_EXPLORE_RPM: '600' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'explore.json'), 'utf8'));
  assert.equal(report.stopReason, 'explorer finished');
  assert.ok(report.issues.length >= 1);
  assert.ok(report.steps.length >= 3);
  assert.ok(fs.existsSync(path.join(r.out, 'explore', 'step-01.jpg')));
});

test('explorer skips cleanly without an API key', () => {
  const r = run('explore.mjs', { RG_URL: 'http://127.0.0.1:4711', GEMINI_API_KEY: '' });
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(r.out, 'explore.md'), 'utf8'), /skipped/);
});
