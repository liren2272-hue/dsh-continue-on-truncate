// Offline render test for the "连续续写次数" (continuation cap) row in the
// settings card of @local/dsh-continue-on-truncate.
//
// What it proves (the user's actual requirement):
//   * the row renders a NUMBER input (min 1 / max 50) + an Apply button;
//   * the value is persisted (localStorage) and pushed to the host (POST);
//   * when the host does NOT accept it (offline / non-2xx / clamped / no cap
//     field), the card NEVER claims it took effect — it shows the honest
//     "rejected / not in effect / local only" copy instead of "saved".
//
// Fake React + fake hook store: no host, no browser, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..');
const CAP_KEY = '@local/dsh-continue-on-truncate.cap';

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label); failures++; }
}
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// ---------------------------------------------------------------------------
// fake browser + fake React hook store
// ---------------------------------------------------------------------------
function makeHarness(fetchImpl) {
  const store = [];
  let cursor = 0;
  let firstRender = true;
  let pendingEffects = [];
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in store)) store[i] = typeof init === 'function' ? init() : init;
      const set = (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v; };
      return [store[i], set];
    },
    useEffect(fn) { pendingEffects.push(fn); },
    useRef(init) { return { current: init }; }
  };
  const fakeEl = () => ({
    _attrs: {}, parentNode: null, textContent: '',
    setAttribute(k, v) { this._attrs[k] = String(v); },
    appendChild(c) { c.parentNode = this; (this._children = this._children || []).push(c); },
    removeChild(c) { this._children = (this._children || []).filter((x) => x !== c); }
  });
  const docEl = fakeEl();
  const head = fakeEl();
  const document = {
    documentElement: docEl,
    head,
    createElement(t) { const e = fakeEl(); e.tag = t; return e; },
    querySelector() { return null; }
  };
  const data = {};
  const localStorage = {
    getItem(k) { return data[k] === undefined ? null : data[k]; },
    setItem(k, v) { data[k] = String(v); }
  };
  const listeners = {};
  const window = {
    __ModuleLoader__: { load(cfg) { window.__cfg = cfg; } },
    addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => fn(e)); },
    localStorage
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  globalThis.fetch = fetchImpl;

  const comps = {};
  const fakeRequire = (n) => (n === 'react' ? React : {});
  const ctx = {
    effect(fn) { try { fn(); } catch { /* ignore */ } },
    locale: { register(ns, dict) { ctx.dict = dict; }, bind() { return (k) => k; } },
    get() { return null; },
    slots: {
      inject(_n, cb) { try { cb(); } catch { /* ignore */ } },
      register(meta, comp) { comps[meta.name] = comp; }
    }
  };

  const src = fs.readFileSync(path.join(DIR, 'client.js'), 'utf8');
  new Function('window', 'document', src)(window, document);
  const plugin = window.__cfg.factory(fakeRequire);
  plugin.apply(ctx);

  // Both slots register under the same package id; pick the CONFIG card by slot
  // name so a future rename of either slot cannot silently swap the component.
  const comp = comps['plugins.bundle.config'];
  if (typeof comp !== 'function') throw new Error('config card not registered: ' + Object.keys(comps).join(','));
  function render() {
    cursor = 0;
    const tree = comp({});
    if (firstRender) {
      firstRender = false;
      const fx = pendingEffects;
      pendingEffects = [];
      // Run the mount effects exactly once, like React would.
      for (const fn of fx) { try { fn(); } catch { /* ignore */ } }
    } else {
      pendingEffects = [];
    }
    return tree;
  }
  return { render, localStorage, data, ctx, store };
}

function flatten(node, out = []) {
  if (node === undefined || node === null || node === false) return out;
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  const kids = node.props && node.props.children;
  if (Array.isArray(kids)) { for (const k of kids) flatten(k, out); }
  else if (kids !== undefined) flatten(kids, out);
  return out;
}
const byCot = (tree, cot) => flatten(tree).filter((n) => n && n.props && n.props['data-cot'] === cot);
const textOf = (n) => {
  if (n === undefined || n === null || n === false) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  return textOf(n.props && n.props.children);
};

// A host that advertises the cap field (v3.4) and answers POST with `verdict`.
function liveHost(verdict, posts) {
  return (url, opts) => {
    const isPost = !!(opts && opts.method === 'POST');
    if (!isPost) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ active: true, version: '3.4.0', maxContinuations: 5, capMin: 1, capMax: 50 }) });
    }
    const body = JSON.parse((opts && opts.body) || '{}');
    if (posts) posts.push(body);
    if (verdict === 'ok') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ active: true, maxContinuations: body.maxContinuations, capAccepted: true }) });
    }
    if (verdict === 'clamp') {
      // Host runs 5 no matter what the panel asks for.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ active: true, maxContinuations: 5, capAccepted: false }) });
    }
    if (verdict === 'error') return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    return Promise.reject(new Error('ECONNREFUSED'));
  };
}

