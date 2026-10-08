// Deterministic runtime crawl. Boots nothing itself: point it at a running app.
//
// It discovers pages (seed routes, sitemap.xml, then links), opens each in a
// real browser, pokes the safe interactive bits (tabs, disclosures, menus),
// follows a few links client-side so the router and hydration are exercised,
// probes a missing route, repeats a few pages at phone size, and compares
// screenshots with the last run on the default branch. With a test login it
// signs in and crawls again behind the login; it replays the flows the AI
// explorer recorded on the default branch; and it measures how much of the
// app it reached (routes, controls, forms, JavaScript executed).
//
// Flake control: a page with a blocking finding is opened once more in a
// clean browser context, and findings that do not happen again are reported
// as flaky instead of failing the run. Known problems can be quarantined.
//
// A page is broken if it throws, logs a console error, fails a same-origin
// request, returns >= 400 (or any 5xx), renders blank, or shows a framework
// crash screen. Those findings fail the run. Third-party failures, layout
// overflow and visual changes are reported but never fail it.
import fs from 'node:fs';
import path from 'node:path';
import { devices } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  Collector, buildIgnoreList, contextOptions, dummyFor, ensureDir, env, envBool, envInt, envList,
  launchBrowser, mdEscape, sameOrigin, slugFor, writeJson,
} from './lib.mjs';
import { fromStep, perform, rejectReason } from './actions.mjs';
import { describeStep, readFlows } from './flows.mjs';
import { loginConfig, signIn } from './login.mjs';

const BASE = env('RG_URL', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OUT = path.resolve(env('RG_OUT', 'runtime-gate-report'));
const SCREENS = ensureDir(path.join(OUT, 'screens'));
const DIFFS = path.join(OUT, 'diffs');
const MAX_PAGES = envInt('RG_MAX_PAGES', 40);
const PER_PATTERN = envInt('RG_PER_PATTERN', 3);
const NAV_TIMEOUT = envInt('RG_NAV_TIMEOUT', 30000);
const SETTLE = envInt('RG_SETTLE_MS', 750);
const INTERACT = envBool('RG_INTERACT', true);
const INTERACT_MAX = envInt('RG_INTERACT_MAX', 12);
const FORMS = envBool('RG_FORMS', true);
const FORMS_MAX = envInt('RG_FORMS_MAX', 3);
const MOBILE = envBool('RG_MOBILE', true);
const SCREENSHOTS = envBool('RG_SCREENSHOTS', true);
const BASELINE = env('RG_BASELINE_DIR', '');
const DIFF_THRESHOLD = Number.parseFloat(env('RG_DIFF_THRESHOLD', '0.002'));
const ignores = buildIgnoreList(envList('RG_IGNORE'));
const LOGIN = loginConfig();
const AUTH_MAX_PAGES = envInt('RG_AUTH_MAX_PAGES', 25);
const RETRY = envBool('RG_RETRY', true);
const RETRY_MAX = envInt('RG_RETRY_MAX', 8);
const QUARANTINE = envList('RG_QUARANTINE').map((p) => new RegExp(p, 'i'));
const FLOWS_FILE = env('RG_FLOWS_FILE', '');
const FLOWS_MAX = envInt('RG_FLOWS_MAX', 20);
// auto: a flow that can no longer be performed blocks dependency-update PRs
// (where the UI should not have changed) and only warns on feature PRs (where
// the change may be intended and the flow simply needs re-recording).
const FLOWS_STRICT = (() => {
  const v = env('RG_FLOWS_STRICT', 'auto').toLowerCase();
  if (v === 'true' || v === 'false') return v === 'true';
  return envBool('RG_DEPS_PR', false);
})();
const JS_COVERAGE = envBool('RG_JS_COVERAGE', true);
const excludes = [
  /\/(log-?out|sign-?out)(\/|$)/i,
  /\.(pdf|zip|gz|tar|dmg|exe|mp4|mp3|wav|png|jpe?g|gif|webp|avif|svg|ico|xml|json|txt|csv|ics|rss)$/i,
  ...envList('RG_EXCLUDE').map((p) => new RegExp(p, 'i')),
];
const crashText = [
  'Application error: a client-side exception has occurred',
  'Unhandled Runtime Error',
  'Internal Server Error',
  'This page could not be found. 500',
  ...envList('RG_FAIL_TEXT'),
];

function normalise(href) {
  try {
    const u = new URL(href, `${BASE}/`);
    if (!sameOrigin(u.href, BASE)) return null;
    u.hash = '';
    u.search = '';
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (excludes.some((re) => re.test(p))) return null;
    return `${BASE}${p === '/' ? '/' : p}`;
  } catch {
    return null;
  }
}

// /recipes/tofu and /recipes/dal are one template: visit a few, not hundreds.
function patternOf(url) {
  const segs = new URL(url).pathname.split('/').filter(Boolean);
  if (segs.length <= 1) return url;
  return `/${segs[0]}/*${segs.length}`;
}

async function sitemapUrls(request) {
  const found = [];
  const queue = [`${BASE}/sitemap.xml`];
  const seen = new Set();
  while (queue.length && seen.size < 5) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await request.get(url, { timeout: 10000 });
      if (!res.ok()) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        // Sitemaps carry the production host; map paths onto the app under test.
        let p;
        try { p = new URL(m[1]).pathname; } catch { continue; }
        if (/sitemap.*\.xml$/i.test(p)) queue.push(`${BASE}${p}`);
        else found.push(`${BASE}${p}`);
      }
    } catch { /* no sitemap is fine */ }
  }
  return found;
}

