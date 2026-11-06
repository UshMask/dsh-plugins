/**
 * Host half of the Token cost bundle.
 *
 * Aggregates the provider-reported token usage of one session, converts it into
 * an estimated amount of money with configurable per-million prices, and serves
 * the result to the Client half over a small read-only HTTP endpoint.
 */

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const prices = {
    uncached: Math.max(0, asNumber(cfg.priceUncachedPerMillion, 0.27)),
    cached: Math.max(0, asNumber(cfg.priceCachedPerMillion, 0.07)),
    output: Math.max(0, asNumber(cfg.priceOutputPerMillion, 1.1)),
  };
  const symbol = typeof cfg.symbol === 'string' && cfg.symbol.length > 0 ? cfg.symbol : '$';
  const currency = typeof cfg.currency === 'string' && cfg.currency.length > 0 ? cfg.currency : 'USD';
  const rate = Math.max(0, asNumber(cfg.currencyRate, 1));

  const agents = ctx.get('agents');
  const web = ctx.get('webServer');

  /** sessionId -> incremental usage fold */
  const sessions = new Map();

  function sessionOf(sessionId) {
    if (!agents || !sessionId) return undefined;
    try {
      const agent = agents.get(sessionId);
      return agent ? agent.session : undefined;
    } catch {
      return undefined;
    }
  }

  function totalsOf(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { seq: 0, input: 0, cached: 0, output: 0 };
      sessions.set(sessionId, state);
    }
    const session = sessionOf(sessionId);
    if (session) {
      try {
        const events =
          state.seq > 0 && typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents(state.seq)
            : session.ownEvents();
        for (const event of events) {
          if (!event || event.type !== 'assistant/message') continue;
          const usage = event.data && event.data.usage;
          if (!usage) continue;
          const input = asNumber(usage.inputTokens, 0);
          const cacheRead = Math.min(input, asNumber(usage.cacheReadTokens, 0));
          state.input += input;
          state.cached += cacheRead;
          state.output += asNumber(usage.outputTokens, 0);
        }
        if (typeof session.seq === 'number') state.seq = session.seq;
      } catch (error) {
        state.error = String(error);
      }
    }
    const inputTokens = Math.max(0, state.input);
    const cachedTokens = Math.max(0, Math.min(state.cached, inputTokens));
    const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
    const outputTokens = Math.max(0, state.output);
    const totalTokens = uncachedTokens + cachedTokens + outputTokens;
    const cost =
      (uncachedTokens / 1_000_000) * prices.uncached +
      (cachedTokens / 1_000_000) * prices.cached +
      (outputTokens / 1_000_000) * prices.output;
    return {
      live: Boolean(session),
      inputTokens,
      cachedTokens,
      uncachedTokens,
      outputTokens,
      totalTokens,
      cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
      cost: cost * rate,
      costUncached: (uncachedTokens / 1_000_000) * prices.uncached * rate,
      costCached: (cachedTokens / 1_000_000) * prices.cached * rate,
      costOutput: (outputTokens / 1_000_000) * prices.output * rate,
      symbol,
      currency,
      currencyRate: rate,
      prices,
      error: state.error ?? null,
    };
  }

  if (web) {
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/api/x-token-cost',
          resource: async (request) => {
            let url;
            try {
              url = new URL(request.url, 'http://127.0.0.1');
            } catch {
              url = new URL('http://127.0.0.1/api/x-token-cost');
            }
            const sessionId = url.searchParams.get('s') || '';
            return new Response(JSON.stringify(totalsOf(sessionId)), {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            });
          },
        }),
      'token-cost-route',
    );
  }
}

