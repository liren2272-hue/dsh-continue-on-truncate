// Offline selftest for @local/dsh-continue-on-truncate v3.3.
// Usage: node test/selftest.mjs [baseline-dir]
//   baseline-dir = a copy of the ORIGINAL v3.2 build, used as a NEGATIVE
//   CONTROL: the v3.3 features must be ABSENT there (must go RED).
//
// v3.3 = FRESH-TURN continuation: the host observes max-tokens finishes but
// queues exactly ONE machine continuation per truncated turn from the
// `agent/turn-stopping` serial event, via `agent.followup()` (next-turn inbox).
// The core loop then starts a NEW turn (turnEnds resets), so the continued
// output can finish cleanly instead of being permanently latched as max-tokens.
//
// This harness never touches the live host: it dynamically imports each build
// with a fake Cordis ctx (reproducing the `cannot get property "X" without
// inject` proxy trap) + a fake agent exposing BOTH followup() and steer(),
// then replays realistic finish / turn-stopping sequences.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHED = path.resolve(HERE, '..');
const BASELINE = process.argv[2] ? path.resolve(process.argv[2]) : null;

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label); failures++; }
}

// ---------------------------------------------------------------------------
// HOST harness: returns a result object describing what a build did.
// ---------------------------------------------------------------------------
function buildCtx(calls) {
  const listeners = {};
  const routes = {};
  const agent = {
    id: 'selftest-agent',
    provider: 'cline',
    followup(m) { calls.push({ fn: 'followup', msg: m }); },
    steer(m) { calls.push({ fn: 'steer', msg: m }); }
  };
  const logger = { info() {}, warn() {} };
  const ctx = {
    get(name) {
      if (name === 'logger') return logger;
      throw new Error(`cannot get property "${name}" without inject`);
    },
    inject(_deps, cb) {
      cb({ webServer: { register(cfg) { routes[cfg.path] = cfg.handler; } } });
    },
    on(name, handler) { (listeners[name] = listeners[name] || []).push(handler); return () => {}; },
    _listeners: listeners,
    _routes: routes,
    _agent: agent
  };
  return ctx;
}

async function callRoute(routes, method, body) {
  const handler = routes['/dsh-continue-on-truncate/host-active'];
  if (!handler) return null;
  let raw = '';
  const req = {
    method: method || 'GET',
    on(ev, cb) {
      if (method === 'POST') {
        if (ev === 'data') setImmediate(() => cb(body || '{}'));
        if (ev === 'end') setImmediate(() => cb());
      }
    }
  };
  let out = null;
  const res = {
    writeHead() {},
    end(text) { out = text; }
  };
  handler(req, res);
  // POST resolves body in a microtask/setImmediate; wait for `end`.
  for (let i = 0; i < 20 && out === null; i++) await new Promise((r) => setImmediate(r));
  try { return JSON.parse(out || '{}'); } catch { return null; }
}

async function replay(buildDir, tag, config, seq, stopOnIdle = false) {
  const calls = [];
  const ctx = buildCtx(calls);
  const mod = await import(pathToFileURL(path.join(buildDir, 'index.js')).href + '?v=' + tag + '_' + Math.random());
  mod.apply(ctx, config, {});
  const L = ctx._listeners;
  const agent = ctx._agent;
  let attempt = 100;
  const finish = (kind) => {
    const frame = { attemptId: 'sessA:' + (++attempt), turn: 7, chunk: { type: 'finish', reason: { kind } } };
    for (const h of (L['agent/assistant-stream'] || [])) h({ agent, frame });
  };
  const stopping = () => {
    for (const h of (L['agent/turn-stopping'] || [])) h({ agent, turn: 7, signal: {} });
  };
  for (const ev of seq) {
    if (ev === 'stopping') {
      const before = calls.length;
      stopping();
      // REALISTIC: if this turn queued NO continuation, turn() returns false,
      // kick() exits and the agent goes IDLE — further turns cannot happen
      // without a genuine new user message. Stop the replay there.
      if (stopOnIdle && calls.length === before) break;
    } else finish(ev);
  }
  const snap = await callRoute(ctx._routes, 'GET');
  return {
    calls, snap,
    followups: calls.filter((c) => c.fn === 'followup'),
    steers: calls.filter((c) => c.fn === 'steer'),
    hasTurnStopping: !!(L['agent/turn-stopping'] || []).length,
    hasDisposed: !!(L['agent/disposed'] || []).length
  };
}