async function settle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* long-polling apps never idle */ }
  await page.waitForTimeout(SETTLE);
}

async function inspect(page, collector, where) {
  const verdict = await page.evaluate((crash) => {
    const body = document.body;
    const text = (body?.innerText || '').trim();
    const media = body ? body.querySelectorAll('img, svg, canvas, video, iframe').length : 0;
    const crashed = crash.find((c) => text.includes(c)) || null;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    return { textLength: text.length, media, crashed, overflow, title: document.title };
  }, crashText);
  if (verdict.textLength === 0 && verdict.media === 0) {
    collector.add('blank-page', 'rendered nothing visible', { page: where });
  }
  if (verdict.crashed) {
    collector.add('crash-screen', `shows "${verdict.crashed}"`, { page: where });
  }
  return verdict;
}

async function shoot(page, name) {
  if (!SCREENSHOTS) return null;
  const file = path.join(SCREENS, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide', timeout: 15000 });
    return path.relative(OUT, file);
  } catch {
    return null;
  }
}

// Words on a control that mean "this changes something real". The crawler
// never presses those; the AI explorer, which understands context, may.
const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|pay|buy|purchase|checkout|check out|order|subscribe|send|submit|publish|reset|clear all|cancel (plan|subscription)|close account)\b/i;

// Presses the page's safe, stateless controls the way a curious visitor
// would: tabs, disclosures, menus, toggles, carousels, "show more" buttons,
// checkboxes, selects, and a search box with a query. Anything that submits a
// form or reads as destructive is skipped. Errors these interactions cause are
// caught by the collector like any other.
async function exercise(page, collector, url, { forms = FORMS, signedIn = false } = {}) {
  const stats = { controls: 0, clicked: 0, formsFound: 0, formsSubmitted: 0 };
  if (INTERACT) {
    const selector = [
      '[role="tab"]:not([aria-selected="true"])',
      'summary',
      'button',
      '[role="button"]',
      '[role="switch"]',
      '[role="menuitem"]',
      'input[type="checkbox"]',
      'input[type="radio"]',
      'select',
      'input[type="search"]',
      '[role="searchbox"]',
    ].join(', ');
    const count = Math.min(await page.locator(selector).count().catch(() => 0), 150);
    const tried = new Set();
    for (let i = 0; i < count; i += 1) {
      const el = page.locator(selector).nth(i);
      try {
        if (!(await el.isVisible()) || !(await el.isEnabled())) continue;
        const info = await el.evaluate((n) => ({
          tag: n.tagName,
          type: (n.getAttribute('type') || '').toLowerCase(),
          role: n.getAttribute('role') || '',
          inForm: !!n.closest('form'),
          label: (n.getAttribute('aria-label') || n.textContent || n.getAttribute('title') || n.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        }));
        const key = `${info.tag}|${info.role}|${info.label}`;
        if (tried.has(key)) continue;
        tried.add(key);
        // Coverage counts every distinct control a person could press,
        // including the ones the crawler deliberately leaves alone.
        stats.controls += 1;
        if (stats.clicked >= INTERACT_MAX) continue;
        if (DESTRUCTIVE.test(info.label)) continue;
        // A <button> inside a form submits it unless it says otherwise.
        if (info.tag === 'BUTTON' && info.inForm && (info.type === '' || info.type === 'submit')) continue;
        if (info.tag === 'INPUT' && info.type === 'submit') continue;
        if (info.tag === 'SELECT') {
          const options = await el.locator('option').count();
          if (options > 1) await el.selectOption({ index: 1 }, { timeout: 3000 });
        } else if (info.type === 'search' || info.role === 'searchbox') {
          await el.fill('test', { timeout: 3000 });
          await el.press('Enter', { timeout: 3000 });
        } else {
          await el.click({ timeout: 3000 });
        }
        stats.clicked += 1;
        await page.waitForTimeout(300);
        await page.keyboard.press('Escape').catch(() => {});
        // Close anything the control opened in a new tab, and come back if it
        // navigated, so the rest of the page still gets its turn.
        for (const other of page.context().pages()) if (other !== page) await other.close().catch(() => {});
        if (normalise(page.url()) !== url) {
          await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(() => {});
          await settle(page);
        }
      } catch { /* a control that cannot be operated is not an app error */ }
    }
  }
  if (forms) Object.assign(stats, await submitForms(page, collector, url, { signedIn }));
  return stats;
}

// Forms whose button says one of these are left alone: they move money,
// message someone, or destroy something. "Submit", "Search", "Sign up",
// "Save" and the like are fair game in a throwaway CI environment.
const FORM_SKIP = /\b(delete|remove|destroy|pay|buy|purchase|checkout|check out|order|unsubscribe|send|publish|reset|deactivate|close account|log ?out|sign ?out|cancel (plan|subscription))\b/i;

// Fills each non-destructive form with dummy data and submits it, the way a
// person trying the app would. Client errors (4xx) caused by the submission
// are expected (validation, a wrong password) and only reported as warnings;
// exceptions, console errors and 5xx responses still fail the crawl.
async function submitForms(page, collector, url, { signedIn = false } = {}) {
  let submitted = 0;
  let found = 0;
  const forms = await page.locator('form').count().catch(() => 0);
  for (let i = 0; i < Math.min(forms, 30); i += 1) {
    const form = page.locator('form').nth(i);
    try {
      if (!(await form.isVisible())) continue;
      found += 1;
      if (submitted >= FORMS_MAX) continue;
      // Signed in, a form with a password field changes the test account's
      // credentials (or signs in as someone else): leave it alone.
      if (signedIn && (await form.locator('input[type="password"]').count())) continue;
      const submit = form.locator('button[type="submit"], button:not([type]), input[type="submit"]').first();
      const label = (await submit.count())
        ? await submit.evaluate((n) => (n.getAttribute('aria-label') || n.value || n.textContent || '').trim())
        : '';
      if (FORM_SKIP.test(label)) continue;
      const fields = await form.locator('input, textarea, select').all();
      for (const el of fields) {
        const f = await el.evaluate((n) => ({
          tag: n.tagName, type: (n.getAttribute('type') || 'text').toLowerCase(), name: n.getAttribute('name') || '',
          label: n.getAttribute('aria-label') || (n.id && document.querySelector(`label[for="${CSS.escape(n.id)}"]`)?.textContent) || '',
          placeholder: n.getAttribute('placeholder') || '', autocomplete: n.getAttribute('autocomplete') || '',
          min: n.getAttribute('min') || '', required: n.required, readOnly: n.readOnly, disabled: n.disabled,
        }));
        if (f.disabled || f.readOnly || !(await el.isVisible())) continue;
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(f.type)) continue;
        if (f.tag === 'SELECT') {
          if ((await el.locator('option').count()) > 1) await el.selectOption({ index: 1 }, { timeout: 2000 });
        } else if (f.type === 'checkbox' || f.type === 'radio') {
          if (f.required) await el.check({ timeout: 2000 });
        } else if (f.tag === 'TEXTAREA') {
          await el.fill('Runtime gate test message', { timeout: 2000 });
        } else {
          await el.fill(dummyFor(f), { timeout: 2000 });
        }
      }
      collector.expectClientErrors = true;
      if (await submit.count()) {
        if (!(await submit.isEnabled())) { collector.expectClientErrors = false; continue; }
        await submit.click({ timeout: 3000 });
      } else {
        await form.evaluate((n) => n.requestSubmit());
      }
      submitted += 1;
      await settle(page);
    } catch { /* a form that cannot be filled is not an app error */ } finally {
      collector.expectClientErrors = false;
    }
    for (const other of page.context().pages()) if (other !== page) await other.close().catch(() => {});
    if (normalise(page.url()) !== url) {
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page);
    }
  }
  return { formsFound: found, formsSubmitted: submitted };
}


