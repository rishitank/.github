// Shared plumbing for the crawler and the explorer: config from the
// environment, browser launch, and the error collector that decides whether a
// page is broken. Kept dependency-free apart from Playwright so it is easy to
// read in one sitting.
import { chromium, firefox, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(name, fallback) {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function envBool(name, fallback) {
  const v = env(name, '').toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export function envList(name) {
  return env(name, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Console noise that is never the app's fault. Anything else a repo needs to
// tolerate goes in its own ignore list, where a reviewer can see it.
const BUILTIN_IGNORES = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /\[HMR\]/i,
  // Chrome reports blocked third-party cookies and the like as issues, not
  // errors in the app.
  /third-party cookie/i,
];

// Production React builds report hydration failures as minified errors that
// reach window.reportError (and so Playwright's pageerror) or console.error.
const HYDRATION = /Minified React error #(418|419|423|425)|Hydration failed|hydrat(ion|ing) (error|mismatch)|did not match\. Server:|Text content does not match server-rendered HTML/i;

export function buildIgnoreList(extra) {
  return [...BUILTIN_IGNORES, ...extra.map((p) => new RegExp(p, 'i'))];
}

export async function launchBrowser() {
  const name = env('RG_BROWSER', 'chromium');
  const headed = envBool('RG_HEADED', false);
  const executablePath = env('RG_CHROMIUM_PATH', '') || undefined;
  const opts = { headless: !headed };
  if (name === 'firefox') return firefox.launch(opts);
  if (name === 'webkit') return webkit.launch(opts);
  if (name === 'chrome') return chromium.launch({ ...opts, channel: 'chrome' });
  // 'chromium' channel = the full browser in new headless mode, not the
  // stripped-down headless shell Playwright uses by default. Same engine and
  // code paths as a person's Chrome.
  if (executablePath) return chromium.launch({ ...opts, executablePath });
  return chromium.launch({ ...opts, channel: 'chromium' });
}

export function contextOptions(extra = {}) {
  const user = env('RG_HTTP_USER', '');
  const opts = {
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    ...extra,
  };
  if (user) opts.httpCredentials = { username: user, password: env('RG_HTTP_PASSWORD', '') };
  return opts;
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// Collects everything that went wrong in a browser context. Each finding is
// tagged with the page it happened on and whether it should block a merge.
export class Collector {
  constructor(baseUrl, ignores) {
    this.baseUrl = baseUrl;
    this.ignores = ignores;
    this.findings = [];
    this.currentPage = '';
    this.expectedStatuses = new Map(); // url -> status the crawler expects (e.g. a deliberate 404 probe)
    // When true, findings are attributed to the URL the page is on at the
    // moment of the error (the explorer), rather than to a label the caller
    // set (the crawler, which adds "(phone)" and similar).
    this.live = false;
    // Set while the crawler (or the sign-in) submits a form with dummy data.
    // Only the requests that submission sends are recorded as its own, and a
    // 4xx answering one of those is expected (validation, a wrong password).
    // Unrelated requests in the same window (polling, analytics, lazy
    // chunks) are judged as usual.
    this.submission = null;
    this.submissionRequests = new WeakSet();
  }

  // Marks the start of a form submission on `page`. `action` is the form's
  // resolved action URL (if any); `values` are the dummy values typed into it.
  beginSubmission(page, { action = '', values = [] } = {}) {
    let actionPath = '';
    try { actionPath = action ? new URL(action).pathname : ''; } catch { /* no usable action */ }
    this.submission = { page, actionPath, values: values.filter((v) => typeof v === 'string' && v.length >= 3) };
  }

  endSubmission() {
    this.submission = null;
  }

  // A request belongs to the submission in progress when it is the
  // navigation the submission caused, a non-GET fetch/XHR (a form handler
  // posting its data), or a fetch/XHR to the form's action or carrying a value
  // that was typed into the form. Ownership is recorded on the request itself,
  // so a response that arrives after the crawler has moved on is still judged
  // as an answer to the form.
  ownsRequest(req) {
    const sub = this.submission;
    if (!sub || !sameOrigin(req.url(), this.baseUrl)) return false;
    try { if (req.frame().page() !== sub.page) return false; } catch { return false; }
    const type = req.resourceType();
    if (type === 'document') return req.isNavigationRequest() && req.frame() === sub.page.mainFrame();
    if (type !== 'fetch' && type !== 'xhr') return false;
    if (req.method() !== 'GET') return true;
    let u;
    try { u = new URL(req.url()); } catch { return false; }
    if (sub.actionPath && u.pathname === sub.actionPath) return true;
    let query = u.search;
    try { query = decodeURIComponent(u.search.replace(/\+/g, ' ')); } catch { /* keep it encoded */ }
    return sub.values.some((v) => query.includes(v));
  }

  answersSubmission(req) {
    for (let r = req; r; r = r.redirectedFrom()) if (this.submissionRequests.has(r)) return true;
    return false;
  }

  ignored(text) {
    return this.ignores.some((re) => re.test(text));
  }

  add(kind, message, extra = {}) {
    const blocking = extra.blocking ?? true;
    const where = extra.page || this.currentPage;
    const key = `${kind}|${where}|${message}`;
    if (this.findings.some((f) => f.key === key)) return;
    this.findings.push({ key, kind, message: String(message).slice(0, 2000), page: where, blocking, ...extra });
  }

  attach(context) {
    context.on('page', (page) => this.attachPage(page));
    for (const page of context.pages()) this.attachPage(page);
  }

  attachPage(page) {
    const at = () => (this.live ? { page: page.url() } : {});
    page.on('request', (req) => {
      if (this.ownsRequest(req)) this.submissionRequests.add(req);
    });
    page.on('pageerror', (err) => {
      const text = `${err.name || 'Error'}: ${err.message}`;
      if (this.ignored(text)) return;
      this.add(HYDRATION.test(text) ? 'hydration' : 'uncaught-exception', text, {
        stack: (err.stack || '').split('\n').slice(0, 6).join('\n'),
        ...at(),
      });
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (this.ignored(text)) return;
      const loc = msg.location()?.url || '';
      // "Failed to load resource" duplicates the response handler below,
      // which knows the status and origin; let that one decide.
      if (/^Failed to load resource/i.test(text)) return;
      this.add(HYDRATION.test(text) ? 'hydration' : 'console-error', text, {
        blocking: !loc || sameOrigin(loc, this.baseUrl) || !/^https?:/.test(loc),
        source: loc,
        ...at(),
      });
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText || 'failed';
      // Navigations the page itself cancelled (a click that moved on) are normal.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
      const url = req.url();
      if (this.ignored(url)) return;
      const own = sameOrigin(url, this.baseUrl);
      this.add('request-failed', `${req.method()} ${url} — ${failure}`, { blocking: own, url, ...at() });
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status < 400) return;
      const url = res.url();
      if (this.ignored(url)) return;
      const expected = this.expectedStatuses.get(url);
      if (expected === status) return;
      const own = sameOrigin(url, this.baseUrl);
      const isDoc = res.request().resourceType() === 'document';
      // A 4xx answering a form the crawler just submitted with dummy data is
      // the app doing its job (validation, wrong password): report, don't fail.
      const duringForm = status < 500 && this.answersSubmission(res.request());
      this.add(isDoc ? 'http-error-page' : 'http-error-resource', `${status} ${res.request().method()} ${url}${duringForm ? ' (after submitting a form with dummy data)' : ''}`, {
        blocking: own && !duringForm,
        url,
        status,
        ...at(),
      });
    });
  }

  since(index) {
    return this.findings.slice(index);
  }

  blocking() {
    return this.findings.filter((f) => f.blocking);
  }
}

// Plausible dummy input for a form field, from its type and label.
export function dummyFor(f) {
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

export function slugFor(url) {
  const u = new URL(url);
  const p = (u.pathname + (u.search ? `_${u.search.slice(1)}` : '')).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (p || 'root').slice(0, 120);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
}
