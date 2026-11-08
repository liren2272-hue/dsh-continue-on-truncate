// Host half of @local/dsh-continue-on-truncate (v2).
//
// Seamless continuation at the AGENT layer. When a model step ends at the
// output token limit (finish.kind === "max-tokens"), we queue a continuation
// prompt as the NEXT STEP of the SAME turn via `agent.steer()`. The agent loop
// keeps the turn open while `inbox.nextStep` has work, so the continuation runs
// immediately — the UI shows one continuous answer with NO extra "继续" user
// bubble.
//
// IMPORTANT (DSH version reality):
//   In the currently installed asar the `agent/assistant-stream` emit payload is
//   `{ frame }` ONLY (no `agent` field), and the dispatch is agent-local. So we
//   recover the agent from `frame.attemptId` ("<sessionId>:<attempt>") via the
//   `agents` service. If the listener never reaches us (agent-local dispatch)
//   or the agent cannot be resolved, we simply do nothing here — the CLIENT
//   half (client.js) is the guaranteed fallback that always auto-sends "继续".
//   The two halves are coordinated so they never BOTH fire (see host-active
//   route + the recent-steer check on the client).
//
// Mechanism is modeled on the proven (separately published)
// @quekenao/dsh-auto-continue-community loop mode, but:
//   * provider-agnostic: works for CLOUD API providers too, not local-llama only
//     (the user runs cloud models, so the default gate is "all providers");
//   * no zod dependency (settings come from the patch `config` object with
//     in-code defaults);
//   * exposes a tiny webServer route so the client half can tell whether the
//     host JUST steered THIS truncation, suppressing its own (bubble-producing)
//     fallback auto-send and preventing a double continuation.

export const name = 'dsh-continue-on-truncate';
export const inject = [];

// Re-entrancy marker. Enumerable string key so DSH's JSON serializer
// (Reflect.ownKeys + propertyIsEnumerable) accepts the message, while the key
// stays invisible to the model (top-level envelope field, not inside content).
export const CONTINUATION_MARK = '__dsh_continue_on_truncate_continuation__';

// Continuation prompt. Tells the model to resume EXACTLY where it stopped,
// without repeating or re-apologizing — matching the host-loop behavior.
const CONTINUE_PROMPT_TEXT =
  '[CONTINUATION REQUIRED] 你上一次的回答在输出 token 上限处被截断了。' +
  '请严格从你停下的地方继续，不要重复已经写出的任何文字，不要加开场白，不要道歉，' +
  '只需接着被截断处继续输出剩余内容。';

const DEFAULT_MAX_CONTINUATIONS = 5;
// A steer counts as "this truncation" if it happened within this window before
// the client's delayed auto-send check (client delays ~1s; this gives margin).
const STEER_WINDOW_MS = 4000;

// ---------------------------------------------------------------------------
// Per-agent loop state (LRU via insertion order).
// ---------------------------------------------------------------------------
const loopState = new Map();
function loopKey(agent) {
  if (agent && typeof agent === 'object' && agent.id !== undefined) return String(agent.id);
  return '__default__';
}
function markLoopPending(agent) {
  const key = loopKey(agent);
  const state = loopState.get(key) || { pending: false, truncated: false, count: 0 };
  state.pending = true;
  loopState.set(key, state);
}
function recordLoopFinish(agent, truncated) {
  const key = loopKey(agent);
  const state = loopState.get(key) || { pending: false, truncated: false, count: 0 };
  state.pending = false;
  state.truncated = truncated;
  if (!truncated) state.count = 0; // a clean finish resets the budget
  loopState.set(key, state);
  return state;
}
function consumeContinuation(agent) {
  const key = loopKey(agent);
  const state = loopState.get(key) || { pending: false, truncated: false, count: 0 };
  state.count += 1;
  loopState.set(key, state);
  return state.count;
}
function clearLoopState(agent) {
  return loopState.delete(loopKey(agent));
}