// The baseline artifact holds screens/ and crawl.json. Artifacts uploaded
// before coverage existed hold the screenshots at their root.
function baselineScreens() {
  if (!BASELINE || !fs.existsSync(BASELINE)) return '';
  const nested = path.join(BASELINE, 'screens');
  if (fs.existsSync(nested)) return nested;
  return fs.readdirSync(BASELINE).some((f) => f.endsWith('.png')) ? BASELINE : '';
}
const BASE_SCREENS = baselineScreens();

function baselineCoverage() {
  const f = BASELINE ? path.join(BASELINE, 'crawl.json') : '';
  if (!f || !fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).coverage || null; } catch { return null; }
}

function diff(name) {
  if (!BASE_SCREENS) return null;
  const before = path.join(BASE_SCREENS, `${name}.png`);
  const after = path.join(SCREENS, `${name}.png`);
  if (!fs.existsSync(before) || !fs.existsSync(after)) return null;
  const a = PNG.sync.read(fs.readFileSync(before));
  const b = PNG.sync.read(fs.readFileSync(after));
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const crop = (img) => {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height });
    PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
    return out;
  };
  const ca = crop(a);
  const cb = crop(b);
  const d = new PNG({ width, height });
  const changed = pixelmatch(ca.data, cb.data, d.data, width, height, { threshold: 0.1 });
  const ratio = changed / (width * height);
  const resized = a.width !== b.width || a.height !== b.height;
  if (ratio <= DIFF_THRESHOLD && !resized) return null;
  ensureDir(DIFFS);
  fs.writeFileSync(path.join(DIFFS, `${name}.png`), PNG.sync.write(d));
  return { name, ratio, resized, before: [a.width, a.height], after: [b.width, b.height] };
}

// How much of the app's own JavaScript actually ran, from V8 block coverage
// (Chromium only). A drop against the default branch means the crawl reached
// less of the app than before: a route that now redirects, a menu that no
// longer opens, a code-split chunk that no longer loads.
class JsCoverage {
  constructor(enabled) {
    this.enabled = enabled;
    this.scripts = new Map();
  }

