window.__ModuleLoader__.load({
  id: 'dsh-context-scale',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const STORAGE = {
      warn: 'dsh.context-scale.warnPct',
      compact: 'dsh.context-scale.compactPct',
    };

    function numberSetting(key, fallback) {
      try {
        const stored = Number(window.localStorage.getItem(key));
        if (Number.isFinite(stored) && stored >= 5 && stored <= 95) return stored;
      } catch (error) {
        /* ignore unavailable storage */
      }
      return fallback;
    }

    function persist(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch (error) {
        /* ignore unavailable storage */
      }
    }

    const CSS = `
.cg-root { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 2px;
  cursor: pointer; user-select: none; border-radius: 6px; outline: none; }
.cg-root:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.cg-track { position: relative; width: 92px; flex: 0 0 92px; height: 5px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); transition: box-shadow 200ms ease; }
.cg-warn .cg-track { box-shadow: 0 0 9px -1px var(--dsw-alias-state-warn-primary); }
.cg-compact .cg-track { box-shadow: 0 0 9px -1px var(--dsw-alias-state-error-primary); }
.cg-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
  background: var(--dsw-alias-brand-primary); transition: width 300ms ease, background 200ms ease; }
.cg-warn .cg-fill { background: var(--dsw-alias-state-warn-primary); }
.cg-compact .cg-fill { background: var(--dsw-alias-state-error-primary); }
.cg-mark { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 10px; height: 18px;
  display: flex; align-items: center; justify-content: center; background: transparent; border: 0;
  padding: 0; cursor: default; }
.cg-editing .cg-mark { cursor: col-resize; }
.cg-mark-bar { display: block; width: 2px; height: 11px; border-radius: 1px;
  transition: height 150ms ease, width 150ms ease; pointer-events: none; }
.cg-mark-warn .cg-mark-bar { background: var(--dsw-alias-state-warn-primary); }
.cg-mark-compact .cg-mark-bar { background: var(--dsw-alias-state-error-primary); }
.cg-root:hover .cg-mark-bar, .cg-editing .cg-mark-bar { height: 13px; width: 3px; }
.cg-live { min-width: 26px; font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
`;

    function ContextScale(props) {
      const sessionId = props && props.sessionId;
      const [snapshot, setSnapshot] = useState(null);
      const [warnPct, setWarnPct] = useState(() => numberSetting(STORAGE.warn, 55));
      const [compactPct, setCompactPct] = useState(() => numberSetting(STORAGE.compact, 80));
      const [editing, setEditing] = useState(false);
      const [dragging, setDragging] = useState(null);
      const rootRef = useRef(null);
      const trackRef = useRef(null);

      useEffect(() => {
        persist(STORAGE.warn, warnPct);
      }, [warnPct]);
      useEffect(() => {
        persist(STORAGE.compact, compactPct);
      }, [compactPct]);

      useEffect(() => {
        if (!sessionId) return undefined;
        let alive = true;
        const load = () => {
          const query = new URLSearchParams({
            s: String(sessionId),
            warn: String(warnPct),
            compact: String(compactPct),
          });
          fetch('/api/x-context-scale?' + query.toString(), { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
            .then((data) => {
              if (alive) setSnapshot({ ...data, error: null });
            })
            .catch((error) => {
              if (alive) setSnapshot((previous) => ({ ...(previous || {}), error: String(error) }));
            });
        };
        load();
        const timer = window.setInterval(load, 1500);
        const onVisible = () => {
          if (!document.hidden) load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          alive = false;
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [sessionId, warnPct, compactPct]);

      useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const track = trackRef.current;
          if (!track) return;
          const rect = track.getBoundingClientRect();
          if (!rect.width) return;
          const raw = ((event.clientX - rect.left) / rect.width) * 100;
          const value = Math.min(95, Math.max(5, Math.round(raw)));
          if (dragging === 'warn') setWarnPct(Math.min(value, compactPct - 5));
          else setCompactPct(Math.max(value, warnPct + 5));
        };
        const stop = () => setDragging(null);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
      }, [dragging, warnPct, compactPct]);

      useEffect(() => {
        if (!editing) return undefined;
        const down = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setEditing(false);
        };
        const key = (event) => {
          if (event.key === 'Escape') setEditing(false);
        };
        document.addEventListener('pointerdown', down, true);
        window.addEventListener('keydown', key);
        return () => {
          document.removeEventListener('pointerdown', down, true);
          window.removeEventListener('keydown', key);
        };
      }, [editing]);

      if (!sessionId) return null;

      const ratio = snapshot && typeof snapshot.ratio === 'number' ? snapshot.ratio : 0;
      const pct = Math.min(100, Math.max(0, ratio * 100));
      const level = pct >= compactPct ? 'compact' : pct >= warnPct ? 'warn' : 'ok';
      const liveValue = dragging === 'warn' ? warnPct : dragging === 'compact' ? compactPct : null;
      const title =
        'Контекст ' +
        Math.round(pct) +
        '% · предупреждение ' +
        warnPct +
        '% · автосжатие ' +
        compactPct +
        '%';
      const rootClass =
        'cg-root' + (level === 'warn' ? ' cg-warn' : level === 'compact' ? ' cg-compact' : '') + (editing ? ' cg-editing' : '');

      const mark = (kind, value, className, label) =>
        h(
          'div',
          {
            className: 'cg-mark ' + className,
            style: { left: value + '%' },
            role: 'slider',
            'aria-label': label,
            'aria-valuemin': 5,
            'aria-valuemax': 95,
            'aria-valuenow': value,
            title: label + ': ' + value + '%',
            onPointerDown: (event) => {
              if (!editing) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(kind);
            },
          },
          h('span', { className: 'cg-mark-bar' }),
        );

      return h(
        'div',
        {
          ref: rootRef,
          className: rootClass,
          role: 'button',
          tabIndex: 0,
          title,
          'aria-label': title + ' · нажмите, чтобы настроить',
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            setEditing(true);
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setEditing((value) => !value);
            }
          },
        },
        h('style', { key: 'cg-style' }, CSS),
        h(
          'div',
          { className: 'cg-track', ref: trackRef },
          h('div', { className: 'cg-fill', style: { width: pct + '%' } }),
          mark('warn', warnPct, 'cg-mark-warn', 'Порог предупреждения'),
          mark('compact', compactPct, 'cg-mark-compact', 'Порог автосжатия'),
        ),
        h('span', { className: 'cg-live' }, liveValue === null ? '' : liveValue + '%'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The shipped composer meter keeps its cell and its click panel; the
        // scale only adds its own ambient cell beside the shipped indicators.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'context-scale',
              order: 2,
            },
            ContextScale,
          ),
        );
      },
    };
  },
});
