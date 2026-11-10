// Real-sequence FRESH-TURN continuation-chain scenario for
// @local/dsh-continue-on-truncate v3.3.
//
// Why this test exists (root cause of "对话还是中断了"):
//   The core loop (dsh-agent-loop/lib/index.js) LATCHES
//     if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
//   Once a step hits max-tokens, that turn's turn/end reason is PERMANENTLY
//   max-tokens. v3.2 kept writing INSIDE that same turn via agent.steer()
//   (next-step): every extra step re-inherited the latch, the UI always showed
//   "已达到输出 token 上限 / 发送继续", and the client's fallback was gated on
//   !host.active (always false), so NOTHING auto-continued reliably.
//
//   v3.3 queues the continuation as a FRESH TURN via agent.followup()
//   (next-turn inbox). turn()'s finally sees inbox.hasPending -> returns true
//   -> kick()'s `while (await this.turn())` starts a NEW turn with turnEnds
//   reset to null and a brand-new output budget; a clean finish ends it with
//   reason=completed. Equivalent to a human typing "继续", fully automatic.
//
// This harness replays a realistic sequence of truncated turns and asserts:
//   (A) each max-tokens turn yields exactly ONE followup (fresh turn),
//   (B) a clean "stop" turn closes the chain (no more followups),
//   (C) all continuations are MACHINE messages (never a fake human "继续"),
//   (D) maxContinuations bounds the chain,
//   (E) NEGATIVE CONTROL against the v3.2 baseline: it uses steer(), not
//       followup(), and must FAIL the v3.3 contract.
//
// Usage: node test/chain-scenario.mjs [baseline-dir]
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

function makeCtx(calls) {
  const handlers = {};
  const agent = {
    id: 'sess-ee253e', provider: 'cline',
    followup(m) { calls.push({ fn: 'followup', msg: m }); },
    steer(m) { calls.push({ fn: 'steer', msg: m }); }
  };
  const ctx = {
    get(n) { return n === 'logger' ? { info() {}, warn() {} } : n === 'agents' ? { get: () => agent } : null; },
    inject(_d, cb) { cb({ webServer: { register() {} } }); },
    on(n, h) { (handlers[n] = handlers[n] || []).push(h); }
  };
  return { ctx, agent, handlers };
}

async function makeHost(dir, tag, config = {}) {
  const calls = [];
  const { ctx, agent, handlers } = makeCtx(calls);
  const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href + '?v=' + tag + '_' + Math.random());
  mod.apply(ctx, config, {});
  let attempt = 0;
  function finish(kind) {
    attempt += 1;
    const frame = {
      type: 'chunk', attemptId: 'sess-ee253e:' + attempt, turn: 1, step: attempt,
      chunk: { type: 'finish', reason: { kind } }
    };
    for (const h of (handlers['agent/assistant-stream'] || [])) h({ agent, frame });
  }
  function stopping() {
    for (const h of (handlers['agent/turn-stopping'] || [])) h({ agent, turn: 1, signal: {} });
  }
  return { calls, finish, stopping };
}

// A "truncated turn" = one max-tokens finish + the serial turn-stopping that
// the core loop fires right before break. In v3.3 exactly one followup is
// queued there, opening a fresh turn.
function truncatedTurn(h) { h.finish('max-tokens'); h.stopping(); }
function cleanTurn(h) { h.finish('stop'); h.stopping(); }

async function suite(dir, tag, isPatched) {
  console.log('\n===== CHAIN [' + tag + '] ' + dir + ' =====');
  // Two truncated turns, then a clean turn.
  const h = await makeHost(dir, tag + '_main', { maxContinuations: 10 });
  truncatedTurn(h);   // turn 1 truncated
  truncatedTurn(h);   // turn 2 (fresh) truncated again
  cleanTurn(h);       // turn 3 finishes cleanly -> chain closes

  const followups = h.calls.filter((c) => c.fn === 'followup');
  const machine = h.calls.every((c) => c.msg && c.msg.source && c.msg.source.kind === 'dsh-continue-on-truncate');

  if (isPatched) {
    ok(h.calls.every((c) => c.fn === 'followup'), 'all continuations use agent.followup() (fresh turn), never steer()');
    ok(followups.length === 2, '2 truncated turns -> exactly 2 fresh-turn followups; clean turn adds none (got ' + followups.length + ')');
    ok(machine, 'every continuation is a MACHINE message (NON-user source.kind), never a fake human 继续');
    ok(h.calls.every((c) => c.msg.__dsh_continue_on_truncate_continuation__ === true), 'every continuation carries CONTINUATION_MARK');
    ok(h.calls.every((c) => String(c.msg.content[0].text).includes('[CONTINUATION REQUIRED]')), 'every continuation carries the resume prompt');

    // Cap: realistic replay stops when a turn yields NO followup (agent idle).
    const hc = await makeHost(dir, tag + '_cap', { maxContinuations: 2 });
    for (let i = 0; i < 6; i++) {
      const before = hc.calls.length;
      truncatedTurn(hc);
      if (hc.calls.length === before) break; // no followup => idle => chain ends
    }
    ok(hc.calls.filter((c) => c.fn === 'followup').length === 2, 'maxContinuations=2 caps the chain at exactly 2 followups');
  } else {
    // NEGATIVE CONTROL: v3.2 must NOT satisfy the v3.3 contract.
    ok(!h.calls.every((c) => c.fn === 'followup'), 'BASELINE does NOT use followup() (expected RED feature)');
    ok(h.calls.some((c) => c.fn === 'steer'), 'BASELINE uses agent.steer() same-turn (the root cause)');
    ok(!(followups.length === 2), 'BASELINE followup count is NOT the v3.3 contract (expected RED feature)');
  }
}

(async () => {
  console.log('PATCHED  = ' + PATCHED);
  console.log('BASELINE = ' + (BASELINE || '(none)'));
  await suite(PATCHED, 'patched', true);
  if (BASELINE) await suite(BASELINE, 'baseline', false);
  else console.log('\n!! no baseline supplied -> negative control SKIPPED');
  console.log('\n==================================================');
  console.log('CHECKS = ' + checks + '  FAILURES = ' + failures);
  console.log(failures === 0 ? 'ALL SCENARIOS PASS' : 'CHAIN SCENARIO FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('CHAIN CRASH', e); process.exit(3); });
