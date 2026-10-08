// Signing in, so the crawler and the explorer can reach the pages behind a
// login, which is usually where most of an app lives.
//
// Credentials are CI-only dummies: the app under test runs against a throwaway
// database that the workflow's `migrate` step seeds, or the crawler registers
// the account itself through the sign-up page first. Never real accounts.
//
// Three ways, in order of preference:
//   1. login-script: a module in the repo that signs in however the app needs
//      (OAuth stubs, magic links read from a test mailbox, multi-step forms).
//   2. A sign-in form at login-path: the crawler finds the user and password
//      fields and submits them.
//   3. Optionally preceded by sign-up at signup-path, for apps without seed data.
//
// Success is checked, not assumed. With login-check (a path only signed-in
// users can open) the crawler opens it and must not be sent back to the
// sign-in page; without it, the sign-in form must be gone after submitting.
// A failed sign-in is a blocking finding: if a dependency update breaks
// sign-in, that is exactly what the gate is for.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dummyFor, env } from './lib.mjs';

export function loginConfig() {
  const cfg = {
    path: env('RG_LOGIN_PATH', ''),
    username: env('RG_LOGIN_USERNAME', 'ci@example.com'),
    password: env('RG_LOGIN_PASSWORD', ''),
    signupPath: env('RG_SIGNUP_PATH', ''),
    check: env('RG_LOGIN_CHECK', ''),
    script: env('RG_LOGIN_SCRIPT', ''),
  };
  cfg.enabled = Boolean(cfg.script || cfg.path);
  return cfg;
}

const PASSWORD = 'input[type="password"]';

async function settle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* fine */ }
  await page.waitForTimeout(500);
}

// A sign-in form has exactly one visible password field. Change-password and
// sign-up forms have two or more, or mark theirs as a new password, so a
// signed-in settings page is not mistaken for "still on the sign-in page".
async function showsSignInForm(page) {
  return page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const scopes = [...document.querySelectorAll('form')];
    const loose = [...document.querySelectorAll('input[type="password"]')].filter((i) => !i.closest('form'));
    if (loose.length) scopes.push({ querySelectorAll: () => loose });
    return scopes.some((f) => {
      const pw = [...f.querySelectorAll('input[type="password"]')].filter(visible);
      return pw.length === 1 && pw[0].getAttribute('autocomplete') !== 'new-password';
    });
  }).catch(() => false);
}

function pathOf(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return ''; }
}

// The form that holds a password field, or the page if the inputs aren't in a <form>.
async function credentialForm(page) {
  const form = page.locator('form').filter({ has: page.locator(PASSWORD) }).first();
  return (await form.count()) ? form : page.locator('body');
}

async function fillAndSubmit(page, scope, { username, password, everything }) {
  const fields = await scope.locator('input, textarea, select').all();
  let userFilled = false;
  for (const el of fields) {
    const f = await el.evaluate((n) => ({
      tag: n.tagName, type: (n.getAttribute('type') || 'text').toLowerCase(), name: n.getAttribute('name') || '',
      label: n.getAttribute('aria-label') || (n.id && document.querySelector(`label[for="${CSS.escape(n.id)}"]`)?.textContent) || '',
      placeholder: n.getAttribute('placeholder') || '', autocomplete: n.getAttribute('autocomplete') || '',
      min: n.getAttribute('min') || '', required: n.required, disabled: n.disabled, readOnly: n.readOnly,
    }));
    if (f.disabled || f.readOnly || !(await el.isVisible())) continue;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(f.type)) continue;
    const hint = `${f.name} ${f.label} ${f.placeholder} ${f.autocomplete}`.toLowerCase();
    if (f.type === 'password') {
      await el.fill(password, { timeout: 3000 });
    } else if (!userFilled && (f.type === 'email' || /user|e-?mail|login|account|identifier/.test(hint))) {
      await el.fill(username, { timeout: 3000 });
      userFilled = true;
    } else if (f.type === 'checkbox') {
      if (f.required) await el.check({ timeout: 2000 });
    } else if (everything || f.required) {
      if (f.tag === 'SELECT') {
        if ((await el.locator('option').count()) > 1) await el.selectOption({ index: 1 }, { timeout: 2000 });
      } else if (f.type !== 'radio') {
        await el.fill(dummyFor(f), { timeout: 2000 });
      }
    }
  }
  if (!userFilled) {
    // Last resort: the first visible text-like field before the password.
    const first = scope.locator('input[type="text"], input[type="email"], input:not([type])').first();
    if (await first.count()) await first.fill(username, { timeout: 3000 });
  }
  const submit = scope.locator('button[type="submit"], button:not([type]), input[type="submit"]').first();
  if ((await submit.count()) && (await submit.isVisible())) await submit.click({ timeout: 5000 });
  else await scope.locator(PASSWORD).last().press('Enter');
  await settle(page);
}