  async start(page) {
    if (!this.enabled) return;
    try { await page.coverage.startJSCoverage({ resetOnNavigation: false }); } catch { this.enabled = false; }
  }

  async stop(page) {
    if (!this.enabled) return;
    let entries = [];
    try { entries = await page.coverage.stopJSCoverage(); } catch { return; }
    for (const e of entries) this.add(e);
  }

  add(e) {
    if (!e.url || !e.source || !sameOrigin(e.url, BASE)) return;
    const u = new URL(e.url);
    // Inline <script>s report the page's URL; only count script files.
    if (!/\.(m?js|cjs)$/i.test(u.pathname)) return;
    const key = `${u.pathname}${u.search}`;
    const len = e.source.length;
    const mask = new Uint8Array(len);
    // Ranges are nested and listed outermost first, functions in source
    // order, so painting them in order lets each inner range override its
    // parent: a called function inside an uncalled branch, and vice versa.
    for (const fn of e.functions) {
      for (const r of fn.ranges) mask.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
    }
    const prev = this.scripts.get(key);
    if (prev && prev.length === len) {
      for (let i = 0; i < len; i += 1) if (mask[i]) prev[i] = 1;
    } else {
      this.scripts.set(key, mask);
    }
  }

  summary() {
    if (!this.enabled || !this.scripts.size) return null;
    let bytes = 0;
    let used = 0;
    const per = [];
    for (const [url, mask] of this.scripts) {
      let u = 0;
      for (let i = 0; i < mask.length; i += 1) u += mask[i];
      bytes += mask.length;
      used += u;
      per.push({ url, bytes: mask.length, used: u });
    }
    per.sort((a, b) => (b.bytes - b.used) - (a.bytes - a.used));
    return { scripts: this.scripts.size, bytes, usedBytes: used, percent: bytes ? Math.round((used / bytes) * 1000) / 10 : 0, leastUsed: per.slice(0, 5) };
  }
}

// One pass over the app in one browser context: visit, inspect, screenshot,
// operate controls and forms, follow links.
async function crawlPass({ browser, collector, coverage, retryInfo, seeds, pinned, suffix, shotPrefix, maxPages, signedIn, state, skip }) {
  const opts = contextOptions({ reducedMotion: 'reduce', ...(state ? { storageState: state } : {}) });
  const context = await browser.newContext(opts);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  collector.attach(context);
  const page = await context.newPage();
  const queue = [...seeds];
  const seen = new Set();
  const discovered = new Set(seeds);
  const patterns = new Map();
  const pages = [];
  let duplicates = 0;

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (skip && skip(url)) continue;
    const pat = patternOf(url);
    if ((patterns.get(pat) || 0) >= PER_PATTERN && !pinned.includes(url)) { duplicates += 1; continue; }
    patterns.set(pat, (patterns.get(pat) || 0) + 1);

    const label = `${url}${suffix}`;
    collector.currentPage = label;
    retryInfo.set(label, { url, opts, exercise: true, signedIn });
    const before = collector.findings.length;
    const t0 = Date.now();
    let status = 0;
    await coverage.start(page);
    try {
      const res = await page.goto(url, { waitUntil: 'load' });
      status = res?.status() ?? 0;
    } catch (err) {
      collector.add('navigation-failed', `${url} — ${err.message.split('\n')[0]}`, { page: label });
      await coverage.stop(page);
      pages.push({ url, label, signedIn, status, ms: Date.now() - t0, findings: collector.since(before).length });
      continue;
    }
    const record = { url, label, signedIn, status, finalUrl: '', title: '', ms: 0, controls: 0, clicked: 0, formsFound: 0, formsSubmitted: 0, screenshot: null };
    try {
      await settle(page);
      record.finalUrl = page.url();
      const verdict = await inspect(page, collector, label);
      record.title = verdict.title;
      if (verdict.overflow > 2) {
        collector.add('layout-overflow', `page is ${verdict.overflow}px wider than the viewport`, { page: label, blocking: false });
      }
      record.shotName = `${shotPrefix}desktop-${slugFor(url)}`;
      record.screenshot = await shoot(page, record.shotName);
      Object.assign(record, await exercise(page, collector, url, { signedIn }));
      for (const href of await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
        if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
        const next = normalise(href);
        if (!next) continue;
        discovered.add(next);
        if (!seen.has(next)) queue.push(next);
      }
    } catch (err) {
      // The page navigated away under the crawler, or closed itself. Not an
      // app error in its own right; any real error was collected already.
      collector.add('crawler-note', `could not finish this page: ${err.message.split('\n')[0]}`, { page: label, blocking: false });
    }
    await coverage.stop(page);
    record.ms = Date.now() - t0;
    record.findings = collector.since(before).length;
    pages.push(record);
  }
  for (const u of queue) discovered.add(u);
  return { context, page, pages, discovered, duplicates };
}

