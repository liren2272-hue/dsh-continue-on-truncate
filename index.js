// Host half of @local/dsh-continue-on-truncate (v3.4).
//
// Seamless continuation at the AGENT layer. When a model step ends at the
// output token limit (finish.kind === "max-tokens"), we queue a continuation
// prompt as a FRESH TURN via agent.followup() ("next-turn" inbox + wakeup).
//
// WHY v3.3 (root cause of "对话还是中断了"):
//   The core loop (dsh-agent-loop/lib/index.js) LATCHES
//     if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
//   so once ONE step hits max-tokens, that turn's turn/end reason is
//   PERMANENTLY max-tokens. v3.2 used agent.steer() ("next-step") to keep
//   writing inside that SAME turn: every extra step still inherited the
//   max-tokens latch, the UI always showed "已达到输出 token 上限 / 发送继续",
//   and each continuation step could itself re-truncate until the cap ran out.
//   Meanwhile the CLIENT half's fallback was gated on !host.active, which is
//   always false (hostCapable = route registered), so NOTHING auto-continued.
//
//   agent.followup() is exactly what a human typing "继续" does: it puts the
//   message in the "next-turn" inbox. turn()'s finally sees inbox.hasPending
//   and returns true, so kick()'s while (await this.turn()) starts a FRESH
//   turn whose turnEnds resets to null -> the continued output can finish
//   CLEANLY (reason=completed), with a brand-new output budget. Automatic.
//
// Kept from v3.2:
//  (1) HUMAN vs MACHINE boundary: source.kind stays NON-'user', so the chat
//      renders a MACHINE inject/context node, never a fake human "继续" bubble.
//  (2) attemptId de-dup (each finish frame handled once) + a per-chain
//      continuation cap to stop infinite loops; a clean finish closes the chain.
//  (3) MODE SYNC via POST {enabled} / {maxContinuations} on the exact route.
//
// The agent/assistant-stream emit payload carries the agent via agentEvents
// (fused { ...payload, agent }); we also support frame.agent and recovery from
// frame.attemptId ("<sessionId>:<attempt>") via the agents service.

export const name = 'dsh-continue-on-truncate';
export const inject = [];

// Re-entrancy marker. Enumerable string key so DSH's JSON serializer
// (Reflect.ownKeys + propertyIsEnumerable) accepts the message, while the key
// stays invisible to the model (top-level envelope field, not inside content).
export const CONTINUATION_MARK = '__dsh_continue_on_truncate_continuation__';

// Machine source label. Anything other than "user" makes the chat render this
// as a machine context node instead of a human "继续" bubble (see asar probe:
// contextProducer default -> { role: "inject", label: kind }).
export const SOURCE_KIND = 'dsh-continue-on-truncate';

// Continuation prompt. Tells the model to resume EXACTLY where it stopped,
// without repeating or re-apologizing — matching the host-loop behavior.
const CONTINUE_PROMPT_TEXT =
  '[CONTINUATION REQUIRED] 你上一次的回答在输出 token 上限处被截断了。' +
  '请严格从你停下的地方继续，不要重复已经写出的任何文字，不要加开场白，不要道歉，' +
  '只需接着被截断处继续输出剩余内容。';

const DEFAULT_MAX_CONTINUATIONS = 5;
// A steer counts as "this truncation" if it happened within this window before
// the client's delayed probe (client delays ~1s; this gives margin).
const STEER_WINDOW_MS = 4000;
const MAX_HANDLED_PER_AGENT = 32;

