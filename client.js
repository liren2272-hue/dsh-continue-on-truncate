// Client half of @local/dsh-continue-on-truncate (v2).
//
// What it does
// ------------
// DeepSeek Harness already shows a native "Output token limit reached" notice
// (slot key `turn-max-tokens`) when an answer is cut off by the output cap, and
// it keeps the already-produced text in the conversation. This plugin ADDS an
// entry to the ADDITIVE list slot `conversation.chat.turnTail` (replaceRisk:
// "none", so it can never shadow the shipped UI). That entry:
//   1. detects the truncation by scanning the turn's nodes for `turn-max-tokens`,
//   2. (button / off modes) shows a localized "继续 / Continue" button, and
//   3. auto-sends "继续" after a short delay — UNLESS the host half already
//      handled the truncation seamlessly.
//
// Host half vs client half (no double-fire)
// ----------------------------------------
// The HOST half (`index.js`) is the premium path: at the agent layer it observes
// the `agent/assistant-stream` finish frame and, on `max-tokens`, calls
// `agent.steer()` to continue as the NEXT STEP of the SAME turn — no extra
// "继续" bubble. When the host half is active it exposes
// GET /dsh-continue-on-truncate/host-active. This client half probes that route
// on mount: if the host already handled the truncation, it STOPS its own
// (bubble-producing) auto-send and only shows a passive "系统正在自动续写…"
// status, so the two halves never trigger two continuations.
//
// If the host half is absent or unreachable (e.g. a non-web surface), the
// client half falls back to sending "继续" itself via the conversation service
// (no input-box flash), still automatically.