// Replays the flows the AI explorer recorded on the default branch. No model
// calls: each step is performed exactly as recorded.
async function runFlow(browser, collector, flow, label, state) {
  const ctx = await browser.newContext(contextOptions({ reducedMotion: 'reduce', ...(flow.signedIn ? { storageState: state } : {}) }));
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  collector.attach(ctx);
  collector.currentPage = label;
  const page = await ctx.newPage();
  try {
    let start = '';
    try { start = new URL(flow.start, `${BASE}/`).href; } catch { /* checked below */ }
    if (!start || !sameOrigin(start, BASE)) return { ok: false, failedAt: 0, step: `open ${flow.start}`, error: 'the start page is not on this application' };
    try {
      await page.goto(start, { waitUntil: 'load' });
      await settle(page);
    } catch (err) {
      return { ok: false, failedAt: 0, step: `open ${flow.start}`, error: err.message.split('\n')[0] };
    }
    for (let i = 0; i < flow.steps.length; i += 1) {
      const step = flow.steps[i];
      const call = fromStep(step);
      const why = rejectReason(call, BASE);
      if (why) return { ok: false, failedAt: i + 1, step: describeStep(step), error: `refused: ${why}` };
      try {
        await perform(page, call, BASE);
      } catch (err) {
        return { ok: false, failedAt: i + 1, step: describeStep(step), error: err.message.split('\n')[0].slice(0, 200) };
      }
      await page.waitForTimeout(300);
      try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch { /* fine */ }
    }
    await inspect(page, collector, label);
    return { ok: true };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function replayFlows(browser, collector, state) {
  if (!FLOWS_FILE || !fs.existsSync(FLOWS_FILE)) return [];
  let flows;
  try {
    flows = readFlows(FLOWS_FILE);
  } catch (err) {
    collector.add('flows-file-invalid', `${FLOWS_FILE}: ${err.message}`, { page: `${BASE}/`, blocking: false });
    return [];
  }
  const results = [];
  for (const flow of flows.slice(0, FLOWS_MAX)) {
    const label = `${BASE}${flow.start} (flow: ${flow.name})`;
    if (flow.signedIn && !state) {
      results.push({ name: flow.name, start: flow.start, steps: flow.steps.length, status: 'skipped', error: LOGIN.enabled ? 'needs sign-in, which failed' : 'needs sign-in, but no login is configured' });
      continue;
    }
    // A second attempt from a clean start absorbs a slow render; a flow that
    // fails twice the same way really cannot be done any more.
    let outcome;
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      outcome = await runFlow(browser, collector, flow, label, state);
      if (outcome.ok) break;
    }
    if (!outcome.ok) {
      collector.add('flow-broken', `step ${outcome.failedAt} of ${flow.steps.length} (${outcome.step}) could not be done: ${outcome.error}`, {
        page: label,
        blocking: FLOWS_STRICT,
      });
    }
    results.push({ name: flow.name, start: flow.start, steps: flow.steps.length, status: outcome.ok ? 'passed' : 'broken', attempts, failedAt: outcome.failedAt, error: outcome.error });
  }
  return results;
}

// A finding that does not happen again on a second, clean visit is flaky:
// still reported, but it does not block the merge. Kept conservative: if the
// retry shows any blocking problem of the same kind, nothing is downgraded.
const fuzzy = (m) => String(m).replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, '#');

async function retryBlocking(browser, collector, retryInfo) {
  const labels = [...new Set(collector.blocking().map((f) => f.page))].filter((l) => retryInfo.has(l));
  const results = [];
  for (const label of labels.slice(0, RETRY_MAX)) {
    const info = retryInfo.get(label);
    const again = new Collector(BASE, ignores);
    let ctx;
    let failed = '';
    try {
      ctx = await browser.newContext(info.opts);
      ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
      again.attach(ctx);
      const page = await ctx.newPage();
      again.currentPage = label;
      await page.goto(info.url, { waitUntil: 'load' });
      await settle(page);
      await inspect(page, again, label);
      if (info.exercise) await exercise(page, again, info.url, { signedIn: info.signedIn });
    } catch (err) {
      failed = err.message.split('\n')[0];
    } finally {
      await ctx?.close().catch(() => {});
    }
    if (failed) { results.push({ page: label, kept: 'all', flaky: 0, note: failed }); continue; }
    const kinds = new Set(again.blocking().map((f) => f.kind));
    const msgs = new Set(again.blocking().map((f) => `${f.kind}|${fuzzy(f.message)}`));
    let kept = 0;
    let flaky = 0;
    for (const f of collector.findings) {
      if (f.page !== label || !f.blocking) continue;
      if (msgs.has(`${f.kind}|${fuzzy(f.message)}`) || kinds.has(f.kind)) { kept += 1; continue; }
      f.blocking = false;
      f.flaky = true;
      flaky += 1;
    }
    results.push({ page: label, kept, flaky });
  }
  return results;
}