// v3.2: the continuation cap is RUNTIME-ADJUSTABLE from the settings panel.
// The client POSTs {maxContinuations}; we clamp to a safe integer range so a
// stray value can never turn the bounded chain into an unbounded loop. The
// value lives in host memory and is restored by the client (localStorage) on
// every apply(), so it survives a host restart without touching disk config.
const CAP_MIN = 1;
const CAP_MAX = 50;
function sanitizeCap(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(CAP_MIN, Math.min(CAP_MAX, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Per-agent continuation state (LRU via insertion order).
//   count          : consecutive steers issued for the current truncation chain
//   handled        : set of frame keys already acted on (de-dupe replays)
// ---------------------------------------------------------------------------
const agentState = new Map();
function agentKey(agent) {
  if (agent && typeof agent === 'object' && agent.id !== undefined) return String(agent.id);
  return '__default__';
}
function getState(agent) {
  const key = agentKey(agent);
  let s = agentState.get(key);
  if (!s) {
    s = { count: 0, handled: new Set(), chain: false, chainDone: false, chainLastFinish: '', chainTurn: null };
    agentState.set(key, s);
  }
  // keep the map bounded
  if (agentState.size > 64) {
    const oldest = agentState.keys().next().value;
    if (oldest !== undefined && oldest !== key) agentState.delete(oldest);
  }
  return s;
}
function frameKey(frame, agent) {
  const aid = frame && (frame.attemptId || (frame.chunk && frame.chunk.attemptId));
  if (aid) return 'a:' + String(aid);
  const rev = frame && frame.revision !== undefined ? frame.revision : '';
  const turn = frame && frame.turn !== undefined ? frame.turn : '';
  const step = frame && frame.step !== undefined ? frame.step : '';
  return 'x:' + agentKey(agent) + ':' + turn + ':' + step + ':' + rev;
}
function wasHandled(agent, key) {
  return getState(agent).handled.has(key);
}
function markHandled(agent, key) {
  const s = getState(agent);
  s.handled.add(key);
  if (s.handled.size > MAX_HANDLED_PER_AGENT) {
    const first = s.handled.values().next().value;
    if (first !== undefined) s.handled.delete(first);
  }
}
function nextCount(agent) {
  const s = getState(agent);
  s.count += 1;
  return s.count;
}
function resetBudget(agent) {
  const s = getState(agent);
  s.count = 0; // a clean (non-truncated) finish resets the budget
  s.handled.clear();
  s.chain = false;
  s.chainDone = false;
  s.chainLastFinish = '';
  s.chainTurn = null;
}
function clearState(agent) {
  agentState.delete(agentKey(agent));
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
// Installed asar: emit payload may be `{ frame }` only. The session id is
// recoverable from `frame.attemptId` ("<sessionId>:<attempt>"). Older DSH
// versions pass `agent` directly — support both.
function resolveAgentFromFrame(ctx, frame, explicitAgent) {
  if (explicitAgent && (typeof explicitAgent.followup === 'function' || typeof explicitAgent.steer === 'function')) return explicitAgent;
  if (frame && frame.agent && (typeof frame.agent.followup === 'function' || typeof frame.agent.steer === 'function')) return frame.agent;
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
      if (a && (typeof a.followup === 'function' || typeof a.steer === 'function')) return a;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function finishKind(chunk) {
  const reason = chunk && chunk.reason;
  const k = typeof reason === 'string' ? reason : reason && (reason.kind || reason.reason);
  return String(k == null ? '' : k).replace(/[_-]/g, '').toLowerCase();
}
function isMaxTokens(chunk) {
  const k = finishKind(chunk);
  return k === 'maxtokens' || k === 'maxoutputtokens' || k === 'length';
}

// Normalized finish category for the v3.1 continuation-chain state machine.
function normalizedFinish(chunk) {
  if (isMaxTokens(chunk)) return 'max-tokens';
  const k = finishKind(chunk);
  if (k === 'toolcalls' || k === 'toolcall') return 'tool-calls';
  return k || 'other';
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
  // v3.2: runtime cap. Starts from the patch config (so cordis.patch.yml still
  // works as an admin default), then can be overridden at runtime via POST.
  let runtimeCap = cfg.maxContinuations;
  const cap = () => runtimeCap;
  // v3.4: verdict of the LAST POST {maxContinuations}. The settings card must
  // be able to distinguish "host applied it" from "host refused / clamped it",
  // otherwise a rejected value would be reported as saved.
  let capVerdict = null;

  const ROUTE = '/dsh-continue-on-truncate/host-active';
  let lastSteerTs = 0;
  let steerCount = 0;
  // hostCapable = route registered AND listener armed. "This host plugin is
  // present", NOT "it steered this truncation".
  let hostCapable = false;
  // steerEnabled = machine continuation is allowed. Mode "off" (client POSTs
  // {enabled:false}) turns it off so a human "继续" is the only continuation.
  let steerEnabled = true;

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

  // Build + queue ONE machine continuation as a FRESH TURN. Called ONLY from
  // agent/turn-stopping (serial, reliable) -- never from the finish-chunk
  // emit -- so exactly one continuation is queued per truncated turn.
  function queueContinuation(ag, via) {
    const state = getState(ag);
    if (state.count >= cap()) return false;
    if (!steerEnabled) return false;
    if (!providerOk(ag)) return false;
    const id =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : 'cont-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const continuationMsg = {
      id,
      role: 'user',
      content: [{ type: 'text', text: CONTINUE_PROMPT_TEXT }],
      // NON-'user' source.kind => machine inject/context node in chat, never
      // a human "继续" bubble. The agent loop still feeds it to the model.
      source: { kind: SOURCE_KIND }
    };
    Object.defineProperty(continuationMsg, CONTINUATION_MARK, { value: true, enumerable: true });
    try {
      if (typeof ag.followup === 'function') {
        ag.followup(continuationMsg); // v3.3: fresh turn, clean finish possible
      } else if (typeof ag.steer === 'function') {
        ag.steer(continuationMsg); // legacy hosts without followup()
      } else {
        throw new Error('agent exposes neither followup() nor steer()');
      }
      const n = nextCount(ag);
      lastSteerTs = Date.now();
      steerCount += 1;
      log('agent ' + ag.id + ' queued FRESH-TURN MACHINE continuation ' + n + '/' + cap() + ' (' + via + ')');
      return true;
    } catch (err) {
      log('agent ' + ag.id + ' continuation queue failed: ' + (err && err.message));
      return false;
    }
  }
  // Version is reported so a single GET /host-active probe proves which build
  // the RUNNING host actually loaded (disk mtime / restart time are weaker
  // evidence). 3.4.0 = fresh-turn continuation via agent.followup() PLUS an
  // explicit cap verdict (capRequested / capAccepted) so the settings card can
  // never report a clamped or refused cap as applied.
  const HOST_VERSION = '3.4.0';
  function snapshot() {
    const now = Date.now();
    return {
      active: hostCapable,
      version: HOST_VERSION,
      steeredRecently: now - lastSteerTs < STEER_WINDOW_MS && lastSteerTs > 0,
      steerEnabled,
      steerCount,
      lastSteerTs,
      maxContinuations: cap(),
      capMin: CAP_MIN,
      capMax: CAP_MAX,
      capRequested: capVerdict ? capVerdict.requested : cap(),
      capAccepted: capVerdict ? capVerdict.accepted : true
    };
  }
  function respond(res, obj) {
    try {
      const body = JSON.stringify(obj);
      if (res && typeof res.end === 'function') {
        if (typeof res.writeHead === 'function') {
          res.writeHead(200, { 'content-type': 'application/json' });
        }
        res.end(body);
        return;
      }
      if (typeof Response !== 'undefined' && Response.json) return Response.json(obj);
    } catch (err) {
      log('host-active respond error: ' + String(err));
    }
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      try {
        req.on('data', (c) => {
          raw += c;
          if (raw.length > 4096) raw = raw.slice(0, 4096);
        });
        req.on('end', () => resolve(raw));
        req.on('error', () => resolve(raw));
      } catch {
        resolve(raw);
      }
    });
  }

  // --- One exact route: GET/HEAD = status, POST = set enabled / cap ---------
  // v3.2: POST also accepts {maxContinuations} from the settings panel. Both
  // fields are optional so the existing mode-sync POST {enabled} keeps working.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
          if (method === 'POST') {
            readBody(req).then((raw) => {
              try {
                const d = JSON.parse(raw || '{}');
                if (d && typeof d.enabled === 'boolean') {
                  steerEnabled = d.enabled;
                  log('steerEnabled = ' + steerEnabled + ' (via client mode sync)');
                }
                if (d && Object.prototype.hasOwnProperty.call(d, 'maxContinuations')) {
                  const requested = Number(d.maxContinuations);
                  const next = sanitizeCap(d.maxContinuations);
                  if (next !== null) {
                    runtimeCap = next;
                    capVerdict = { requested, applied: next, accepted: next === requested };
                    log('maxContinuations = ' + runtimeCap + ' (via settings panel)');
                  } else {
                    // Unusable value: keep the running cap and say so out loud.
                    capVerdict = { requested, applied: runtimeCap, accepted: false };
                    log('maxContinuations rejected: ' + String(d.maxContinuations));
                  }
                }
              } catch (err) {
                log('mode sync parse error: ' + String(err));
              }
              respond(res, snapshot());
            });
            return;
          }
          respond(res, snapshot());
        }
      });
      hostCapable = true;
      log('registered route ' + ROUTE);
    } catch (err) {
      log('route registration failed: ' + String(err));
    }
  });

  // --- Loop mode: observe the assistant stream ----------------------------
  ctx.on(
    'agent/assistant-stream',
    ({ agent, frame }) => {
      const fr = frame || (agent && agent.frame) || null;
      if (!fr || typeof fr !== 'object') return;
      const chunk = fr.chunk || (fr.type === 'finish' ? fr : null) || null;
      if (!chunk || chunk.type !== 'finish') return; // only finish chunks matter

      const ag = resolveAgentFromFrame(ctx, fr, agent);
      if (!ag) {
        log('truncation seen but agent could not be resolved; client fallback may handle');
        return;
      }

      // v3.3: this handler is an OBSERVER ONLY. It records the finish category;
      // the actual continuation is queued by agent/turn-stopping (serial),
      // one fresh turn per truncated turn. Sending here (v3.2 steer) kept the
      // SAME turn open, which the core loop permanently latches as max-tokens.
      if (!isMaxTokens(chunk)) {
        const st0 = getState(ag);
        if (st0.chain) {
          const nf = normalizedFinish(chunk);
          st0.chainLastFinish = nf;
          // Any non-truncated, non-tool, non-error finish means the continued
          // content is complete. turn-stopping will then close the chain.
          // Tool-call / retry / error finishes keep the chain alive so we can
          // resume again if the step really ends at the token limit.
          if (nf !== 'tool-calls' && nf !== 'error' && nf !== 'aborted') st0.chainDone = true;
          return;
        }
        // No active chain and a clean finish: nothing to continue.
        return;
      }

      // De-dupe by the frame's attempt identity (each new step/attempt that
      // truncates is a DISTINCT truncation; only the same frame replay is
      // skipped). A fresh max-tokens marks the chain ACTIVE again.
      const fk = frameKey(fr, ag);
      if (wasHandled(ag, fk)) {
        log('agent ' + ag.id + ' attempt ' + fk + ' already handled; skip replay');
        return;
      }
      if (!providerOk(ag)) return;
      if (!steerEnabled) {
        log('agent ' + ag.id + ' machine continuation disabled (mode=off); skip');
        return;
      }

      const state = getState(ag);
      state.chain = true;
      state.chainDone = false;
      state.chainLastFinish = 'max-tokens';
      if (typeof fr.turn === 'number') state.chainTurn = fr.turn;
      markHandled(ag, fk);
      log('agent ' + ag.id + ' saw max-tokens (' + fk + '); turn-stopping will queue a fresh-turn continuation');
    },
    { global: true }
  );

  // --- v3.3: the ONLY place we queue a continuation -----------------------
  // agent/turn-stopping is a serial event fired by turn() right before it
  // breaks (turnEnds truthy && nextStep empty). We call agent.followup(),
  // which puts the continuation message in the NEXT-TURN inbox. turn()'s
  // finally then sees inbox.hasPending and returns true, so kick() starts a
  // FRESH turn: turnEnds resets to null, the model resumes with a full new
  // output budget, and the turn can end with reason=completed. This is the
  // machine equivalent of a human typing "继续", fully automatic.
  // A per-chain cap (maxContinuations) and a clean-finish flag prevent loops.
  // We return undefined so other serial listeners still run.
  ctx.on(
    'agent/turn-stopping',
    ({ agent, turn }) => {
      const ag = agent && (typeof agent.followup === 'function' || typeof agent.steer === 'function') ? agent : null;
      if (!ag) return;
      const s = getState(ag);
      if (!s.chain) return; // no active continuation chain for a truncated turn
      if (typeof turn === 'number') s.chainTurn = turn;
      if (s.chainDone) {
        // The continued output finished cleanly: the chain is complete.
        resetBudget(ag);
        return;
      }
      if (s.count >= cap() || !steerEnabled || !providerOk(ag)) {
        resetBudget(ag); // bounded / disabled: let the turn close
        return;
      }
      queueContinuation(ag, 'turn-stopping');
      // returning undefined => no bail; other serial listeners proceed
    },
    { global: true }
  );

  // Clean up loop state when an agent is disposed.
  // NOTE: the live host event is `agent/disposed` (asar signature:
  // 'agent/disposed'(payload: { agent: Agent })), NOT `agent/dispose`.
  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      clearState(agent);
    },
    { global: true }
  );

  log(
    'apply() done; maxContinuations=' +
      cap() +
      ', providers=' +
      (allProviders ? 'ALL' : [...providerSet].join(',')) +
      ', sourceKind=' +
      SOURCE_KIND
  );
}