async function hostSuite(dir, tag, isPatched) {
  console.log('\n===== HOST [' + tag + '] ' + dir + ' =====');
  // Two truncations (each its own fresh turn) then a clean finish.
  const r = await replay(dir, tag + '_seq', { maxContinuations: 10 }, [
    'max-tokens', 'stopping',       // turn A truncated -> queue continuation
    'max-tokens', 'stopping',       // turn B (fresh) truncated again -> queue
    'stop', 'stopping'              // turn C clean -> chain closes
  ]);
  const allFollowup = r.calls.length > 0 && r.calls.every((c) => c.fn === 'followup');
  const m0 = r.calls[0] && r.calls[0].msg;

  if (isPatched) {
    ok(r.snap && r.snap.active === true, 'GET /host-active returns active:true');
    ok(r.snap && r.snap.version === '3.4.0', 'GET /host-active reports version 3.4.0 (runtime proof after restart)');
    ok(r.snap && r.snap.maxContinuations === 10, 'GET reports runtime cap from config (10)');
    ok(r.snap && r.snap.capMin === 1 && r.snap.capMax === 50, 'GET reports cap bounds 1..50');
    ok(allFollowup, 'continuations go through agent.followup() (FRESH TURN), never steer()');
    ok(r.followups.length === 2, 'exactly 2 followups for 2 truncations, clean finish adds none (got ' + r.followups.length + ')');
    ok(r.hasTurnStopping, 'registers agent/turn-stopping (the ONLY continuation trigger)');
    ok(r.hasDisposed, 'registers agent/disposed cleanup');
    ok(!!m0 && m0.source && m0.source.kind === 'dsh-continue-on-truncate', 'continuation msg keeps NON-user MACHINE source.kind');
    ok(!!m0 && m0.__dsh_continue_on_truncate_continuation__ === true, 'continuation msg carries CONTINUATION_MARK');
    ok(!!m0 && String(m0.content && m0.content[0] && m0.content[0].text).includes('[CONTINUATION REQUIRED]'), 'continuation msg carries the [CONTINUATION REQUIRED] prompt');
    ok(!!m0 && m0.role === 'user' && Array.isArray(m0.content), 'continuation msg has role/content (core loop feeds it)');

    // Cap: a bounded chain must stop producing followups once the cap is hit
    // (realistic replay: no followup => turn() returns false => agent idle).
    const capResult = await replay(dir, tag + '_cap', { maxContinuations: 2 }, [
      'max-tokens', 'stopping', 'max-tokens', 'stopping',
      'max-tokens', 'stopping', 'max-tokens', 'stopping'
    ], true);
    ok(capResult.followups.length === 2, 'maxContinuations=2 caps the fresh-turn chain at exactly 2 (got ' + capResult.followups.length + ')');

    // mode=off via POST disables machine continuation.
    {
      const calls = [];
      const ctx = buildCtx(calls);
      const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href + '?v=' + tag + '_off_' + Math.random());
      mod.apply(ctx, {}, {});
      await callRoute(ctx._routes, 'POST', JSON.stringify({ enabled: false }));
      const L = ctx._listeners; const agent = ctx._agent;
      let a = 200;
      const fin = { attemptId: 'x:' + (++a), turn: 1, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } };
      for (const h of (L['agent/assistant-stream'] || [])) h({ agent, frame: fin });
      for (const h of (L['agent/turn-stopping'] || [])) h({ agent, turn: 1, signal: {} });
      ok(calls.length === 0, 'mode=off (POST {enabled:false}): NO continuation queued');
    }

    // POST {maxContinuations} clamp (1..50).
    {
      const ctx = buildCtx([]);
      const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href + '?v=' + tag + '_post_' + Math.random());
      mod.apply(ctx, {}, {});
      const hi = await callRoute(ctx._routes, 'POST', JSON.stringify({ maxContinuations: 999 }));
      const lo = await callRoute(ctx._routes, 'POST', JSON.stringify({ maxContinuations: 0 }));
      const bad = await callRoute(ctx._routes, 'POST', JSON.stringify({ maxContinuations: 'abc' }));
      ok(hi && hi.maxContinuations === 50, 'POST out-of-range 999 clamps to capMax 50');
      ok(lo && lo.maxContinuations === 1, 'POST out-of-range 0 clamps to capMin 1');
      ok(bad && bad.maxContinuations === 1, 'POST non-numeric cap ignored (keeps previous 1)');
      // v3.4: the snapshot must EXPOSE that the value was not taken verbatim, so
      // the settings card can avoid reporting a clamp as "saved".
      ok(hi && hi.capAccepted === false && hi.capRequested === 999, 'GET/POST snapshot flags a clamped value (capAccepted:false, capRequested:999)');
      ok(bad && bad.capAccepted === false, 'GET/POST snapshot flags a refused value (capAccepted:false)');
      const exact = await callRoute(ctx._routes, 'POST', JSON.stringify({ maxContinuations: 12 }));
      ok(exact && exact.maxContinuations === 12 && exact.capAccepted === true, 'accepted value reports capAccepted:true with the applied cap');
    }
  } else {
    // NEGATIVE CONTROL: the v3.2 build must NOT satisfy the v3.3 contract.
    ok(!(r.snap && r.snap.version === '3.3.0'), 'BASELINE reports NO version 3.3.0 (expected RED feature)');
    ok(!allFollowup, 'BASELINE does NOT use followup() (it used steer() — expected RED feature)');
    ok(r.steers.length > 0, 'BASELINE used agent.steer() (same-turn), the root cause');
    ok(!(r.followups.length === 2), 'BASELINE followup count is not the v3.3 contract (expected RED feature)');
  }
  return r;
}

