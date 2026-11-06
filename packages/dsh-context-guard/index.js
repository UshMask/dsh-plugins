/**
 * Host half of the Context guard bundle.
 *
 * Owns three things:
 *  - a tiny read-only HTTP endpoint that reports live context pressure for one
 *    session (the Client half polls it, because a plain bundle Client module has
 *    no direct access to Host services);
 *  - per-session thresholds received from the Client half with each poll;
 *  - the auto-compaction trigger: when an idle agent crosses the user's compact
 *    threshold, run the shipped `/compact` command for that agent.
 */

const DEFAULT_WARN_PCT = 55;
const DEFAULT_COMPACT_PCT = 80;
const COMPACT_COOLDOWN_MS = 20_000;

function clampPct(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(95, Math.max(5, Math.round(parsed)));
}

function readPct(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

export function apply(ctx, config) {
  const base = config && typeof config === 'object' ? config : {};
  const defaults = {
    warnPct: clampPct(base.warnPct, DEFAULT_WARN_PCT),
    compactPct: clampPct(base.compactPct, DEFAULT_COMPACT_PCT),
    autoCompact: base.autoCompact !== false,
  };

  const meter = ctx.get('tokenMeter');
  const agents = ctx.get('agents');
  const commands = ctx.get('commands');
  const web = ctx.get('webServer');

  /** sessionId -> thresholds and trigger bookkeeping */
  const sessions = new Map();

  function settingsOf(sessionId) {
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      entry = {
        warnPct: defaults.warnPct,
        compactPct: defaults.compactPct,
        autoCompact: defaults.autoCompact,
        running: false,
        lastCompactAt: 0,
        lastCompact: null,
        seenAt: 0,
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  function sessionOf(sessionId) {
    if (!agents || !sessionId) return undefined;
    try {
      const agent = agents.get(sessionId);
      return agent ? agent.session : undefined;
    } catch {
      return undefined;
    }
  }

  function pressureOf(sessionId) {
    const session = sessionOf(sessionId);
    if (!session || !meter) {
      return { live: false, ratio: 0, pressureTokens: null, contextWindow: null };
    }
    let pressure;
    try {
      pressure = meter.contextPressure(session);
    } catch (error) {
      return { live: true, ratio: 0, pressureTokens: null, contextWindow: null, error: String(error) };
    }
    const pressureTokens = typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : null;
    const contextWindow = typeof pressure.contextWindow === 'number' ? pressure.contextWindow : null;
    const ratio = pressureTokens !== null && contextWindow ? pressureTokens / contextWindow : 0;
    return { live: true, ratio, pressureTokens, contextWindow };
  }

  function compactCommandFor(agent) {
    if (!commands) return undefined;
    try {
      return commands.find(agent, 'compact');
    } catch {
      return undefined;
    }
  }

  /** Decides whether the auto-compaction trigger should fire, without firing it. */
  function compactDecision(sessionId) {
    const entry = settingsOf(sessionId);
    if (!entry.autoCompact) return { eligible: false, reason: 'auto-compaction is off' };
    if (entry.running) return { eligible: false, reason: 'compaction is already running' };
    if (Date.now() - entry.lastCompactAt < COMPACT_COOLDOWN_MS) {
      return { eligible: false, reason: 'cooldown after the previous attempt' };
    }
    const snapshot = pressureOf(sessionId);
    if (snapshot.ratio * 100 < entry.compactPct) {
      return { eligible: false, reason: 'pressure is below the auto-compaction threshold' };
    }
    if (!agents) return { eligible: false, reason: 'the agents service is unavailable' };
    let agent;
    try {
      agent = agents.get(sessionId);
    } catch {
      agent = undefined;
    }
    if (!agent) return { eligible: false, reason: 'the agent is not live' };
    if (compactCommandFor(agent) === undefined) {
      return { eligible: false, reason: 'the /compact command is unavailable' };
    }
    return { eligible: true, reason: 'pressure crossed the auto-compaction threshold', agent, ratio: snapshot.ratio };
  }

  function maybeCompact(sessionId) {
    const decision = compactDecision(sessionId);
    if (!decision.eligible) return decision;
    const entry = settingsOf(sessionId);
    const agent = decision.agent;
    entry.running = true;
    entry.lastCompactAt = Date.now();
    const controller = new AbortController();
    Promise.resolve()
      .then(() => commands.execute(agent, '/compact', [], controller.signal))
      .then((result) => {
        const outcome = result && typeof result === 'object' ? result : {};
        const text = typeof outcome.text === 'string' ? outcome.text : '';
        entry.lastCompact = { at: Date.now(), ok: true, text };
        console.log('[context-guard] auto-compaction finished' + (text ? ': ' + text : ''));
      })
      .catch((error) => {
        entry.lastCompact = { at: Date.now(), ok: false, text: String(error) };
        console.log('[context-guard] auto-compaction failed: ' + String(error));
      })
      .finally(() => {
        entry.running = false;
      });
    return decision;
  }

  // The Client half polls this endpoint; it doubles as the thresholds transport.
  if (web) {
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/api/x-context-guard',
          resource: async (request) => {
            let url;
            try {
              url = new URL(request.url, 'http://127.0.0.1');
            } catch {
              url = new URL('http://127.0.0.1/api/x-context-guard');
            }
            const sessionId = url.searchParams.get('s') || '';
            const entry = settingsOf(sessionId);
            const warnRaw = readPct(url.searchParams.get('warn'), entry.warnPct);
            const compactRaw = readPct(url.searchParams.get('compact'), entry.compactPct);
            if (url.searchParams.has('warn') && url.searchParams.has('compact')) {
              entry.warnPct = Math.min(warnRaw, compactRaw - 5);
              entry.compactPct = compactRaw;
              entry.autoCompact = url.searchParams.get('auto') !== '0';
              entry.seenAt = Date.now();
            } else if (url.searchParams.has('auto')) {
              entry.autoCompact = url.searchParams.get('auto') !== '0';
            }
            const snapshot = pressureOf(sessionId);
            const decision = compactDecision(sessionId);
            if (url.searchParams.has('debug')) {
              entry.lastDebug = String(url.searchParams.get('debug')).slice(0, 500);
            }
            const body = {
              live: snapshot.live,
              ratio: snapshot.ratio,
              pressureTokens: snapshot.pressureTokens,
              contextWindow: snapshot.contextWindow,
              warnPct: entry.warnPct,
              compactPct: entry.compactPct,
              autoCompact: entry.autoCompact,
              compacting: entry.running,
              lastCompact: entry.lastCompact,
              wouldCompact: decision.eligible,
              compactReason: decision.reason,
              lastDebug: entry.lastDebug ?? null,
              error: snapshot.error ?? null,
            };
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            });
          },
        }),
      'context-guard-route',
    );
  }

  // Auto-compaction runs only for idle agents: /compact refuses to start mid-turn.
  ctx.on('agent/status', (payload) => {
    if (!payload || !payload.agent) return;
    const agent = payload.agent;
    const sessionId = agent.session ? agent.session.id : undefined;
    if (!sessionId) return;
    if (payload.status === 'idle') {
      maybeCompact(sessionId);
    }
  });
}
