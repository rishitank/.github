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
let GOOD = '';
let BROKEN = '';

// Starts the static server on a free port (port 0) and resolves with its base
// URL once it is listening, so a test can never reach some other process that
// happens to hold a fixed port. Fails fast if the server exits first.
function serve(dir) {
  const p = spawn(process.execPath, [path.join(root, 'src/static-server.mjs'), path.join(here, 'fixtures', dir), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(p);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`static server for ${dir} did not start: ${out}`)), 10000);
    p.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/ on :(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`static server for ${dir} exited (${code}) before listening: ${out}`)); });
  });
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
  [GOOD, BROKEN] = await Promise.all([serve('good'), serve('broken')]);
});

after(() => { for (const p of servers) p.kill(); });

test('healthy site passes', () => {
  const r = run('crawl.mjs', { RG_URL: GOOD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  assert.equal(report.passed, true);
  const urls = report.pages.map((p) => p.url);
  assert.ok(urls.includes(`${GOOD}/hidden-from-nav`), 'pages listed only in sitemap.xml are visited');
  assert.ok(!urls.some((u) => u.includes('example.invalid')), 'external links are not followed');
  assert.ok(report.pages.filter((p) => p.url.includes('/items/')).length <= 3, 'at most 3 pages per URL shape');
  const home = report.pages.find((p) => p.url === `${GOOD}/`);
  assert.ok(home.clicked >= 5, `plain buttons, select, search and disclosures are exercised (clicked ${home.clicked})`);
  assert.ok(!report.findings.some((f) => /destructive control was pressed/.test(f.message)), 'controls that read as destructive are never pressed');
  assert.ok(!report.findings.some((f) => /a Send form was submitted/.test(f.message)), 'forms that send messages are never submitted');
  assert.ok(report.findings.some((f) => !f.blocking && /404 POST .*\/api\/login .*after submitting a form/.test(f.message)), 'a 4xx answering a dummy sign-in is a warning, not a failure');
});

test('broken site fails with every kind of breakage', () => {
  const r = run('crawl.mjs', { RG_URL: BROKEN, RG_ROUTES: '/items/3\n/signin', RG_PER_PATTERN: '5' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  const kinds = new Set(report.findings.filter((f) => f.blocking).map((f) => f.kind));
  for (const k of ['uncaught-exception', 'console-error', 'http-error-resource', 'blank-page', 'crash-screen']) {
    assert.ok(kinds.has(k), `expected a ${k} finding, got ${[...kinds].join(', ')}`);
  }
  assert.ok(report.findings.some((f) => /menu exploded/.test(f.message)), 'errors thrown by clicking a control are caught');
  assert.ok(report.findings.some((f) => /undefinedFunctionCall/.test(f.message)), 'errors thrown by a plain button are caught');
  assert.ok(report.findings.some((f) => /null/.test(f.message) && f.kind === 'uncaught-exception'), 'errors thrown by searching are caught');
  assert.ok(report.findings.some((f) => f.blocking && f.page.includes('/contact') && /results|undefined/.test(f.message)), 'a form whose submission crashes the page is caught (filled with dummy data, disabled submit enabled by typing)');
  // On /signin the form's own POST answers 404 (expected: a warning), while
  // the page's unrelated poll answers 404 in the same window (still blocking).
  assert.ok(report.findings.some((f) => !f.blocking && /404 POST .*\/api\/session .*after submitting a form/.test(f.message)), 'a 4xx answering the submitted form is a warning');
  assert.ok(report.findings.some((f) => f.blocking && /404 GET .*\/api\/notifications/.test(f.message) && !/after submitting/.test(f.message)), 'an unrelated 4xx during a form submission still blocks');
});

test('ignore list tolerates a known console message and nothing else', () => {
  const r = run('crawl.mjs', { RG_URL: BROKEN, RG_IGNORE: 'Failed prop type', RG_RETRY: 'false' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'crawl.json'), 'utf8'));
  assert.ok(report.pages.some((p) => p.url === `${BROKEN}/hidden-from-nav`), 'the page that logs the ignored message was visited');
  assert.ok(!report.findings.some((f) => /Failed prop type/.test(f.message)), 'the ignored message is not reported');
  assert.ok(report.findings.some((f) => f.blocking && /menu exploded/.test(f.message)), 'other errors are still reported and blocking');
});

test('explorer harness runs with the fake model and records runtime errors as evidence', () => {
  const r = run('explore.mjs', { RG_URL: BROKEN, RG_EXPLORE_MODEL: 'fake', RG_EXPLORE_RPM: '600' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(r.out, 'explore.json'), 'utf8'));
  assert.equal(report.stopReason, 'explorer finished');
  assert.ok(report.issues.length >= 1);
  assert.ok(report.steps.length >= 3);
  assert.ok(fs.existsSync(path.join(r.out, 'explore', 'step-01.jpg')));
});

test('explorer skips cleanly without an API key', () => {
  const r = run('explore.mjs', { RG_URL: GOOD, GEMINI_API_KEY: '' });
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(r.out, 'explore.md'), 'utf8'), /skipped/);
});