window.__ModuleLoader__.load({
  id: '@local/dsh-continue-on-truncate',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef } = React;

    const NS = 'continue-on-truncate';
    const MODE_KEY = '@local/dsh-continue-on-truncate.mode';
    const CONTINUE_TEXT = '继续';
    const HOST_ACTIVE_URL = '/dsh-continue-on-truncate/host-active';

    const zh = {
      continue: '继续',
      auto: '自动继续',
      caption: '回答因达到输出上限被截断，已保留在对话中。',
      toggleAria: '切换自动继续',
      configTitle: '自动续写策略',
      configHint: '系统自动识别「输出已达上限」时：',
      modeSilent: '系统自动续写（无感，不打扰）',
      modeButton: '显示状态并自动续写',
      modeOff: '仅显示按钮，手动续写',
      modeSilentHint: '截断一旦发生，系统自动发送「继续」并接着输出，界面上只多一条「继续」消息。',
      modeButtonHint: '显示自动续写状态与按钮，并自动续写。',
      modeOffHint: '只显示按钮，由你决定是否续写。',
      autoProgress: '正在自动续写…',
      autoDone: '已自动发送「继续」，模型正在接着输出。',
      autoOffNote: '已发送「继续」。',
      hostActive: '系统正在自动续写…',
      hostHint: '已启用系统级无感续写（无需手动操作）。'
    };
    const en = {
      continue: 'Continue',
      auto: 'Auto-continue',
      caption: 'The reply was truncated by the output limit and kept in the conversation.',
      toggleAria: 'Toggle auto-continue',
      configTitle: 'Auto-continue mode',
      configHint: 'When the system detects "output limit reached":',
      modeSilent: 'System auto-continue (silent, no UI)',
      modeButton: 'Show status & auto',
      modeOff: 'Button only, manual',
      modeSilentHint: 'Automatically sends "continue" and keeps outputting; only a "continue" message appears.',
      modeButtonHint: 'Shows the auto-continue status and button, and continues automatically.',
      modeOffHint: 'Shows a button; you decide when to continue.',
      autoProgress: 'Auto-continuing…',
      autoDone: 'Sent "continue"; the model is resuming.',
      autoOffNote: 'Sent "continue".',
      hostActive: 'System is auto-continuing…',
      hostHint: 'System-level seamless continuation is active (no manual action needed).'
    };

    function readMode() {
      try {
        const v = localStorage.getItem(MODE_KEY);
        return v === 'button' || v === 'off' ? v : 'silent';
      } catch {
        return 'silent';
      }
    }
    function writeMode(v) {
      try {
        localStorage.setItem(MODE_KEY, v);
      } catch {
        /* ignore unavailable storage */
      }
    }

    // Best-effort probe: did the host half JUST steer THIS truncation? The host
    // exposes `{ active: hostPresent, steeredRecently: hostSteeredThisTurn }`.
    // We only care about `steeredRecently` — the host may be present but its
    // listener never fire (agent-local dispatch), in which case the client must
    // still auto-send. Fails closed → false (client fallback engages).
    function checkHostSteered() {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 600);
        return fetch(HOST_ACTIVE_URL, { signal: ctrl.signal, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => !!(d && d.steeredRecently === true))
          .catch(() => false)
          .finally(() => clearTimeout(timer));
      } catch {
        return Promise.resolve(false);
      }
    }

    // All CSS uses only real --dsw-alias-* tokens (with safe fallbacks so the
    // card never collapses to invisible text if a token is absent in a theme).
    const STYLE = `
.cot-root {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 6px; padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-s, 8px);
}
.cot-caption {
  font-size: 12px; line-height: 1.3;
  color: var(--dsw-alias-state-warn-primary, #c47f1a);
}
.cot-spacer { flex: 1 1 auto; min-width: 8px; }
.cot-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
  cursor: pointer; user-select: none;
}
.cot-toggle input { accent-color: var(--dsw-alias-state-business-primary, #5686fe); cursor: pointer; }
.cot-btn {
  appearance: none; border: none; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 600;
  padding: 6px 14px; border-radius: var(--dsw-radius-s, 8px);
  background: var(--dsw-alias-button-primary-fill, currentColor);
  color: var(--dsw-alias-label-primary-foreground, CanvasText);
}
.cot-btn:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, currentColor)); }
.cot-btn:disabled { opacity: 0.55; cursor: default; }
.cot-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #5686fe); outline-offset: 2px; }
.cot-status {
  font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
`;
    const CFG_STYLE = `
.cotcfg-root {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18));
  border-radius: var(--dsw-radius-s, 8px);
}
.cotcfg-title {
  font-size: 13px; font-weight: 600;
  color: var(--dsw-alias-label-primary-foreground, CanvasText);
}
.cotcfg-hint {
  font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
.cotcfg-opt {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 13px; cursor: pointer; user-select: none;
  color: var(--dsw-alias-label-primary-foreground, CanvasText);
}
.cotcfg-opt input { margin-top: 2px; accent-color: var(--dsw-alias-state-business-primary, #5686fe); cursor: pointer; }
.cotcfg-sub {
  display: block; margin-top: 2px;
  font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,0.9));
}
`;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'continue-on-truncate: dictionaries');
        const t = ctx.locale.bind(NS);

        // Capture the conversation SERVICE (with .send) if it is available in
        // this client context. Access is via ctx.get?.() so a missing service
        // never triggers the fatal "without inject" proxy trap.
        const conversation = ctx.get ? ctx.get('conversation') : undefined;

        function ContinueOnTruncate({ turn, useChat, inputActions }) {
          const [mode, setMode] = useState(() => readMode());
          const [sent, setSent] = useState(false);
          const [hostSteered, setHostSteered] = useState(false);
          const [hostChecked, setHostChecked] = useState(false);
          const sentRef = useRef(false);
          const submitTimer = useRef(null);

          // This turn was cut off by the output cap? (native `turn-max-tokens`
          // node only exists for such turns). `turn` is the same TurnLocation the
          // Chat bundle itself passes to lastContent(), so the query is faithful.
          const isTruncated = useChat((snapshot) => {
            if (!snapshot || !snapshot.locations || turn === undefined) return false;
            const keys = snapshot.locations.getTurn(turn);
            for (let i = 0; i < keys.length; i++) {
              const node = snapshot.nodes.get(keys[i]);
              if (node && node.kind === 'turn-max-tokens') return true;
            }
            return false;
          });

          // Only the MOST RECENT turn may auto-fire. This prevents the plugin
          // from injecting "继续" into a long-finished historical turn just
          // because it got scrolled into view or the session was reopened.
          const isLast = useChat((snapshot) => {
            const order = snapshot && snapshot.timeline && snapshot.timeline.turnOrder;
            if (!order || order.length === 0) return false;
            return order[order.length - 1] === turn;
          });

          // Ask the host half whether IT already steered THIS truncation.
          // If it did, the client must NOT also send "继续" (avoids a double
          // continuation). If the host is merely present but silent, the client
          // still auto-sends. Re-checked whenever the truncation flag flips.
          // `hostChecked` becomes true only after the probe resolves, so the
          // auto-send effect cannot fire (and double-continue) before we know.
          useEffect(() => {
            if (!isTruncated) return;
            let alive = true;
            checkHostSteered().then((steered) => {
              if (!alive) return;
              setHostSteered(steered);
              setHostChecked(true);
            });
            return () => {
              alive = false;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [isTruncated]);

          // Send "继续": prefer the conversation service (no input-box flash);
          // fall back to inputActions (setDraft + submit) if it is missing.
          function doSend() {
            if (sentRef.current) return;
            sentRef.current = true;
            setSent(true);
            try {
              if (conversation && typeof conversation.send === 'function') {
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

          // Client auto-continue only fires when the host half did NOT already
          // steer this truncation (otherwise the host's steer is the continuation).
          const clientAuto = (mode === 'silent' || mode === 'button') && !hostSteered;

          // Auto-continue: fire once shortly after the truncated turn renders,
          // but ONLY once we know the host didn't already steer it (hostChecked).
          useEffect(() => {
            if (!isTruncated || !isLast || !clientAuto || !hostChecked || sentRef.current) return;
            const delay = mode === 'silent' ? 1000 : 1200;
            const t1 = setTimeout(() => doSend(), delay);
            return () => clearTimeout(t1);
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [isTruncated, isLast, clientAuto, hostChecked, mode]);

          // Clear any pending fallback submit timer on unmount.
          useEffect(() => () => {
            if (submitTimer.current) clearTimeout(submitTimer.current);
          }, []);

          if (!isTruncated) return null;

          // ---- Host already steered it seamlessly: passive status only -------
          if (hostSteered) {
            if (mode === 'silent') return null; // host continuation is invisible
            return React.createElement(
              React.Fragment,
              null,
              React.createElement('style', null, STYLE),
              React.createElement(
                'div',
                { className: 'cot-root', 'data-cot': 'root' },
                React.createElement('span', { className: 'cot-caption' }, t('caption')),
                React.createElement('span', { className: 'cot-spacer' }),
                React.createElement(
                  'span',
                  { className: 'cot-status', 'data-cot': 'host-status' },
                  t('hostActive')
                )
              )
            );
          }

          // ---- Host not active: client fallback (bubble-based auto) ---------
          if (mode === 'silent') return null; // seamless: render nothing

          const handleContinue = () => doSend();
          const handleToggle = () => {
            const nv = mode === 'button' ? 'off' : 'button';
            setMode(nv);
            writeMode(nv);
          };

          return React.createElement(
            React.Fragment,
            null,
            React.createElement('style', null, STYLE),
            React.createElement(
              'div',
              { className: 'cot-root', 'data-cot': 'root' },
              React.createElement('span', { className: 'cot-caption' }, t('caption')),
              React.createElement('span', { className: 'cot-spacer' }),
              mode === 'button'
                ? React.createElement(
                    'label',
                    { className: 'cot-toggle' },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: true,
                      'aria-label': t('toggleAria'),
                      onChange: handleToggle
                    }),
                    t('auto')
                  )
                : null,
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'cot-btn',
                  'data-cot': 'continue',
                  disabled: sent,
                  onClick: handleContinue
                },
                t('continue')
              ),
              sent
                ? React.createElement(
                    'span',
                    { className: 'cot-status', 'data-cot': 'auto-status' },
                    clientAuto ? t('autoDone') : t('autoOffNote')
                  )
                : null
            )
          );
        }

        // Config card (registered on `plugins.bundle.config`, keyed by package
        // id). Fully self-contained: reads/writes the same localStorage mode and
        // needs no host-owned ConfigPageForm shape. Renders nothing dependent on
        // unknown props.
        function ModeSettings() {
          const [mode, setMode] = useState(() => readMode());
          const options = [
            ['silent', 'modeSilent', 'modeSilentHint'],
            ['button', 'modeButton', 'modeButtonHint'],
            ['off', 'modeOff', 'modeOffHint']
          ];
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
              )
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
