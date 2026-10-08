// Deterministic runtime crawl. Boots nothing itself: point it at a running app.
//
// It discovers pages (seed routes, sitemap.xml, then links), opens each in a
// real browser, pokes the safe interactive bits (tabs, disclosures, menus),
// follows a few links client-side so the router and hydration are exercised,
// probes a missing route, repeats a few pages at phone size, and compares
// screenshots with the last run on the default branch.
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
  Collector, buildIgnoreList, contextOptions, ensureDir, env, envBool, envInt, envList,
  launchBrowser, mdEscape, sameOrigin, slugFor, writeJson,
} from './lib.mjs';

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

async function inspect(page, collector, url, label) {
  const verdict = await page.evaluate((crash) => {
    const body = document.body;
    const text = (body?.innerText || '').trim();
    const media = body ? body.querySelectorAll('img, svg, canvas, video, iframe').length : 0;
    const crashed = crash.find((c) => text.includes(c)) || null;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    return { textLength: text.length, media, crashed, overflow, title: document.title };
  }, crashText);
  if (verdict.textLength === 0 && verdict.media === 0) {
    collector.add('blank-page', 'rendered nothing visible', { page: url });
  }
  if (verdict.crashed) {
    collector.add('crash-screen', `shows "${verdict.crashed}"`, { page: url });
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
async function exercise(page, collector, url) {
  if (!INTERACT) return 0;
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
  const count = await page.locator(selector).count().catch(() => 0);
  const tried = new Set();
  let clicked = 0;
  for (let i = 0; i < count && clicked < INTERACT_MAX; i += 1) {
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
      clicked += 1;
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
  return clicked + (FORMS ? await submitForms(page, collector, url) : 0);
}

// Forms whose button says one of these are left alone: they move money,
// message someone, or destroy something. "Submit", "Search", "Sign up",
// "Save" and the like are fair game in a throwaway CI environment.
const FORM_SKIP = /\b(delete|remove|destroy|pay|buy|purchase|checkout|check out|order|unsubscribe|send|publish|reset|deactivate|close account|log ?out|sign ?out|cancel (plan|subscription))\b/i;

function dummyFor(f) {
  const hint = `${f.name} ${f.label} ${f.placeholder} ${f.autocomplete}`.toLowerCase();
  switch (f.type) {
    case 'email': return 'ci@example.com';
    case 'password': return 'CI-only-password-123!';
    case 'tel': return '07700900123';
    case 'url': return 'https://example.com';
    case 'number': case 'range': return f.min || '1';
    case 'date': return '2026-01-15';
    case 'datetime-local': return '2026-01-15T10:30';
    case 'time': return '10:30';
    case 'month': return '2026-01';
    case 'week': return '2026-W03';
    case 'color': return '#336699';
    default:
      if (/e-?mail/.test(hint)) return 'ci@example.com';
      if (/post ?code|postcode|zip/.test(hint)) return 'SW1A 1AA';
      if (/phone|mobile|tel/.test(hint)) return '07700900123';
      if (/name/.test(hint)) return 'Test User';
      if (/url|website|link/.test(hint)) return 'https://example.com';
      if (/year/.test(hint)) return '2026';
      return 'test';
  }
}

// Fills each non-destructive form with dummy data and submits it, the way a
// person trying the app would. Client errors (4xx) caused by the submission
// are expected (validation, a wrong password) and only reported as warnings;
// exceptions, console errors and 5xx responses still fail the crawl.
async function submitForms(page, collector, url) {
  let submitted = 0;
  const forms = await page.locator('form').count().catch(() => 0);
  for (let i = 0; i < forms && submitted < FORMS_MAX; i += 1) {
    const form = page.locator('form').nth(i);
    try {
      if (!(await form.isVisible())) continue;
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
  return submitted;
}

function diff(name) {
  if (!BASELINE) return null;
  const before = path.join(BASELINE, 'screens', `${name}.png`);
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

async function main() {
  const started = Date.now();
  const browser = await launchBrowser();
  const context = await browser.newContext(contextOptions({ reducedMotion: 'reduce' }));
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const collector = new Collector(BASE, ignores);
  collector.attach(context);
  const page = await context.newPage();

  const seeds = ['/', ...envList('RG_ROUTES')].map(normalise).filter(Boolean);
  const fromSitemap = (await sitemapUrls(context.request)).map(normalise).filter(Boolean);
  const queue = [...new Set([...seeds, ...fromSitemap])];
  const seen = new Set();
  const patterns = new Map();
  const pages = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const pat = patternOf(url);
    if ((patterns.get(pat) || 0) >= PER_PATTERN && !seeds.includes(url)) continue;
    patterns.set(pat, (patterns.get(pat) || 0) + 1);

    collector.currentPage = url;
    const before = collector.findings.length;
    const t0 = Date.now();
    let status = 0;
    try {
      const res = await page.goto(url, { waitUntil: 'load' });
      status = res?.status() ?? 0;
    } catch (err) {
      collector.add('navigation-failed', `${url} — ${err.message.split('\n')[0]}`, { page: url });
      pages.push({ url, status, ms: Date.now() - t0, findings: collector.since(before).length });
      continue;
    }
    await settle(page);
    const verdict = await inspect(page, collector, url, url.replace(BASE, '') || '/');
    if (verdict.overflow > 2) {
      collector.add('layout-overflow', `page is ${verdict.overflow}px wider than the viewport`, { page: url, blocking: false });
    }
    const name = `desktop-${slugFor(url)}`;
    const shot = await shoot(page, name);
    const clicked = await exercise(page, collector, url);

    for (const href of await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
      const next = normalise(href);
      if (next && !seen.has(next)) queue.push(next);
    }
    pages.push({ url, status, title: verdict.title, ms: Date.now() - t0, clicked, screenshot: shot, findings: collector.since(before).length });
  }

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
      await inspect(page, collector, collector.currentPage, `${href} after a client-side click`);
      await page.goBack({ waitUntil: 'load' }).catch(() => page.goto(`${BASE}/`));
      await settle(page);
    }
  } catch (err) {
    collector.add('navigation-failed', `client-side navigation pass: ${err.message.split('\n')[0]}`);
  }

  // A missing route must render a not-found page, not crash.
  const probe = `${BASE}/__runtime-gate-missing-${Date.now()}`;
  collector.currentPage = `${BASE}/<missing route>`;
  collector.expectedStatuses.set(probe, 404);
  try {
    const res = await page.goto(probe, { waitUntil: 'load' });
    await settle(page);
    const st = res?.status() ?? 0;
    if (st >= 500) collector.add('http-error-page', `missing route returned ${st} instead of 404`);
    await inspect(page, collector, collector.currentPage, 'the not-found page');
  } catch (err) {
    collector.add('navigation-failed', `missing route: ${err.message.split('\n')[0]}`);
  }

  // Phone-sized pass over the first few pages.
  if (MOBILE) {
    const phone = await browser.newContext(contextOptions({ ...devices['Pixel 7'], reducedMotion: 'reduce' }));
    collector.attach(phone);
    const mp = await phone.newPage();
    for (const p of pages.filter((x) => x.status && x.status < 400).slice(0, 5)) {
      collector.currentPage = `${p.url} (phone)`;
      try {
        await mp.goto(p.url, { waitUntil: 'load' });
        await settle(mp);
        const v = await inspect(mp, collector, collector.currentPage, `${p.url.replace(BASE, '') || '/'} at phone size`);
        if (v.overflow > 2) collector.add('layout-overflow', `phone layout is ${v.overflow}px wider than the screen`, { blocking: false });
        p.mobileScreenshot = await shoot(mp, `mobile-${slugFor(p.url)}`);
      } catch (err) {
        collector.add('navigation-failed', `${p.url} at phone size — ${err.message.split('\n')[0]}`);
      }
    }
    await phone.close();
  }

  await browser.close();

  const visual = [];
  const urlByShot = new Map();
  for (const p of pages) {
    urlByShot.set(`desktop-${slugFor(p.url)}`, p.url.replace(BASE, '') || '/');
    urlByShot.set(`mobile-${slugFor(p.url)}`, p.url.replace(BASE, '') || '/');
  }
  if (BASELINE && fs.existsSync(path.join(BASELINE, 'screens'))) {
    for (const f of fs.readdirSync(SCREENS)) {
      const d = diff(f.replace(/\.png$/, ''));
      if (d) visual.push({ ...d, url: urlByShot.get(d.name) || '' });
    }
  }

  const blocking = collector.blocking();
  const report = {
    tool: 'runtime-gate/crawl',
    url: BASE,
    passed: blocking.length === 0,
    durationMs: Date.now() - started,
    pages,
    findings: collector.findings.map(({ key, ...f }) => f),
    visual,
    baseline: BASELINE && fs.existsSync(path.join(BASELINE, 'screens')) ? 'compared' : 'none',
  };
  writeJson(path.join(OUT, 'crawl.json'), report);
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(OUT, 'crawl.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  process.exitCode = report.passed ? 0 : 1;
}

export function renderMarkdown(r) {
  const blocking = r.findings.filter((f) => f.blocking);
  const warnings = r.findings.filter((f) => !f.blocking);
  const lines = [];
  const distinct = new Set(blocking.map((f) => `${f.kind}|${f.message.replace(r.url, '')}`)).size;
  lines.push(`### ${r.passed ? '✅' : '❌'} Runtime crawl: ${r.passed ? 'no runtime errors' : `${distinct} distinct blocking problem(s)`}`);
  lines.push('');
  lines.push(`${r.pages.length} page(s) opened in a real browser (desktop${r.pages.some((p) => p.mobileScreenshot) ? ' + phone' : ''}), safe controls exercised, links followed client-side, missing-route probe run. ${Math.round(r.durationMs / 1000)}s.`);
  lines.push('');
  if (blocking.length) {
    // One row per distinct problem, listing every place it showed up, so a
    // single broken script does not read as ten failures.
    const groups = new Map();
    for (const f of blocking) {
      const msg = f.message.replace(r.url, '');
      const k = `${f.kind}|${msg}`;
      if (!groups.has(k)) groups.set(k, { kind: f.kind, msg, pages: [] });
      groups.get(k).pages.push(f.page.replace(r.url, '') || '/');
    }
    lines.push('| Problem | Detail | Seen on |');
    lines.push('|---|---|---|');
    const rows = [...groups.values()];
    for (const g of rows.slice(0, 40)) lines.push(`| ${g.kind} | ${mdEscape(g.msg)} | ${mdEscape(g.pages.slice(0, 4).join(', '))}${g.pages.length > 4 ? ` +${g.pages.length - 4}` : ''} |`);
    if (rows.length > 40) lines.push(`| … | ${rows.length - 40} more in the artifact | |`);
    lines.push('');
  }
  if (warnings.length) {
    lines.push('<details><summary>Warnings (do not fail the check): ' + warnings.length + '</summary>');
    lines.push('');
    for (const f of warnings.slice(0, 40)) lines.push(`- **${f.kind}** on \`${mdEscape(f.page.replace(r.url, '') || '/')}\`: ${mdEscape(f.message)}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (r.baseline === 'compared') {
    if (r.visual.length) {
      lines.push(`**Visual changes vs the default branch** (advisory, ${r.visual.length}):`);
      for (const v of r.visual.slice(0, 20)) {
        lines.push(`- \`${v.name}\`: ${(v.ratio * 100).toFixed(1)}% of pixels differ${v.resized ? `, size ${v.before.join('×')} → ${v.after.join('×')}` : ''}`);
      }
      lines.push('');
    } else {
      lines.push('No visual changes against the last default-branch run.');
      lines.push('');
    }
  }
  lines.push('<details><summary>Pages visited</summary>');
  lines.push('');
  lines.push('| Page | Status | ms | Controls clicked | Problems |');
  lines.push('|---|---|---|---|---|');
  for (const p of r.pages) lines.push(`| ${mdEscape(p.url.replace(r.url, '') || '/')} | ${p.status} | ${p.ms} | ${p.clicked ?? 0} | ${p.findings} |`);
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
