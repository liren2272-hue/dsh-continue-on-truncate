// Client half of @local/dsh-continue-on-truncate (v3.4).
//
// v3.4 — honest reporting for the "连续续写次数" row: the settings card's
// Apply now always pushes to the host and lets the HOST VERDICT pick the copy
// ({ok:false} / clamped -> "not in effect", never "saved"). v3.3 could report
// a value as saved when the host never accepted it.
//
// What it does
// ------------
// DeepSeek Harness already shows a native "Output token limit reached" notice
// (slot key `turn-max-tokens`) when an answer is cut off by the output cap.
// This plugin ADDS an entry to the ADDITIVE list slot
// `conversation.chat.turnTail` (replaceRisk: "none", so it never shadows the
// shipped UI). That entry detects the truncation by scanning the turn's nodes
// for `turn-max-tokens`, shows a clearly-labeled status card, and offers a
// MANUAL "继续" button for the human.
//
// Human "继续" vs machine continuation (the whole point of v3)
// -----------------------------------------------------------
// The HOST half (`index.js`) is the real continuation driver: on a max-tokens
// finish it queues a FRESH TURN via `agent.followup()` (next-turn) with a
// NON-'user' source.kind, so the core loop opens a new turn (turnEnds resets)
// and the model resumes the truncated answer with its own output budget. The
// chat renders it as a distinct MACHINE "context/inject" node — never a human
// "继续" bubble — and re-arms per truncation so the 2nd/3rd truncation also
// continue. Because of that, this client half:
//   * NEVER auto-sends a fake human "继续" bubble when the host is active;
//   * re-probes the host on EVERY new truncation (no frozen one-shot latch);
//   * only falls back to sending "继续" itself on surfaces where the host half
//     is entirely absent (the host can't be reached at all);
//   * lets the user turn machine continuation OFF (mode "off"), which is synced
//     to the host via POST so a human "继续" is unambiguous.
//
// Dark mode (v3 fix): normal card text uses `--dsw-alias-label-primary`
// (light: #0f1115 / dark: #f9fafb), NOT `--dsw-alias-label-primary-foreground`
// (light: #fff / dark: #0f1115 — near-black, invisible on the dark card).
// `--dsw-radius-s` (a token that does not exist in DSH) is replaced by the real
// `--dsw-radius-sm`. The main button still pairs button-primary-fill with
// label-primary-foreground and never hardcodes a brand color.

