// Recorded flows: short sequences of actions the AI explorer performed
// successfully on the default branch, saved in the repository and replayed by
// the deterministic crawler on every PR, with no model calls. The explorer
// finds a path through the app once; after that it is a free, repeatable check
// that the path still works.
//
// File format (.github/runtime-gate-flows.json):
//   { "version": 1, "flows": [ { "name", "start", "signedIn", "steps": [ {action, ...} ], "recorded", "source" } ] }
//
// Usage as a script (the workflow uses this to update the repo file): see the
// bottom of this file. Imports nothing that needs installing.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { toStep } from './actions.mjs';

const MAX_STEPS = 10;
const MIN_STEPS = 2;

export function describeStep(s) {
  switch (s.action) {
    case 'click': return `click ${s.role} "${s.name}"`;
    case 'fill': return `type into "${s.name}"`;
    case 'select_option': return `choose "${s.option}" in "${s.name}"`;
    case 'press_key': return `press ${s.key}`;
    case 'navigate': return `go to ${s.path}`;
    case 'go_back': return 'go back';
    default: return s.action;
  }
}

// Splits what the explorer did into replayable flows. A flow starts on a page
// and ends before a navigation, a failed action, an action that caused a
// runtime error, or after MAX_STEPS steps.
export class FlowRecorder {
  constructor(base, { signedIn = false, source = '' } = {}) {
    this.base = base;
    this.signedIn = signedIn;
    this.source = source;
    this.flows = [];
    this.current = null;
  }

  path(url) {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}` || '/';
    } catch { return '/'; }
  }

  close() {
    if (this.current && this.current.steps.length >= MIN_STEPS) {
      const last = this.current.steps[this.current.steps.length - 1];
      this.flows.push({
        name: `${this.current.start}: ${describeStep(this.current.steps[0])} … ${describeStep(last)}`.slice(0, 140),
        start: this.current.start,
        signedIn: this.signedIn,
        steps: this.current.steps,
        recorded: new Date().toISOString().slice(0, 10),
        source: this.source,
      });
    }
    this.current = null;
  }

  // urlBefore: where the action was taken. ok: it worked and caused no
  // blocking runtime error.
  record(call, urlBefore, ok) {
    const step = toStep(call);
    if (!step) return; // report_issue, finish, scroll and noop change nothing worth replaying
    if (!ok || step.action === 'go_back' || step.action === 'navigate') {
      this.close();
      return;
    }
    if (!this.current) this.current = { start: this.path(urlBefore), steps: [] };
    this.current.steps.push(step);
    if (this.current.steps.length >= MAX_STEPS) this.close();
  }

  done() {
    this.close();
    return this.flows;
  }
}

export function readFlows(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.flows)) throw new Error('expected {"version": 1, "flows": [...]}');
  return data.flows.filter((f) => f && typeof f.start === 'string' && Array.isArray(f.steps) && f.steps.length);
}

const keyOf = (f) => JSON.stringify([f.start, Boolean(f.signedIn), f.steps]);

// Newest first, no duplicates, at most `max`.
export function mergeFlows(existing, added, max = 20) {
  const out = [];
  const seen = new Set();
  for (const f of [...added, ...existing]) {
    const k = keyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.slice(0, max);
}

// Usage: node flows.mjs merge <existing.json|-> <out.json> <max> <added.json>...
// Earlier files among <added> win over later ones; all win over <existing>.
// Compare file URLs, not strings: import.meta.url is percent-encoded and has
// symlinks resolved, process.argv[1] is neither.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [cmd, existingFile, outFile, max, ...addedFiles] = process.argv.slice(2);
  if (cmd !== 'merge' || !outFile || !addedFiles.length) {
    console.error('usage: node flows.mjs merge <existing.json|-> <out.json> <max> <added.json>...');
    process.exit(2);
  }
  const load = (f) => {
    if (!f || f === '-' || !fs.existsSync(f)) return [];
    try { return readFlows(f); } catch (err) { console.error(`::warning::ignoring ${f}: ${err.message}`); return []; }
  };
  const existing = load(existingFile);
  const added = addedFiles.flatMap(load);
  const merged = mergeFlows(existing, added, Number(max) || 20);
  const changed = keyOfAll(merged) !== keyOfAll(existing);
  fs.writeFileSync(outFile, `${JSON.stringify({ version: 1, flows: merged }, null, 2)}\n`);
  console.log(`${added.length} recorded, ${existing.length} already saved, ${merged.length} kept; ${changed ? 'changed' : 'unchanged'}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ncount=${merged.length}\n`);
}

function keyOfAll(flows) {
  return JSON.stringify(flows.map(keyOf));
}