async function alertText(page) {
  const t = await page.locator('[role="alert"], .error, .alert-danger, [aria-live="assertive"]').first().innerText({ timeout: 1000 }).catch(() => '');
  return t.trim().replace(/\s+/g, ' ').slice(0, 160);
}

// Signs in within `context`. Returns { ok, landed, reason }. Findings (a crash
// on the sign-in page, a 5xx) are recorded by the collector attached to the
// context as usual; 4xx answers to the form are expected and only warnings.
export async function signIn(context, base, cfg, collector) {
  const page = await context.newPage();
  const label = `${base}${cfg.path || '/'} (sign-in)`;
  collector.currentPage = label;
  try {
    if (cfg.script) {
      const mod = await import(pathToFileURL(path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), cfg.script)).href);
      const fn = mod.default || mod.signIn;
      if (typeof fn !== 'function') throw new Error(`${cfg.script} must export a default async function`);
      await fn({ page, context, base, username: cfg.username, password: cfg.password });
      await settle(page);
    } else {
      if (cfg.signupPath) {
        collector.currentPage = `${base}${cfg.signupPath} (sign-up)`;
        collector.expectClientErrors = true;
        try {
          await page.goto(`${base}${cfg.signupPath}`, { waitUntil: 'load', timeout: 30000 });
          await settle(page);
          if (await page.locator(PASSWORD).count()) {
            await fillAndSubmit(page, await credentialForm(page), { ...cfg, everything: true });
          }
        } finally {
          collector.expectClientErrors = false;
        }
        collector.currentPage = label;
      }
      collector.expectClientErrors = true;
      try {
        await page.goto(`${base}${cfg.path}`, { waitUntil: 'load', timeout: 30000 });
        await settle(page);
        // Some apps sign the new account straight in after sign-up.
        if (await page.locator(PASSWORD).count()) {
          await fillAndSubmit(page, await credentialForm(page), { ...cfg, everything: false });
        }
      } finally {
        collector.expectClientErrors = false;
      }
    }

    const loginPath = cfg.path ? pathOf(`${base}${cfg.path}`) : '';
    let landed = page.url();
    let ok;
    if (cfg.check) {
      const res = await page.goto(`${base}${cfg.check}`, { waitUntil: 'load', timeout: 30000 });
      await settle(page);
      const status = res?.status() ?? 0;
      ok = status > 0 && status < 400 && (!loginPath || pathOf(page.url()) !== loginPath) && !(await showsSignInForm(page));
      landed = page.url();
      if (!ok) return { ok, landed, reason: `opening ${cfg.check} after signing in ended on ${pathOf(page.url())} (HTTP ${status})${await alertText(page) ? `; the page says "${await alertText(page)}"` : ''}` };
    } else {
      const formGone = !(await showsSignInForm(page));
      ok = formGone || (loginPath && pathOf(page.url()) !== loginPath);
      if (!ok) return { ok, landed, reason: `still on the sign-in form after submitting${await alertText(page) ? `; the page says "${await alertText(page)}"` : ''}` };
    }
    return { ok: true, landed };
  } catch (err) {
    return { ok: false, landed: page.url(), reason: err.message.split('\n')[0].slice(0, 300) };
  } finally {
    await page.close().catch(() => {});
  }
}