window.__ModuleLoader__.load({
  id: '@local/dsh-continue-on-truncate',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef } = React;

    const NS = 'continue-on-truncate';
    const MODE_KEY = '@local/dsh-continue-on-truncate.mode';
    const MODE_EVENT = 'cot-mode-change';
    const CAP_KEY = '@local/dsh-continue-on-truncate.cap';
    const CAP_EVENT = 'cot-cap-change';
    const CAP_DEFAULT = 5;
    const CAP_MIN = 1;
    const CAP_MAX = 50;
    const CONTINUE_TEXT = '继续';
    const ROUTE = '/dsh-continue-on-truncate/host-active';

    const zh = {
      continue: '继续',
      auto: '自动续写',
      caption: '回答因达到输出上限被截断，已保留在对话中。',
      toggleAria: '切换自动续写',
      configTitle: '自动续写策略',
      configHint: '回答被输出上限截断时：',
      modeSilent: '系统自动续写（无感）',
      modeButton: '显示状态 + 手动「继续」按钮',
      modeOff: '关闭机器续写，仅手动「继续」',
      modeSilentHint: '由系统在后台以「机器续写」消息接着输出，不显示卡片，也不占用真人输入的「继续」。',
      modeButtonHint: '显示机器自动续写状态，并提供一个由你点击的手动「继续」按钮。',
      modeOffHint: '彻底关闭机器自动续写；只保留手动「继续」按钮，续写与否完全由你决定。',
      autoProgress: '正在自动续写…',
      autoDone: '已自动续写。',
      autoOffNote: '已发送「继续」。',
      hostActive: '系统正在自动续写…',
      hostHint: '已启用系统级无感续写。',
      machineBadge: '机器自动续写',
      manualBadge: '手动（真人）',
      capTitle: '连续续写次数',
      capHint: '一次截断后，系统最多自动续写多少个新回合（防止无限循环）。改动立即生效，并会记住。',
      capUnit: '回合',
      capApply: '应用',
      capSaved: '已保存到运行中的宿主',
      capPending: '已存本机；宿主未确认接收，尚未生效',
      capRejected: '宿主未接受该值，未生效',
      capClamped: '宿主只接受该范围内的值，已按',
      capRange: '可填 1–50',
      capInvalid: '请输入 1–50 的整数',
      capHostDefault: '宿主默认：',
      hostMachineNote: '系统已自动续写：这是一条机器消息，不是真人输入的「继续」。',
      hostAbsentNote: '未检测到系统级续写，请手动点击「继续」。',
      hostOffNote: '机器自动续写已关闭，请手动点击「继续」。'
    };
    const en = {
      continue: 'Continue',
      auto: 'Auto-continue',
      caption: 'The reply was truncated by the output limit and kept in the conversation.',
      toggleAria: 'Toggle auto-continue',
      configTitle: 'Auto-continue mode',
      configHint: 'When the reply is cut off by the output-token limit:',
      modeSilent: 'System auto-continue (silent)',
      modeButton: 'Show status + manual "Continue" button',
      modeOff: 'Machine auto-continue off, manual only',
      modeSilentHint: 'The system resumes in the background as a machine message; no card, and no human "Continue" is consumed.',
      modeButtonHint: 'Shows the machine auto-continue status and a manual "Continue" button you click yourself.',
      modeOffHint: 'Disables machine auto-continue entirely; only the manual "Continue" button remains.',
      autoProgress: 'Auto-continuing…',
      autoDone: 'Auto-continued.',
      autoOffNote: 'Sent "Continue".',
      hostActive: 'System is auto-continuing…',
      hostHint: 'System-level seamless continuation is active.',
      machineBadge: 'Auto (system)',
      manualBadge: 'Manual (you)',
      capTitle: 'Continuation limit',
      capHint: 'Max fresh turns the system auto-opens after one truncation (prevents infinite loops). Applies immediately and is remembered.',
      capUnit: 'turns',
      capApply: 'Apply',
      capSaved: 'Saved to the running host',
      capPending: 'Saved locally; the host did NOT confirm it — not in effect yet',
      capRejected: 'The host did not accept this value — not in effect',
      capClamped: 'The host accepts a narrower range only; applied',
      capRange: 'Range 1–50',
      capInvalid: 'Enter an integer 1–50',
      capHostDefault: 'Host default:',
      hostMachineNote: 'System auto-continued: this is a machine message, not a human "Continue".',
      hostAbsentNote: 'System-level continuation not detected — click "Continue" manually.',
      hostOffNote: 'Machine auto-continue is off — click "Continue" manually.'
    };

    function readMode() {
      try {
        const v = localStorage.getItem(MODE_KEY);
        return v === 'button' || v === 'off' ? v : 'silent';
      } catch {
        return 'silent';
      }
    }
    // v3.2: the user's continuation cap, persisted in localStorage. Always a
    // safe integer; nothing outside 1..50 is ever stored or sent to the host.
    function readCap() {
      try {
        const n = Number(localStorage.getItem(CAP_KEY));
        if (Number.isFinite(n) && n >= CAP_MIN) return Math.max(CAP_MIN, Math.min(CAP_MAX, Math.round(n)));
      } catch { /* ignore unavailable storage */ }
      return CAP_DEFAULT;
    }
    function writeCap(v) {
      try { localStorage.setItem(CAP_KEY, String(v)); } catch { /* ignore */ }
      try { window.dispatchEvent(new CustomEvent(CAP_EVENT, { detail: v })); } catch { /* ignore */ }
    }
    function subscribeCap(fn) {
      try {
        window.addEventListener(CAP_EVENT, fn);
        return () => window.removeEventListener(CAP_EVENT, fn);
      } catch { return () => {}; }
    }
    function writeMode(v) {
      try {
        localStorage.setItem(MODE_KEY, v);
      } catch {
        /* ignore unavailable storage */
      }
      setModeAttr(v);
      try {
        window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: v }));
      } catch {
        /* ignore unavailable event bus */
      }
    }
    function subscribeMode(fn) {
      try {
        window.addEventListener(MODE_EVENT, fn);
        return () => window.removeEventListener(MODE_EVENT, fn);
      } catch {
        return () => {};
      }
    }

    // v3.1: mirror the active mode onto <html data-cot-mode="..."> so the
    // global hint-rewrite stylesheet can gate itself without any DOM rewriting.
    function setModeAttr(v) {
      try {
        document.documentElement.setAttribute('data-cot-mode', v || readMode());
      } catch {
        /* ignore */
      }
    }

    // Best-effort host probe. Never throws; fails closed to "absent".
    function probeHost() {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 800);
        return fetch(ROUTE, { signal: ctrl.signal, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => ({
            active: !!(d && d.active),
            steeredRecently: !!(d && d.steeredRecently),
            steerCount: Number(d && d.steerCount) || 0,
            steerEnabled: !!(d && d.steerEnabled),
            version: (d && d.version) || '',
            maxContinuations: Number(d && d.maxContinuations) || 0,
            capMin: Number(d && d.capMin) || CAP_MIN,
            capMax: Number(d && d.capMax) || CAP_MAX
          }))
          .catch(() => ({ active: false, steeredRecently: false, steerCount: 0, steerEnabled: false, version: '', maxContinuations: 0, capMin: CAP_MIN, capMax: CAP_MAX }))
          .finally(() => clearTimeout(timer));
      } catch {
        return Promise.resolve({ active: false, steeredRecently: false, steerCount: 0, steerEnabled: false, version: '', maxContinuations: 0, capMin: CAP_MIN, capMax: CAP_MAX });
      }
    }

    // Sync the user's machine-continue preference to the host. "off" turns the
    // host steer OFF, so a human "继续" is the only continuation.
    function syncHostEnabled(enabled) {
      try {
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !!enabled }),
          cache: 'no-store'
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    }

    // v3.4: push the runtime continuation cap to the host. The result is an
    // OBJECT, never a bare number/null: the panel must be able to tell
    //   {ok:true, applied:n}  host accepted (n = the value the host really runs)
    //   {ok:false, applied:null} host unreachable / non-2xx / no cap field
    // apart, so a rejected value can never be reported as applied.
    function syncHostCap(value) {
      const failed = { ok: false, applied: null };
      try {
        return fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxContinuations: value }),
          cache: 'no-store'
        })
          .then((r) => (r && r.ok ? r.json() : null))
          .then((d) => {
            const applied = d && Number(d.maxContinuations);
            if (!applied || !Number.isFinite(applied)) return failed;
            return { ok: true, applied, accepted: d.capAccepted !== false };
          })
          .catch(() => failed);
      } catch {
        return Promise.resolve(failed);
      }
    }

    // All CSS uses only real --dsw-* tokens (with neutral fallbacks so the card
    // never collapses to invisible text if a token is absent in a theme).
    // NORMAL text -> --dsw-alias-label-primary; button text -> the foreground
    // token, paired with button-primary-fill (inverts across themes).
    const STYLE = `
.cot-root {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 6px; padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-sm, 8px);
}
.cot-caption {
  font-size: 12px; line-height: 1.3;
  color: var(--dsw-alias-state-warn-primary, currentColor);
}
.cot-spacer { flex: 1 1 auto; min-width: 8px; }
.cot-badge {
  font-size: 10px; font-weight: 600; letter-spacing: .02em;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
}
.cot-status {
  font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
.cot-btn {
  appearance: none; border: none; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 600;
  padding: 6px 14px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-button-primary-fill, currentColor);
  color: var(--dsw-alias-label-primary-foreground, CanvasText);
}
.cot-btn:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, currentColor)); }
.cot-btn:disabled { opacity: 0.55; cursor: default; }
.cot-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, currentColor); outline-offset: 2px; }
`;
    const CFG_STYLE = `
.cotcfg-root {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-sm, 8px);
}
.cotcfg-title {
  font-size: 13px; font-weight: 600;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.cotcfg-hint {
  font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
.cotcfg-opt {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 13px; cursor: pointer; user-select: none;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.cotcfg-opt input { margin-top: 2px; accent-color: var(--dsw-alias-state-business-primary, currentColor); cursor: pointer; }
.cotcfg-sub {
  display: block; margin-top: 2px;
  font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
.cotcfg-cap {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin-top: 2px; padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
}
.cotcfg-cap-label {
  font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.cotcfg-cap-hint {
  flex: 1 1 100%; order: 5;
  font-size: 11px; line-height: 1.4;
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
.cotcfg-cap-input {
  width: 64px; box-sizing: border-box;
  font: inherit; font-size: 13px; text-align: center;
  padding: 4px 6px; border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08));
  color: var(--dsw-alias-label-primary, CanvasText);
}
.cotcfg-cap-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, currentColor); outline-offset: 2px; }
.cotcfg-cap-unit { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9)); }
.cotcfg-cap-btn {
  appearance: none; border: none; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 600;
  padding: 5px 12px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-button-primary-fill, currentColor);
  color: var(--dsw-alias-label-primary-foreground, CanvasText);
}
.cotcfg-cap-btn:disabled { opacity: 0.55; cursor: default; }
.cotcfg-cap-status { font-size: 11px; color: var(--dsw-alias-state-business-primary, currentColor); }
.cotcfg-cap-status[data-cot-cap-error="true"] { color: var(--dsw-alias-state-warn-primary, currentColor); }
`;

    // v3.1 治标: rewrite the NATIVE "send 继续" hint. The core loop latches
    // turnEnds=max-tokens and writes turn/end reason=max-tokens no matter how
    // many fresh turns the host opens (asar 17285060), so DSH ALWAYS renders its native
    // "已达到输出 token 上限 / 发送「继续」可让模型接着输出" notice. A pure plugin
    // cannot change that reason, but we can hide the misleading "继续" line and
    // show an accurate "已自动续写" replacement -- as ONE static global
    // stylesheet, so every React re-render of a truncation node is covered
    // automatically (no MutationObserver needed).
    // Gated by html[data-cot-mode]: mode "off" keeps the native hint, because
    // there the user really does need to click 继续 manually.
    const HINT_STYLE = `
html[data-cot-mode="silent"] div[data-chat-flow-kind="turn-max-tokens"] [role="status"],
html[data-cot-mode="button"] div[data-chat-flow-kind="turn-max-tokens"] [role="status"] {
  display: none !important;
}
html[data-cot-mode="silent"] div[data-chat-flow-kind="turn-max-tokens"]::after,
html[data-cot-mode="button"] div[data-chat-flow-kind="turn-max-tokens"]::after {
  content: "已自动续写：系统已自动接着输出被截断的内容，无需手动发送「继续」。";
  display: block;
  box-sizing: border-box;
  margin: 4px 0 2px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08));
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
  font-size: 12px;
  line-height: 1.4;
}
html:lang(en)[data-cot-mode="silent"] div[data-chat-flow-kind="turn-max-tokens"]::after,
html:lang(en)[data-cot-mode="button"] div[data-chat-flow-kind="turn-max-tokens"]::after {
  content: "Auto-continued: the system automatically resumed the truncated reply; no manual Continue is needed.";
}
/* Defensive fallback for builds whose wrapper lacks data-chat-flow-kind. */
html[data-cot-mode="silent"] div[role="status"]:has([class*="maxTokensTitle"]),
html[data-cot-mode="button"] div[role="status"]:has([class*="maxTokensTitle"]) {
  display: none !important;
}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries');
        const t = ctx.locale.bind(NS);

        // v3.1: global hint-rewrite stylesheet + html[data-cot-mode] gate.
        // Injected once at apply() (HMR-safe: remove any prior copy first).
        try {
          const doc = document;
          const prev = doc.querySelector('style[data-cot="native-hint-rewrite"]');
          if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
          const styleEl = doc.createElement('style');
          styleEl.setAttribute('data-cot', 'native-hint-rewrite');
          styleEl.textContent = HINT_STYLE;
          (doc.head || doc.documentElement).appendChild(styleEl);
        } catch {
          /* ignore */
        }
        setModeAttr(readMode());

        // Global mode -> host sync + <html data-cot-mode> mirror, always active
        // (not tied to a turn card being mounted, so changing the mode in
        // Settings takes effect immediately, including the hint rewrite).
        try {
          syncHostEnabled(readMode() !== 'off');
          // v3.2: restore the user's saved cap to the running host on every
          // apply()/page-load, so it survives a host restart and takes effect
          // even if the settings panel is never opened. An old host simply
          // ignores the cap field (its POST still accepts {enabled}); harmless.
          syncHostCap(readCap());
          const onMode = (e) => {
            const v = e && e.detail ? e.detail : readMode();
            setModeAttr(v);
            syncHostEnabled(v !== 'off');
          };
          window.addEventListener(MODE_EVENT, onMode);
          window.addEventListener('storage', (e) => {
            if (!e || e.key === MODE_KEY) {
              const v = readMode();
              setModeAttr(v);
              syncHostEnabled(v !== 'off');
            }
          });
        } catch {
          /* ignore */
        }

        // Resolve the conversation service lazily. At apply() time the service
        // may not be registered yet; capturing it once (the v2 bug) left it
        // undefined forever. ctx.get() is the safe accessor.
        function getConversation() {
          try {
            const c = ctx.get ? ctx.get('conversation') : undefined;
            return c && typeof c.send === 'function' ? c : null;
          } catch {
            return null;
          }
        }

        function ContinueOnTruncate({ turn, useChat, inputActions }) {
          const [mode, setMode] = useState(() => readMode());
          const [sent, setSent] = useState(false);
          const [host, setHost] = useState({ active: false, steeredRecently: false, steerCount: 0, steerEnabled: false });
          const [hostChecked, setHostChecked] = useState(false);
          const sentRef = useRef(false);
          const genRef = useRef('');
          const submitTimer = useRef(null);

          // A stable signature of the truncation nodes in this turn. A NEW
          // `turn-max-tokens` node = a NEW truncation -> re-arm everything.
          const truncSig = useChat((snapshot) => {
            if (!snapshot || !snapshot.locations || turn === undefined) return '';
            const keys = snapshot.locations.getTurn(turn);
            const ids = [];
            for (let i = 0; i < keys.length; i++) {
              const node = snapshot.nodes.get(keys[i]);
              if (node && node.kind === 'turn-max-tokens') ids.push(String(keys[i]));
            }
            return ids.sort().join('|');
          });
          const isTruncated = truncSig.length > 0;

          const isLast = useChat((snapshot) => {
            const order = snapshot && snapshot.timeline && snapshot.timeline.turnOrder;
            if (!order || order.length === 0) return false;
            return order[order.length - 1] === turn;
          });

          // Mode changes (from the config card) propagate to mounted turn cards.
          useEffect(() => subscribeMode((e) => setMode(e && e.detail ? e.detail : readMode())), []);

          // Probe the host on EVERY new truncation (and once on mount). v2
          // probed once and froze the result — that is why the 2nd truncation
          // was never handled. Re-probing keeps the suppression decision fresh.
          useEffect(() => {
            let alive = true;
            probeHost().then((h) => {
              if (!alive) return;
              setHost(h);
              setHostChecked(true);
            });
            return () => {
              alive = false;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [truncSig]);

          // Re-arm the one-shot latch on each NEW truncation generation.
          useEffect(() => {
            if (!truncSig || truncSig === genRef.current) return;
            genRef.current = truncSig;
            sentRef.current = false;
            setSent(false);
          }, [truncSig]);

          // A manual "继续" is ALWAYS an explicit human action. No auto path
          // ever calls this except the host-absent last-resort fallback below.
          function doSend() {
            if (sentRef.current) return;
            sentRef.current = true;
            setSent(true);
            const conversation = getConversation();
            try {
              if (conversation) {
                const p = conversation.send(CONTINUE_TEXT);
                if (p && typeof p.catch === 'function') p.catch(() => {});
                return;
              }
            } catch {
              /* fall through to inputActions */
            }
            try {
              if (inputActions) {
                inputActions.setDraft(CONTINUE_TEXT);
                submitTimer.current = setTimeout(() => {
                  try {
                    inputActions.submit();
                  } catch {
                    /* ignore */
                  }
                }, 80);
              }
            } catch {
              /* ignore */
            }
          }

          // The client auto-sends "继续" ONLY as a last resort when the host
          // half is entirely absent. When the host is active, its machine-
          // labeled followup (fresh turn) is the continuation — the client must
          // never inject a second (human-looking) "继续" bubble.
          const clientFallback = !host.active && (mode === 'silent' || mode === 'button');

          useEffect(() => {
            if (!isTruncated || !isLast || !clientFallback || !hostChecked || sentRef.current) return;
            const delay = mode === 'silent' ? 1000 : 1200;
            const t1 = setTimeout(async () => {
              const h = await probeHost(); // fresh probe at fire time
              if (h.active) {
                setHost(h); // host took over -> suppress the fallback
                return;
              }
              doSend();
            }, delay);
            return () => clearTimeout(t1);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [isTruncated, isLast, clientFallback, hostChecked, mode, truncSig]);

          useEffect(() => () => {
            if (submitTimer.current) clearTimeout(submitTimer.current);
          }, []);

          if (!isTruncated) return null;
          if (mode === 'silent') return null; // seamless: no UI at all

          const manualBtn = React.createElement(
            'button',
            {
              type: 'button',
              className: 'cot-btn',
              'data-cot': 'continue',
              disabled: sent,
              onClick: doSend
            },
            t('continue')
          );

          const badge = React.createElement(
            'span',
            {
              className: 'cot-badge',
              'data-cot': mode === 'off' ? 'badge-manual' : 'badge-machine'
            },
            mode === 'off' ? t('manualBadge') : t('machineBadge')
          );

          const statusKey = !host.active
            ? 'hostAbsentNote'
            : mode === 'off'
              ? 'hostOffNote'
              : host.steeredRecently
                ? 'hostActive'
                : 'hostMachineNote';

          return React.createElement(
            React.Fragment,
            null,
            React.createElement('style', null, STYLE),
            React.createElement(
              'div',
              { className: 'cot-root', 'data-cot': 'root' },
              React.createElement('span', { className: 'cot-caption' }, t('caption')),
              React.createElement('span', { className: 'cot-spacer' }),
              badge,
              React.createElement(
                'span',
                { className: 'cot-status', 'data-cot': 'status' },
                t(statusKey)
              ),
              mode === 'button' || mode === 'off' ? manualBtn : null,
              sent
                ? React.createElement('span', { className: 'cot-status' }, t('autoOffNote'))
                : null
            )
          );
        }

        // Config card (registered on `plugins.bundle.config`, keyed by package
        // id). Self-contained: reads/writes the same localStorage mode.
        function ModeSettings() {
          const [mode, setMode] = useState(() => readMode());
          const [capText, setCapText] = useState(() => String(readCap()));
          const [capStatus, setCapStatus] = useState('');
          const [capError, setCapError] = useState(false);
          const [hostCap, setHostCap] = useState(0);
          // hostLegacy = the route answered but reports NO maxContinuations (a
          // pre-3.4 host): it can never accept the cap, only ignore it. Kept
          // separate from "unreachable" so the copy can stay honest about which.
          const [hostLegacy, setHostLegacy] = useState(false);
          const [saving, setSaving] = useState(false);
          useEffect(() => subscribeMode((e) => setMode(e && e.detail ? e.detail : readMode())), []);

          // On mount: read the host's live cap (proves the setting really reaches
          // the running host) and push the user's saved value to it.
          useEffect(() => {
            let alive = true;
            probeHost().then((h) => {
              if (!alive) return;
              // A host that answers the probe but reports no maxContinuations
              // (pre-3.4 build) can only IGNORE the cap, never accept it. Record
              // that so the copy says "local only" instead of "saved".
              const live = !!(h.active && h.maxContinuations);
              setHostLegacy(!!h.active && !h.maxContinuations);
              if (live) setHostCap(h.maxContinuations);
              const v = readCap();
              setCapText(String(v));
              if (live) {
                syncHostCap(v).then((res) => {
                  if (!alive || !res || !res.ok) return;
                  setHostCap(res.applied);
                });
              }
            });
            return () => { alive = false; };
          }, []);

          useEffect(() => subscribeCap((e) => {
            const v = e && Number(e.detail) ? Number(e.detail) : readCap();
            setCapText(String(v));
          }), []);

          function applyCap() {
            const n = Number(capText);
            if (!Number.isFinite(n) || n < CAP_MIN || n > CAP_MAX || Math.round(n) !== n) {
              setCapError(true);
              setCapStatus(t('capInvalid'));
              return;
            }
            setSaving(true);
            setCapError(false);
            setCapStatus('');
            const v = Math.round(n);
            writeCap(v); // remember locally first; the host verdict decides the copy
            // v3.4: ALWAYS try the host and let its answer decide the message.
            // No local-only "success" path: an unreachable or refusing host must
            // never be reported as applied.
            syncHostCap(v).then((res) => {
              setSaving(false);
              if (res && res.ok) {
                setHostCap(res.applied);
                setCapText(String(res.applied));
                if (res.applied === v && res.accepted !== false) {
                  setCapError(false);
                  setCapStatus(t('capSaved'));
                } else {
                  // Host clamped to its own bounds: show what it actually runs.
                  setCapError(true);
                  setCapStatus(t('capClamped') + ' ' + res.applied + ' ' + t('capUnit'));
                }
                return;
              }
              setCapError(true);
              // Old host: value lives only on this machine. Unreachable/refusing
              // host: nothing took effect. Neither one may claim success.
              setCapStatus(hostLegacy ? t('capPending') : t('capRejected'));
            });
          }

          const options = [
            ['silent', 'modeSilent', 'modeSilentHint'],
            ['button', 'modeButton', 'modeButtonHint'],
            ['off', 'modeOff', 'modeOffHint']
          ];
          const capRow = React.createElement(
            'div',
            { className: 'cotcfg-cap', 'data-cot': 'cap' },
            React.createElement('span', { className: 'cotcfg-cap-label' }, t('capTitle')),
            React.createElement('input', {
              type: 'number', min: CAP_MIN, max: CAP_MAX, step: 1,
              className: 'cotcfg-cap-input', 'data-cot': 'cap-input',
              value: capText,
              onChange: (e) => { setCapText(e && e.target ? e.target.value : ''); setCapStatus(''); setCapError(false); },
              onKeyDown: (e) => { if (e && e.key === 'Enter') applyCap(); }
            }),
            React.createElement('span', { className: 'cotcfg-cap-unit' }, t('capUnit')),
            React.createElement(
              'button',
              { type: 'button', className: 'cotcfg-cap-btn', 'data-cot': 'cap-apply', disabled: saving, onClick: applyCap },
              t('capApply')
            ),
            React.createElement(
              'span',
              { className: 'cotcfg-cap-status', 'data-cot': 'cap-status', 'data-cot-cap-error': capError ? 'true' : 'false' },
              capStatus || (t('capRange') + (hostCap ? ' · ' + t('capHostDefault') + hostCap : ''))
            ),
            React.createElement('span', { className: 'cotcfg-cap-hint' }, t('capHint'))
          );

          return React.createElement(
            React.Fragment,
            null,
            React.createElement('style', null, CFG_STYLE),
            React.createElement(
              'div',
              { className: 'cotcfg-root', 'data-cot': 'config' },
              React.createElement('div', { className: 'cotcfg-title' }, t('configTitle')),
              React.createElement('div', { className: 'cotcfg-hint' }, t('configHint')),
              ...options.map(([value, labelKey, subKey]) =>
                React.createElement(
                  'label',
                  { key: value, className: 'cotcfg-opt' },
                  React.createElement('input', {
                    type: 'radio',
                    name: 'cot-mode',
                    checked: mode === value,
                    onChange: () => {
                      setMode(value);
                      writeMode(value);
                    }
                  }),
                  React.createElement(
                    'span',
                    null,
                    t(labelKey),
                    React.createElement('span', { className: 'cotcfg-sub' }, t(subKey))
                  )
                )
              ),
              capRow
            )
          );
        }

        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: '@local/dsh-continue-on-truncate',
              order: 100,
              locale: NS
            },
            ContinueOnTruncate
          )
        );

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: '@local/dsh-continue-on-truncate',
              locale: NS
            },
            ModeSettings
          )
        );
      }
    };
  }
});
