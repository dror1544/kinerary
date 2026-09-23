/**
 * Hold the Trip Bot poll loop until the companions it routes to are back.
 *
 * Every relay restart — a control-plane upgrade, a rollback, a VM reboot, a
 * runner switch — used to start polling the moment the socket listened. Hermes
 * gateways reconnect on their own backoff (up to 30 s), so for that window
 * every trip was unreachable: each message Telegram had been holding was routed,
 * found no gateway, got the canned `COMPANION_PENDING` reply and was consumed.
 * The family asked a question during an upgrade and was told to try again.
 *
 * Telegram keeps undelivered updates for a day and redelivers everything at or
 * after the offset, so not polling IS the queue. The relay listens first (the
 * gateways need the socket to reconnect to), waits here until each expected
 * companion answers `canReachProfile` — the exact check the router makes before
 * it would say COMPANION_PENDING — and only then starts the loop. A companion
 * that never returns costs the bounded timeout once, never the whole bot.
 */
import type { Pool, PoolClient } from "pg";
import { NOT_RETIRED_SQL } from "../trip-retirement.js";

export const DEFAULT_GATEWAY_WAIT_SECONDS = 40;
const MAX_GATEWAY_WAIT_SECONDS = 300;

/**
 * The companions a live trip expects to answer: every open binding that names
 * a profile, on a trip not already recorded as unreachable. `unknown` counts —
 * it is the default for a trip whose reachability nobody established, and
 * waiting for it costs at most the timeout. `unreachable` does not: it was
 * recorded with a reason (migration 0042), and waiting would only delay every
 * other trip by the full timeout on every restart.
 *
 * Same reasoning excludes a RETIRED trip regardless of what `reachability`
 * says: `teardown-trip.py` renames the trip's slug to `retired-<slug>-<yyyymmdd>`
 * as the durable signal that it is gone (issue #105) — the deploy directory,
 * container and Hermes profile are all gone with it, and its `reachability`
 * column may still read whatever it was before teardown. A stale open binding
 * against such a trip (however it came to exist) must not cost every other
 * trip the full gateway-wait timeout on every relay restart.
 */
export async function expectedGatewayProfiles(db: Pick<Pool | PoolClient, "query">): Promise<string[]> {
  const result = await db.query<{ hermes_profile: string }>(
    `SELECT DISTINCT b.hermes_profile
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trips t ON t.id = b.trip_id
      WHERE b.closed_at IS NULL
        AND b.hermes_profile IS NOT NULL
        AND t.reachability <> 'unreachable'
        AND ${NOT_RETIRED_SQL}
      ORDER BY b.hermes_profile`,
  );
  return result.rows.map((row) => row.hermes_profile);
}

/** `RELAY_GATEWAY_WAIT_SECONDS`: 0 switches the wait off; garbage keeps the default. */
export function gatewayWaitMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.RELAY_GATEWAY_WAIT_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GATEWAY_WAIT_SECONDS * 1000;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_GATEWAY_WAIT_SECONDS * 1000;
  return Math.min(Number(raw.trim()), MAX_GATEWAY_WAIT_SECONDS) * 1000;
}

export interface GatewayWaitResult {
  expected: string[];
  connected: string[];
  missing: string[];
  waitedMs: number;
  timedOut: boolean;
}

export async function awaitExpectedGateways(options: {
  expected: readonly string[];
  canReach: (profile: string) => boolean;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<GatewayWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 500;
  const expected = [...options.expected];
  const startedAt = now();

  const split = () => {
    const connected = expected.filter((profile) => options.canReach(profile));
    const missing = expected.filter((profile) => !connected.includes(profile));
    return { connected, missing };
  };

  let state = split();
  while (state.missing.length > 0 && now() - startedAt < options.timeoutMs) {
    await sleep(Math.min(pollMs, options.timeoutMs - (now() - startedAt)));
    state = split();
  }
  return {
    expected,
    connected: state.connected,
    missing: state.missing,
    waitedMs: now() - startedAt,
    timedOut: state.missing.length > 0,
  };
}