// ---------------------------------------------------------------------------
// CLIENT harness
// ---------------------------------------------------------------------------
async function loadClient(dir, tag) {
  const captured = { styles: [], dictionaries: null, slots: [], htmlAttrs: {} };
  const listeners = {};
  const fakeEl = () => ({
    _attrs: {}, parentNode: null, textContent: '',
    setAttribute(k, v) { this._attrs[k] = String(v); },
    appendChild(c) { c.parentNode = this; (this._children = this._children || []).push(c); }
  });
  const docEl = fakeEl(), head = fakeEl();
  const document = {
    documentElement: docEl, head,
    createElement(t) { const e = fakeEl(); e.tag = t; return e; },
    querySelector() { return null; }
  };
  const localStorage = { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); } };
  const window = {
    __ModuleLoader__: { load(cfg) { captured.moduleCfg = cfg; } },
    addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn); },
    removeEventListener() {}, dispatchEvent(e) { captured.lastEvent = e; }, localStorage
  };
  globalThis.window = window; globalThis.document = document; globalThis.localStorage = localStorage;
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  globalThis.Response = undefined;
  const React = { useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), createElement: () => ({}), Fragment: Symbol('Fragment') };
  const fakeRequire = (n) => (n === 'react' ? React : {});
  const url = pathToFileURL(path.join(dir, 'client.js')).href + '?v=' + tag + '_' + Math.random();
  await import(url);
  let plugin = null;
  try { plugin = captured.moduleCfg.factory(fakeRequire); } catch (e) { captured.factoryError = String(e); }
  const ctx = {
    effect(fn) { try { fn(); } catch (e) { captured.effectError = String(e); } },
    locale: { register(ns, dict) { captured.dictionaries = dict; }, bind() { return (k) => k; } },
    get() { return null; },
    slots: { inject(n, cb) { try { cb(); } catch (e) { captured.injectError = String(e); } }, register(meta, comp) { captured.slots.push({ meta, comp }); } }
  };
  if (plugin && typeof plugin.apply === 'function') { try { plugin.apply(ctx); } catch (e) { captured.applyError = String(e); } }
  captured.styles = (head._children || []).filter((e) => e.tag === 'style');
  captured.htmlAttrs = docEl._attrs;
  return captured;
}

