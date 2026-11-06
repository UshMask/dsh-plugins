window.__ModuleLoader__.load({
  id: 'dsh-token-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    // Official DeepSeek V4.1 Flash prices, USD per 1M tokens (api-docs.deepseek.com).
    // Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday (Chinese holidays apart).
    const PRICES = {
      peak: { hit: 0.006, miss: 0.3, out: 1.2 },
      offPeak: { hit: 0.003, miss: 0.15, out: 0.6 },
    };
    const RUB_RATE = 90;
    const SYMBOL = '₽';

    function isPeakNow() {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) return false;
      const hour = now.getUTCHours();
      return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value >= 1000000) return (value / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
      if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(Math.round(value));
    }

    function formatMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      let text;
      if (value >= 100) text = Math.round(value).toLocaleString('ru-RU');
      else if (value >= 1) text = value.toFixed(2);
      else if (value >= 0.01) text = value.toFixed(3);
      else text = value.toFixed(4);
      return SYMBOL + text;
    }

    const NOTES = {
      hit: 'Доля входных токенов, которые модель уже видела: чем выше, тем дешевле каждый следующий запрос.',
      cached: 'Текст из прошлых запросов, попавший в кэш модели. Тариф кэш-хита в разы ниже обычного ввода.',
      uncached: 'Новый текст, который модель читает впервые (включая запись в кэш). Тариф обычного ввода.',
      output: 'Сгенерированные моделью ответы и рассуждения. Самый дорогой тариф.',
    };

    const CSS = `
[data-composer-stat="usage"] { display: none !important; }
.tc-root { position: relative; display: inline-flex; align-items: center; height: 22px; padding: 0 2px;
  cursor: pointer; user-select: none; border-radius: 6px; outline: none; }
.tc-root:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.tc-pill { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px;
  border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tc-root:hover .tc-pill { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.tc-mark { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px;
  border-radius: 50%; border: 1px solid currentColor; font-size: 9px; font-weight: 700; font-style: normal;
  opacity: 0.75; flex: none; }
.tc-cost { font-weight: 600; color: var(--dsw-alias-label-primary); }
.tc-panel { position: absolute; right: 0; bottom: calc(100% + 8px); width: 400px;
  max-width: calc(100vw - 32px); z-index: 60; padding: 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4; display: grid; gap: 6px;
  cursor: default; }
.tc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  color: var(--dsw-alias-label-primary); font-size: 11px; font-weight: 600; margin-bottom: 2px; }
.tc-row { display: flex; align-items: baseline; gap: 8px; }
.tc-row-name { flex: 0 0 auto; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.tc-formula { flex: 1 1 auto; text-align: right; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.tc-formula b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.tc-info { position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--dsw-alias-label-secondary);
  font-size: 9px; font-style: normal; font-weight: 700; opacity: 0.55; cursor: help; }
.tc-info:hover { opacity: 1; }
.tc-tip { display: none; position: absolute; right: 0; bottom: calc(100% + 6px); width: 210px;
  padding: 7px 9px; border-radius: 8px; background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary);
  font-size: 10px; line-height: 1.4; white-space: normal; cursor: default; z-index: 70; }
.tc-info:hover .tc-tip, .tc-info:focus .tc-tip { display: block; }
.tc-money { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; padding-top: 7px;
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.tc-total-cost { font-weight: 600; color: var(--dsw-alias-label-primary); }
.tc-hint { opacity: 0.65; font-size: 10px; margin-top: 2px; }
`;

    function TokenCost(props) {
      const sessionId = props && props.sessionId;
      const useProjection = props && props.useProjection;
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      const panelRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const down = (event) => {
          const root = rootRef.current;
          const panel = panelRef.current;
          if (root && root.contains(event.target)) return;
          if (panel && panel.contains(event.target)) return;
          setOpen(false);
        };
        const key = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', down, true);
        window.addEventListener('keydown', key);
        return () => {
          document.removeEventListener('pointerdown', down, true);
          window.removeEventListener('keydown', key);
        };
      }, [open]);

      if (!sessionId) return null;

      let usage = null;
      try {
        usage = useProjection ? useProjection('tokenUsage') : null;
      } catch (error) {
        usage = null;
      }

      const peak = isPeakNow();
      const prices = peak ? PRICES.peak : PRICES.offPeak;
      const priceHit = prices.hit * RUB_RATE;
      const priceMiss = prices.miss * RUB_RATE;
      const priceOut = prices.out * RUB_RATE;

      const cached = usage ? usage.cacheReadTokens || 0 : 0;
      const uncached = usage ? (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0) : 0;
      const output = usage ? usage.outputTokens || 0 : 0;
      const billedInput = cached + uncached;
      const total = billedInput + output;
      const hit = billedInput > 0 ? cached / billedInput : null;
      const costCached = (cached / 1e6) * priceHit;
      const costUncached = (uncached / 1e6) * priceMiss;
      const costOutput = (output / 1e6) * priceOut;
      const cost = costCached + costUncached + costOutput;
      const hasUsage = usage !== undefined && usage !== null && total > 0;

      const info = (note, key) =>
        h(
          'span',
          { className: 'tc-info', tabIndex: 0, 'aria-label': note, key },
          'i',
          h('span', { className: 'tc-tip' }, note),
        );

      const row = (name, tokens, price, costValue, note, key) =>
        h(
          'div',
          { className: 'tc-row', key },
          h('span', { className: 'tc-row-name' }, name),
          h(
            'span',
            { className: 'tc-formula' },
            formatTokens(tokens) + ' ток × ' + formatMoney(price) + ' / 1М = ',
            h('b', null, formatMoney(costValue)),
          ),
          info(note, key + '-i'),
        );

      const panel = open
        ? h(
            'div',
            { className: 'tc-panel', ref: panelRef },
            h(
              'div',
              { className: 'tc-head' },
              h('span', null, 'Расход токенов'),
              h('span', null, formatTokens(total) + ' ток'),
            ),
            h(
              'div',
              { className: 'tc-row' },
              h('span', { className: 'tc-row-name' }, 'Попадание в кэш'),
              h('span', { className: 'tc-formula' }, hit === null ? '—' : (hit * 100).toFixed(1) + '%'),
              info(NOTES.hit, 'hit-i'),
            ),
            row('Кэшированный ввод', cached, priceHit, costCached, NOTES.cached, 'cached'),
            row('Некэшированный ввод', uncached, priceMiss, costUncached, NOTES.uncached, 'uncached'),
            row('Выход', output, priceOut, costOutput, NOTES.output, 'output'),
            h(
              'div',
              { className: 'tc-money' },
              h('span', { className: 'tc-total-cost' }, 'Итого'),
              h('span', { className: 'tc-total-cost' }, formatMoney(cost)),
            ),
            h(
              'div',
              { className: 'tc-hint' },
              'DeepSeek V4.1 Flash, ' +
                (peak ? 'пик' : 'оффпик') +
                ': кэш $' +
                prices.hit +
                ' / ввод $' +
                prices.miss +
                ' / выход $' +
                prices.out +
                ' за 1M; курс ₽' +
                RUB_RATE +
                '/$.',
            ),
          )
        : null;

      return h(
        'div',
        {
          ref: rootRef,
          className: 'tc-root',
          role: 'button',
          tabIndex: 0,
          title: 'Токены: ' + (hasUsage ? formatTokens(total) + ' · ' + formatMoney(cost) : 'нет данных'),
          'aria-label': 'Стоимость токенов, нажмите для расшифровки',
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((value) => !value);
            }
          },
        },
        h('style', { key: 'tc-style' }, CSS),
        h(
          'span',
          { className: 'tc-pill' },
          h('span', { className: 'tc-mark' }, 'i'),
          h('span', { className: 'tc-cost' }, hasUsage ? '≈ ' + formatMoney(cost) : '...'),
        ),
        panel,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'token-cost',
              order: 3,
            },
            TokenCost,
          ),
        );
      },
    };
  },
});