function resolveConfig(patchConfig) {
  const cfg = patchConfig && typeof patchConfig === 'object' ? patchConfig : {};
  const maxContinuations =
    Number.isFinite(Number(cfg.maxContinuations)) && Number(cfg.maxContinuations) >= 1
      ? Number(cfg.maxContinuations)
      : DEFAULT_MAX_CONTINUATIONS;
  // providers: empty array or ['*'] => ALL providers (cloud + local).
  let providers = [];
  if (Array.isArray(cfg.providers) && cfg.providers.length > 0) {
    providers = cfg.providers.map(String);
  } else if (typeof cfg.providers === 'string' && cfg.providers.trim()) {
    providers = cfg.providers.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return { maxContinuations, providers };
}

// Recover the Agent instance from the assistant-stream frame.
// Installed asar: emit payload is `{ frame }` only. The session id is
// recoverable from `frame.attemptId` ("<sessionId>:<attempt>"). Older DSH
// versions (and quekenao's target) pass `agent` directly — support both.
function resolveAgentFromFrame(ctx, frame, explicitAgent) {
  if (explicitAgent && typeof explicitAgent.steer === 'function') return explicitAgent;
  if (frame && frame.agent && typeof frame.agent.steer === 'function') return frame.agent;
  const attemptId = frame && (frame.attemptId || (frame.chunk && frame.chunk.attemptId));
  const sessionId = typeof attemptId === 'string' ? attemptId.split(':')[0] : null;
  if (!sessionId) return null;
  let agents = null;
  try {
    agents = ctx.get ? ctx.get('agents') : ctx.agents || null;
  } catch {
    agents = null;
  }
  if (agents && typeof agents.get === 'function') {
    try {
      const a = agents.get(sessionId);
      if (a && typeof a.steer === 'function') return a;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Detect a max-tokens finish chunk inside the frame.
function isMaxTokensFrame(frame) {
  if (!frame || typeof frame !== 'object') return false;
  const chunk = frame.chunk || (frame.type === 'chunk' ? frame : null);
  if (!chunk || chunk.type !== 'finish') return false;
  const reason = chunk.reason;
  const kind = typeof reason === 'string' ? reason : (reason && (reason.kind || reason.reason));
  return String(kind).replace(/[_-]/g, '') === 'maxtokens';
}

export function apply(ctx, config, meta) {
  const logger = ctx.get
    ? (() => {
        try {
          return ctx.get('logger');
        } catch {
          return null;
        }
      })()
    : null;
  const cfg = resolveConfig(config);
  const providerSet = new Set(cfg.providers);
  const allProviders = providerSet.size === 0 || providerSet.has('*');

  const ROUTE = '/dsh-continue-on-truncate/host-active';
  let lastSteerTs = 0;
  // hostCapable = the route registered AND the listener is armed. It means "this
  // host plugin is present and trying to steer" — NOT "it steered this
  // truncation". The client uses `steeredRecently` (below) for suppression.
  let hostCapable = false;

  function log(msg) {
    if (logger && typeof logger.info === 'function') logger.info('[continue-on-truncate] ' + msg);
  }

  function providerOk(agent) {
    if (allProviders) return true;
    const pp = meta && (meta.provider || (meta.route && meta.route.provider) || meta.id);
    if (pp && providerSet.has(pp)) return true;
    const ap = agent && (agent.provider || (agent.route && agent.route.provider));
    if (typeof ap === 'string' && ap && providerSet.has(ap)) return true;
    return false;
  }

  function snapshot() {
    const now = Date.now();
    return { active: hostCapable, steeredRecently: now - lastSteerTs < STEER_WINDOW_MS, lastSteerTs };
  }

  // --- Host -> client coordination route ----------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (_req, res) => {
          try {
            const body = JSON.stringify(snapshot());
            if (res && typeof res.end === 'function') {
              if (typeof res.writeHead === 'function') {
                res.writeHead(200, { 'content-type': 'application/json' });
              }
              res.end(body);
            } else if (typeof Response !== 'undefined' && Response.json) {
              return Response.json(snapshot());
            }
          } catch (err) {
            log('host-active handler error: ' + String(err));
          }
        }
      });
      hostCapable = true;
      log('registered route ' + ROUTE);
    } catch (err) {
      log('route registration failed: ' + String(err));
    }
  });

  // --- Loop mode: observe the assistant stream ----------------------------
  // On a max-tokens finish chunk, steer the agent to continue as the next step
  // of the same turn. Registered globally so it is visible across the agent
  // dispatch regardless of plugin scope.
  ctx.on(
    'agent/assistant-stream',
    ({ agent, frame }) => {
      const fr = frame || (agent && agent.frame) || null;
      if (!fr || typeof fr !== 'object') return;
      if (fr.type === 'start') return; // wait for the finish chunk
      if (!isMaxTokensFrame(fr)) return;

      const ag = resolveAgentFromFrame(ctx, fr, agent);
      if (!ag) {
        log('truncation seen but agent could not be resolved; client fallback will handle');
        return;
      }
      if (!providerOk(ag)) return;

      // Re-entrancy guard: if the last user message is our own continuation,
      // we are already in a continuation chain — do not double-inject.
      const lastMsg =
        ag.inbox && Array.isArray(ag.inbox.messages)
          ? ag.inbox.messages[ag.inbox.messages.length - 1]
          : null;
      if (lastMsg && lastMsg.role === 'user' && lastMsg[CONTINUATION_MARK]) {
        log('agent ' + ag.id + ' already continuing; skip');
        clearLoopState(ag);
        return;
      }

      const state = recordLoopFinish(ag, true);
      if (state.count >= cfg.maxContinuations) {
        log('agent ' + ag.id + ' budget exhausted; skip');
        clearLoopState(ag);
        return;
      }

      const id =
        globalThis.crypto && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'cont-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const continuationMsg = {
        id,
        role: 'user',
        content: [{ type: 'text', text: CONTINUE_PROMPT_TEXT }],
        source: { kind: 'user' },
      };
      Object.defineProperty(continuationMsg, CONTINUATION_MARK, { value: true, enumerable: true });

      try {
        ag.steer(continuationMsg);
        const n = consumeContinuation(ag);
        lastSteerTs = Date.now();
        log('agent ' + ag.id + ' steering continuation ' + n + '/' + cfg.maxContinuations);
      } catch (err) {
        log('agent ' + ag.id + ' steer() failed: ' + (err && err.message));
      }
    },
    { global: true }
  );

  // Clean up loop state when an agent is disposed.
  ctx.on(
    'agent/dispose',
    ({ agent }) => {
      clearLoopState(agent);
    },
    { global: true }
  );

  log(
    'apply() done; maxContinuations=' +
      cfg.maxContinuations +
      ', providers=' +
      (allProviders ? 'ALL' : [...providerSet].join(','))
  );
}
