// Browser actions shared by the AI explorer (which chooses them) and the flow
// replayer (which repeats ones the explorer already proved work). Every action
// a model proposes is validated here before it touches the page, so a model
// steered by hostile page content can still only do small, same-site things.
//
// Dependency-free on purpose (no Playwright import): flows.mjs uses it from a
// workflow step that has not installed anything.

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const ROLES = new Set([
  'button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'treeitem', 'gridcell', 'row',
  'listitem', 'heading', 'img', 'cell', 'columnheader', 'rowheader', 'region', 'dialog', 'navigation',
]);
const KEYS = new Set(['Escape', 'Enter', 'Tab', 'Shift+Tab', 'Space', ' ', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const SAFE_URL_HOSTS = /^(example\.(com|org|net)|localhost|127\.0\.0\.1)$/i;
const MAX_TEXT = 200;

// Returns null when the action is acceptable, otherwise the reason it isn't.
export function rejectReason(call, base) {
  const a = call.args || {};
  const str = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;
  switch (call.name) {
    case 'click':
      if (!ROLES.has(String(a.role))) return `role "${a.role}" is not allowed`;
      if (!str(a.name)) return 'name missing or too long';
      if (a.nth !== undefined && !(Number.isInteger(a.nth) && a.nth >= 0 && a.nth <= 50)) return 'nth out of range';
      return null;
    case 'fill': {
      if (!str(a.name) || !str(String(a.text ?? ''))) return 'name or text missing or too long';
      for (const m of String(a.text).matchAll(/https?:\/\/([^/\s:]+)/gi)) {
        if (!SAFE_URL_HOSTS.test(m[1])) return `typing a link to ${m[1]} is not allowed`;
      }
      if (/[A-Za-z0-9+/]{120,}={0,2}/.test(String(a.text))) return 'text looks like an encoded payload';
      return null;
    }
    case 'select_option':
      return str(a.name) && str(a.option) ? null : 'name or option missing or too long';
    case 'press_key':
      return KEYS.has(String(a.key)) ? null : `key "${a.key}" is not allowed`;
    case 'navigate': {
      if (!str(String(a.path ?? ''), 300)) return 'path too long';
      try {
        return sameOrigin(new URL(a.path || '/', `${base}/`).href, base) ? null : 'navigation must stay on the application';
      } catch {
        return 'invalid path';
      }
    }
    case 'go_back': case 'finish': case 'report_issue':
      return null;
    case 'scroll':
      return ['down', 'up', 'top', 'bottom'].includes(a.direction) ? null : 'bad direction';
    default:
      return `unknown action "${call.name}"`;
  }
}

async function first(cands, fn) {
  let lastErr;
  for (const c of cands) {
    try {
      if ((await c.count()) === 0) continue;
      await fn(c);
      return;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no element matched');
}

// Performs a validated action. Throws when the target cannot be found or used.
export async function perform(page, call, base) {
  const a = call.args || {};
  const t = { timeout: 6000 };
  switch (call.name) {
    case 'click': {
      const nth = a.nth || 0;
      await first([
        page.getByRole(a.role, { name: a.name, exact: true }).nth(nth),
        page.getByRole(a.role, { name: a.name }).nth(nth),
        page.getByText(a.name, { exact: false }).nth(nth),
      ], (l) => l.click(t));
      return `clicked ${a.role} "${a.name}"`;
    }
    case 'fill': {
      const role = a.role || 'textbox';
      await first([
        page.getByRole(role, { name: a.name, exact: true }), page.getByRole(role, { name: a.name }),
        page.getByLabel(a.name), page.getByPlaceholder(a.name),
      ].map((l) => l.first()), (l) => l.fill(String(a.text ?? ''), t));
      if (a.submit) await page.keyboard.press('Enter');
      return `typed "${String(a.text).slice(0, 60)}" into "${a.name}"${a.submit ? ' and pressed Enter' : ''}`;
    }
    case 'select_option':
      await first([page.getByRole('combobox', { name: a.name }), page.getByLabel(a.name)].map((l) => l.first()),
        (l) => l.selectOption({ label: a.option }, t));
      return `selected "${a.option}" in "${a.name}"`;
    case 'press_key':
      await page.keyboard.press(a.key === 'Space' ? ' ' : a.key);
      return `pressed ${a.key}`;
    case 'navigate': {
      const target = new URL(a.path || '/', `${base}/`).href;
      await page.goto(target, { waitUntil: 'load', timeout: 30000 });
      return `navigated to ${target.replace(base, '') || '/'}`;
    }
    case 'go_back':
      await page.goBack({ waitUntil: 'load', timeout: 15000 });
      return 'went back';
    case 'scroll':
      await page.evaluate((dir) => {
        if (dir === 'top') window.scrollTo(0, 0);
        else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(0, (dir === 'up' ? -1 : 1) * window.innerHeight * 0.8);
      }, a.direction);
      return `scrolled ${a.direction}`;
    default:
      throw new Error(`cannot perform ${call.name}`);
  }
}

// The replayable part of an action: what to do, never why.
export function toStep(call) {
  const a = call.args || {};
  switch (call.name) {
    case 'click': return { action: 'click', role: a.role, name: a.name, ...(a.nth ? { nth: a.nth } : {}) };
    case 'fill': return { action: 'fill', role: a.role || 'textbox', name: a.name, text: String(a.text ?? ''), ...(a.submit ? { submit: true } : {}) };
    case 'select_option': return { action: 'select_option', name: a.name, option: a.option };
    case 'press_key': return { action: 'press_key', key: a.key };
    case 'navigate': return { action: 'navigate', path: a.path };
    case 'go_back': return { action: 'go_back' };
    default: return null;
  }
}

export function fromStep(step) {
  const { action, ...args } = step;
  return { name: action, args };
}