async function clientSuite(dir, tag, isPatched) {
  console.log('\n===== CLIENT [' + tag + '] ' + dir + ' =====');
  const src = fs.readFileSync(path.join(dir, 'client.js'), 'utf8');
  const c = await loadClient(dir, tag);
  ok(!c.factoryError && !c.applyError, 'factory+apply run without throwing (' + (c.factoryError || c.applyError || 'ok') + ')');
  ok(!!c.dictionaries && !!c.dictionaries.zh && !!c.dictionaries.en, 'zh+en dictionaries registered');
  ok(c.slots.length >= 2, 'turnTail + config slots registered (' + c.slots.length + ')');
  const hint = c.styles.find((s) => s._attrs['data-cot'] === 'native-hint-rewrite');
  if (isPatched) {
    ok(!!hint, 'GLOBAL <style data-cot="native-hint-rewrite"> injected at apply()');
    const st = hint ? hint.textContent : '';
    ok(st.includes('data-chat-flow-kind="turn-max-tokens"'), 'hint style targets the native turn-max-tokens wrapper');
    ok(st.includes('data-cot-mode'), 'hint style gated by data-cot-mode');
    ok(st.includes('已自动续写'), 'hint style has Chinese "已自动续写" replacement text');
    ok(st.includes('Auto-continued'), 'hint style has English "Auto-continued" replacement text');
    ok(st.includes(':has('), 'hint style has :has() fallback selector');
    ok(st.includes('display: none'), 'native [role=status] row is hidden');
    ok(!st.includes('同一回合') && !st.includes('in the same turn'), 'v3.3 hint NO LONGER claims "同一回合 / same turn" (mechanism is fresh-turn)');
    ok(c.htmlAttrs['data-cot-mode'] === 'silent', 'html[data-cot-mode] set to current mode at apply()');
    ok(src.includes('const clientFallback = !host.active'), 'client keeps host-driven gating (never double-continues)');
    ok(src.includes('readCap') && src.includes('writeCap') && src.includes('syncHostCap'), 'client has cap persistence + host-cap sync helpers');
    ok(src.includes('res.applied === v && res.accepted !== false'), 'client only reports "saved" when the host accepted the exact value');
    ok(src.includes("t('capRejected')") && src.includes("t('capClamped')"), 'client has honest rejected/clamped copy (no false "applied")');
    ok(src.includes("'data-cot': 'cap-input'") && src.includes("'data-cot': 'cap-apply'"), 'settings card renders cap input + Apply button');
    ok(!!c.dictionaries.zh.capTitle && !!c.dictionaries.en.capTitle, 'cap panel has zh+en labels');
  } else {
    // NEGATIVE CONTROL: v3.3 features MUST be absent on the v3.2 baseline.
    // (The v3.1 hint-rewrite style itself already existed in v3.2 — that is
    // NOT a v3.3 feature. What is new is the fresh-turn mechanism wording.)
    ok(!src.includes('(v3.3)'), 'BASELINE client header is NOT v3.3 (expected RED feature)');
    ok(!src.includes('followup'), 'BASELINE client has NO followup() fresh-turn description (expected RED feature)');
    ok(src.includes('同一回合') || src.includes('in the same turn'), 'BASELINE still has the WRONG "同一回合 / same turn" wording that v3.3 removed (expected RED feature)');
    ok(src.includes('agent.steer()'), 'BASELINE client still describes agent.steer() (expected RED feature)');
  }
  return c;
}

(async () => {
  console.log('PATCHED  = ' + PATCHED);
  console.log('BASELINE = ' + (BASELINE || '(none)'));
  await hostSuite(PATCHED, 'patched', true);
  await clientSuite(PATCHED, 'patched', true);
  if (BASELINE) {
    await hostSuite(BASELINE, 'baseline', false);
    await clientSuite(BASELINE, 'baseline', false);
  } else {
    console.log('\n!! no baseline supplied -> negative control SKIPPED');
  }
  console.log('\n==================================================');
  console.log('CHECKS = ' + checks + '  FAILURES = ' + failures);
  console.log(failures === 0 ? 'ALL SCENARIOS PASS' : 'SELFTEST FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('SELFTEST CRASH', e); process.exit(3); });