async function mount(fetchImpl) {
  const h = makeHarness(fetchImpl);
  let tree = h.render();
  await flush();
  tree = h.render();
  return { h, tree };
}

async function scenario(name, fetchImpl, typed, expectStatus, extra) {
  console.log('\n--- ' + name + ' ---');
  const { h, tree } = await mount(fetchImpl);
  const input = byCot(tree, 'cap-input')[0];
  const apply = byCot(tree, 'cap-apply')[0];
  ok(!!input && input.type === 'input', 'cap row renders an <input>');
  ok(!!apply && apply.type === 'button', 'cap row renders an Apply <button>');
  if (input) {
    ok(input.props.type === 'number', 'input type=number');
    ok(input.props.min === 1 && input.props.max === 50, 'input bounded 1..50 (min=' + input.props.min + ', max=' + input.props.max + ')');
    ok(input.props.step === 1, 'input step=1 (integers only)');
    ok(apply && textOf(apply) === 'capApply', 'Apply button label goes through t(capApply)');
  }
  // Type -> re-render -> click, exactly like a controlled React input.
  if (input) input.props.onChange({ target: { value: typed } });
  let t2 = h.render();
  const apply2 = byCot(t2, 'cap-apply')[0];
  if (apply2) apply2.props.onClick({});
  await flush();
  const t3 = h.render();
  const status = byCot(t3, 'cap-status')[0];
  const text = textOf(status);
  ok(text === expectStatus, 'status is ' + expectStatus + ' (got "' + text + '")');
  ok(!(text === 'capSaved' && expectStatus !== 'capSaved'), 'never claims saved when the host did not accept');
  const after = byCot(t3, 'cap-input')[0];
  if (extra) extra(h, t3, after, text);
  return { h, tree: t3 };
}

(async () => {
  // 1. host accepts -> saved, value echoed, localStorage persisted, POST sent.
  const posts = [];
  await scenario('host accepts 12', liveHost('ok', posts), '12', 'capSaved', (h, _t, after) => {
    ok(posts.some((p) => p.maxContinuations === 12), 'POST body carries maxContinuations=12 (got ' + JSON.stringify(posts) + ')');
    ok(h.data[CAP_KEY] === '12', 'value persisted to localStorage (' + h.data[CAP_KEY] + ')');
    ok(after && after.props.value === '12', 'input shows the host-confirmed value');
  });

  // 2. host clamps -> must NOT say saved; must show what the host really runs.
  await scenario('host clamps 12 -> 5', liveHost('clamp'), '12', 'capClamped 5 capUnit', (_h, _t, after) => {
    ok(after && after.props.value === '5', 'input corrected to the host-clamped value (5)');
  });

  // 3. host returns non-2xx -> rejected, not saved.
  await scenario('host answers 500', liveHost('error'), '9', 'capRejected');

  // 4. host unreachable -> rejected, not saved.
  await scenario('host unreachable', liveHost('offline'), '9', 'capRejected');

  // 5. host without the cap field (old build) -> local only, honest copy.
  const oldHost = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ active: true, version: '3.1.0' }) });
  await scenario('old host without cap field', oldHost, '7', 'capPending', (h) => {
    ok(h.data[CAP_KEY] === '7', 'still persisted locally so it is not lost');
  });

  // 6. out-of-range input is refused before any host call.
  const badPosts = [];
  await scenario('input 99 is refused locally', liveHost('ok', badPosts), '99', 'capInvalid');
  ok(!badPosts.some((p) => p.maxContinuations === 99), 'no POST is sent for an out-of-range value (' + JSON.stringify(badPosts) + ')');

  // 7. i18n: the honest-reporting keys exist in BOTH dictionaries.
  console.log('\n--- dictionaries ---');
  const { h } = await mount(liveHost('ok'));
  const zh = h.ctx.dict.zh, en = h.ctx.dict.en;
  for (const k of ['capTitle', 'capUnit', 'capApply', 'capSaved', 'capPending', 'capRejected', 'capClamped', 'capRange', 'capInvalid']) {
    ok(!!zh[k] && !!en[k], 'zh+en both define ' + k);
  }

  console.log('\n' + checks + ' checks, ' + failures + ' failed');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + ((e && e.stack) || e)); process.exit(1); });