async function main() {
  const started = Date.now();
  const browser = await launchBrowser();
  const coverage = new JsCoverage(JS_COVERAGE && browser.browserType().name() === 'chromium');
  const collector = new Collector(BASE, ignores);
  const retryInfo = new Map();

  const routes = envList('RG_ROUTES').map(normalise).filter(Boolean);
  const pinned = [...new Set([normalise('/'), ...routes])];
  const probe = await browser.newContext(contextOptions());
  const fromSitemap = (await sitemapUrls(probe.request)).map(normalise).filter(Boolean);
  await probe.close();

  const anon = await crawlPass({
    browser, collector, coverage, retryInfo, pinned,
    seeds: [...new Set([...pinned, ...fromSitemap])],
    suffix: '', shotPrefix: '', maxPages: MAX_PAGES, signedIn: false,
  });
  const page = anon.page;

  // Client-side navigation: click real links from the home page instead of
  // loading each URL cold, so routing, data fetching and hydration run the way
  // they do for a person.
  collector.currentPage = `${BASE}/ (client-side navigation)`;
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await settle(page);
    const internal = (await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      .filter((h) => h && !/^(mailto:|tel:|javascript:|#|https?:)/i.test(h))
      .filter((h, i, all) => all.indexOf(h) === i)
      .slice(0, 6);
    for (const href of internal) {
      if (!normalise(href)) continue;
      const link = page.locator(`a[href="${href.replace(/"/g, '\\"')}"]`).first();
      if (!(await link.isVisible().catch(() => false))) continue;
      collector.currentPage = `${normalise(href)} (clicked from /)`;
      await link.click({ timeout: 5000 }).catch(() => {});
      await settle(page);
      await inspect(page, collector, collector.currentPage);
      await page.goBack({ waitUntil: 'load' }).catch(() => page.goto(`${BASE}/`));
      await settle(page);
    }
  } catch (err) {
    collector.add('navigation-failed', `client-side navigation pass: ${err.message.split('\n')[0]}`);
  }

  // A missing route must render a not-found page, not crash.
  const missing = `${BASE}/__runtime-gate-missing-${Date.now()}`;
  collector.currentPage = `${BASE}/<missing route>`;
  collector.expectedStatuses.set(missing, 404);
  try {
    const res = await page.goto(missing, { waitUntil: 'load' });
    await settle(page);
    const st = res?.status() ?? 0;
    if (st >= 500) collector.add('http-error-page', `missing route returned ${st} instead of 404`);
    await inspect(page, collector, collector.currentPage);
  } catch (err) {
    collector.add('navigation-failed', `missing route: ${err.message.split('\n')[0]}`);
  }
  await anon.context.close();

  // Phone-sized pass over the first few pages.
  if (MOBILE) {
    const phoneOpts = contextOptions({ ...devices['Pixel 7'], reducedMotion: 'reduce' });
    const phone = await browser.newContext(phoneOpts);
    collector.attach(phone);
    const mp = await phone.newPage();
    for (const p of anon.pages.filter((x) => x.status && x.status < 400).slice(0, 5)) {
      const label = `${p.url} (phone)`;
      collector.currentPage = label;
      retryInfo.set(label, { url: p.url, opts: phoneOpts, exercise: false, signedIn: false });
      try {
        await mp.goto(p.url, { waitUntil: 'load' });
        await settle(mp);
        const v = await inspect(mp, collector, label);
        if (v.overflow > 2) collector.add('layout-overflow', `phone layout is ${v.overflow}px wider than the screen`, { blocking: false });
        p.mobileShotName = `mobile-${slugFor(p.url)}`;
        p.mobileScreenshot = await shoot(mp, p.mobileShotName);
      } catch (err) {
        collector.add('navigation-failed', `${p.url} at phone size — ${err.message.split('\n')[0]}`);
      }
    }
    await phone.close();
  }

  // Signed in: the same crawl again with the test account's session, over the
  // pages a visitor cannot reach (and the home page, which often differs).
  let auth = { status: 'not configured' };
  let state = null;
  let authPass = { pages: [], discovered: new Set(), duplicates: 0 };
  if (LOGIN.enabled) {
    const lctx = await browser.newContext(contextOptions({ reducedMotion: 'reduce' }));
    lctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
    collector.attach(lctx);
    const res = await signIn(lctx, BASE, LOGIN, collector);
    if (res.ok) {
      state = await lctx.storageState();
      auth = { status: 'signed in', user: LOGIN.username, landed: res.landed.replace(BASE, '') || '/' };
    } else {
      auth = { status: 'failed', user: LOGIN.username, reason: res.reason };
      collector.add('login-failed', `could not sign in as ${LOGIN.username}: ${res.reason}`, { page: `${BASE}${LOGIN.path || '/'} (sign-in)` });
    }
    await lctx.close();
    if (state) {
      const anonByUrl = new Map(anon.pages.map((p) => [p.url, p]));
      const authPinned = [...new Set([normalise(res.landed), LOGIN.check ? normalise(LOGIN.check) : null, ...pinned].filter(Boolean))];
      // A public page that rendered fine for a visitor is not crawled twice;
      // pages that redirected (usually to the sign-in page) are.
      const skip = (u) => {
        if (authPinned.includes(u)) return false;
        const a = anonByUrl.get(u);
        return Boolean(a && a.status && a.status < 400 && a.finalUrl && normalise(a.finalUrl) === u);
      };
      authPass = await crawlPass({
        browser, collector, coverage, retryInfo, pinned: authPinned, seeds: authPinned,
        suffix: ' (signed in)', shotPrefix: 'auth-', maxPages: AUTH_MAX_PAGES, signedIn: true, state, skip,
      });
      await authPass.context.close();
    }
  }

  const flows = await replayFlows(browser, collector, state);
  const retries = RETRY ? await retryBlocking(browser, collector, retryInfo) : [];

  // Known problems someone has chosen to live with for now: still shown,
  // never blocking. Each pattern is matched against "kind: message @ page".
  for (const f of collector.findings) {
    if (!f.blocking) continue;
    const text = `${f.kind}: ${f.message} @ ${String(f.page).replace(BASE, '') || '/'}`;
    if (QUARANTINE.some((re) => re.test(text))) { f.blocking = false; f.quarantined = true; }
  }

  await browser.close();

  const pages = [...anon.pages, ...authPass.pages];
  const visual = [];
  const urlByShot = new Map();
  for (const p of pages) {
    if (p.shotName) urlByShot.set(p.shotName, `${p.url.replace(BASE, '') || '/'}${p.signedIn ? ' (signed in)' : ''}`);
    if (p.mobileShotName) urlByShot.set(p.mobileShotName, `${p.url.replace(BASE, '') || '/'} (phone)`);
  }
  if (BASE_SCREENS) {
    for (const f of fs.readdirSync(SCREENS)) {
      const d = diff(f.replace(/\.png$/, ''));
      if (d) visual.push({ ...d, url: urlByShot.get(d.name) || '' });
    }
  }

  const visitedUrls = new Set(pages.map((p) => p.url));
  const discovered = new Set([...anon.discovered, ...authPass.discovered]);
  const sum = (k) => pages.reduce((n, p) => n + (p[k] || 0), 0);
  const cov = {
    routes: {
      discovered: discovered.size,
      visited: visitedUrls.size,
      sameShapeSkipped: anon.duplicates + authPass.duplicates,
      notVisited: [...discovered].filter((u) => !visitedUrls.has(u)).map((u) => u.replace(BASE, '') || '/').slice(0, 15),
    },
    controls: { found: sum('controls'), operated: sum('clicked') },
    forms: { found: sum('formsFound'), submitted: sum('formsSubmitted') },
    js: coverage.summary(),
    signIn: auth,
    flows: {
      total: flows.length,
      passed: flows.filter((f) => f.status === 'passed').length,
      broken: flows.filter((f) => f.status === 'broken').length,
      skipped: flows.filter((f) => f.status === 'skipped').length,
    },
  };
  const base = baselineCoverage();
  const delta = base ? {
    routesVisited: cov.routes.visited - (base.routes?.visited ?? 0),
    controlsOperated: cov.controls.operated - (base.controls?.operated ?? 0),
    jsPercent: cov.js && base.js ? Math.round((cov.js.percent - base.js.percent) * 10) / 10 : null,
  } : null;

  const blocking = collector.blocking();
  const report = {
    tool: 'runtime-gate/crawl',
    url: BASE,
    passed: blocking.length === 0,
    durationMs: Date.now() - started,
    pages,
    findings: collector.findings.map(({ key, ...f }) => f),
    visual,
    baseline: BASE_SCREENS ? 'compared' : 'none',
    coverage: cov,
    coverageDelta: delta,
    flows,
    retries,
    flowsStrict: FLOWS_STRICT,
  };
  writeJson(path.join(OUT, 'crawl.json'), report);
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(OUT, 'crawl.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  process.exitCode = report.passed ? 0 : 1;
}

const signed = (n) => (n > 0 ? `+${n}` : `${n === 0 ? '±' : '−'}${Math.abs(n)}`);

export function renderMarkdown(r) {
  const blocking = r.findings.filter((f) => f.blocking);
  const parked = r.findings.filter((f) => !f.blocking && (f.flaky || f.quarantined));
  const warnings = r.findings.filter((f) => !f.blocking && !f.flaky && !f.quarantined);
  const where = (f) => String(f.page).replace(r.url, '') || '/';
  const lines = [];
  const distinct = new Set(blocking.map((f) => `${f.kind}|${f.message.replace(r.url, '')}`)).size;
  lines.push(`### ${r.passed ? '✅' : '❌'} Runtime crawl: ${r.passed ? 'no runtime errors' : `${distinct} distinct blocking problem(s)`}`);
  lines.push('');
  const signedIn = r.coverage?.signIn?.status === 'signed in';
  lines.push(`${r.pages.length} page(s) opened in a real browser (desktop${r.pages.some((p) => p.mobileScreenshot) ? ' + phone' : ''}${signedIn ? ', signed out and signed in' : ''}), safe controls exercised, forms tried with dummy data, links followed client-side, missing-route probe run${r.flows?.length ? `, ${r.flows.length} recorded flow(s) replayed` : ''}. ${Math.round(r.durationMs / 1000)}s.`);
  lines.push('');
  if (blocking.length) {
    // One row per distinct problem, listing every place it showed up, so a
    // single broken script does not read as ten failures.
    const groups = new Map();
    for (const f of blocking) {
      const msg = f.message.replace(r.url, '');
      const k = `${f.kind}|${msg}`;
      if (!groups.has(k)) groups.set(k, { kind: f.kind, msg, pages: [] });
      groups.get(k).pages.push(where(f));
    }
    lines.push('| Problem | Detail | Seen on |');
    lines.push('|---|---|---|');
    const rows = [...groups.values()];
    for (const g of rows.slice(0, 40)) lines.push(`| ${g.kind} | ${mdEscape(g.msg)} | ${mdEscape(g.pages.slice(0, 4).join(', '))}${g.pages.length > 4 ? ` +${g.pages.length - 4}` : ''} |`);
    if (rows.length > 40) lines.push(`| … | ${rows.length - 40} more in the artifact | |`);
    lines.push('');
  }
  const c = r.coverage;
  if (c) {
    const bits = [
      `${c.routes.visited}/${c.routes.discovered} routes${c.routes.sameShapeSkipped ? ` (+${c.routes.sameShapeSkipped} of an already-visited shape)` : ''}`,
      `${c.controls.operated}/${c.controls.found} controls operated`,
      `${c.forms.submitted}/${c.forms.found} forms submitted`,
    ];
    if (c.js) bits.push(`${c.js.percent}% of the app's own JavaScript executed`);
    if (c.signIn.status === 'signed in') bits.push(`signed in as ${mdEscape(c.signIn.user)}`);
    else if (c.signIn.status === 'failed') bits.push('sign-in failed');
    if (c.flows.total) bits.push(`flows ${c.flows.passed}/${c.flows.total} passed${c.flows.skipped ? `, ${c.flows.skipped} skipped` : ''}`);
    lines.push(`**Coverage:** ${bits.join(' · ')}`);
    const d = r.coverageDelta;
    if (d) {
      const parts = [`routes ${signed(d.routesVisited)}`, `controls ${signed(d.controlsOperated)}`];
      if (d.jsPercent !== null) parts.push(`JS ${signed(d.jsPercent)} pts`);
      const drop = d.routesVisited < 0 || (d.jsPercent !== null && d.jsPercent <= -5);
      lines.push('');
      lines.push(`${drop ? '⚠️ ' : ''}Against the default branch: ${parts.join(', ')}${drop ? ' — the crawl reached less of the app than before; check for routes that now redirect or controls that stopped working.' : '.'}`);
    }
    if (c.routes.notVisited.length) {
      lines.push('');
      lines.push(`<details><summary>Routes found but not visited (${c.routes.discovered - c.routes.visited})</summary>\n\n${c.routes.notVisited.map((u) => `\`${mdEscape(u)}\``).join(', ')}${c.routes.discovered - c.routes.visited > c.routes.notVisited.length ? ', …' : ''}. Raise \`max-pages\` or list them in \`routes\`.\n\n</details>`);
    }
    lines.push('');
  }
  if (r.flows?.length) {
    lines.push(`<details${r.flows.some((f) => f.status === 'broken') ? ' open' : ''}><summary>Recorded flows (${r.flowsStrict ? 'blocking' : 'advisory'} on this PR)</summary>`);
    lines.push('');
    lines.push('| Flow | Steps | Result |');
    lines.push('|---|---|---|');
    for (const f of r.flows) {
      const result = f.status === 'passed' ? `✅ passed${f.attempts > 1 ? ' on the second try' : ''}` : f.status === 'skipped' ? `⏭️ ${mdEscape(f.error)}` : `❌ broke at step ${f.failedAt}: ${mdEscape(f.error)}`;
      lines.push(`| ${mdEscape(f.name)} | ${f.steps} | ${result} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (parked.length) {
    lines.push(`<details><summary>Flaky or quarantined (shown, not blocking): ${parked.length}</summary>`);
    lines.push('');
    for (const f of parked.slice(0, 40)) lines.push(`- ${f.flaky ? '🎲 did not happen again on a clean retry' : '🧊 quarantined'} — **${f.kind}** on \`${mdEscape(where(f))}\`: ${mdEscape(f.message)}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (warnings.length) {
    lines.push(`<details><summary>Warnings (do not fail the check): ${warnings.length}</summary>`);
    lines.push('');
    for (const f of warnings.slice(0, 40)) lines.push(`- **${f.kind}** on \`${mdEscape(where(f))}\`: ${mdEscape(f.message)}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (r.baseline === 'compared') {
    if (r.visual.length) {
      lines.push(`**Visual changes vs the default branch** (advisory, ${r.visual.length}):`);
      for (const v of r.visual.slice(0, 20)) {
        lines.push(`- \`${v.url || v.name}\`: ${(v.ratio * 100).toFixed(1)}% of pixels differ${v.resized ? `, size ${v.before.join('×')} → ${v.after.join('×')}` : ''}`);
      }
      lines.push('');
    } else {
      lines.push('No visual changes against the last default-branch run.');
      lines.push('');
    }
  }
  lines.push('<details><summary>Pages visited</summary>');
  lines.push('');
  lines.push('| Page | Status | ms | Controls operated | Forms submitted | Problems |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of r.pages) lines.push(`| ${mdEscape((p.label || p.url).replace(r.url, '') || '/')} | ${p.status} | ${p.ms} | ${p.clicked ?? 0}/${p.controls ?? 0} | ${p.formsSubmitted ?? 0}/${p.formsFound ?? 0} | ${p.findings} |`);
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Exit explicitly: an exception that leaves the browser open must not hang
  // the job until its timeout.
  main().then(() => process.exit(process.exitCode ?? 0), (err) => {
    console.error(err);
    process.exit(2);
  });
}
