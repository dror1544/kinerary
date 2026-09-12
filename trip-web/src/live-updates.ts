import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { runtimeUrl, tokenStore } from './api';

const DEPENDENCIES: Record<string, string[]> = {
  itinerary: ['itinerary', 'today', 'confirmations', 'revisions'],
  bookings: ['bookings', 'itinerary', 'today', 'confirmations'],
  budget: ['budget'],
  photos: ['photos', 'photo-reactions', 'photo-comments', 'moments', 'today'],
  'photo-reactions': ['photo-reactions'],
  'photo-comments': ['photo-comments'],
  comments: ['venue-comments', 'moments', 'today'], ratings: ['ratings', 'moments', 'today'],
  tasks: ['tasks'], rsvps: ['rsvps'], 'lost-found': ['lost-found'],
  moments: ['moments', 'today'], ui: ['ui'],
};
const ALL = [...new Set(Object.values(DEPENDENCIES).flat())];

// Hold only affected resource queries while an editor is open. In particular,
// a remote deletion must not unmount the row containing someone's unsaved form.
const guards = new WeakMap<QueryClient, { held: Map<string, number>; released: Set<() => void> }>();
function guardFor(client: QueryClient) {
  let state = guards.get(client);
  if (!state) { state = { held: new Map(), released: new Set() }; guards.set(client, state); }
  return state;
}
export function holdTripQueries(client: QueryClient, keys: string[]) {
  const state = guardFor(client);
  for (const key of keys) state.held.set(key, (state.held.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = (state.held.get(key) || 1) - 1;
      if (count) state.held.set(key, count); else state.held.delete(key);
    }
    for (const notify of state.released) notify();
  };
}
export function useLiveEditGuard(active: boolean, resource: string) {
  const client = useQueryClient();
  useEffect(() => active ? holdTripQueries(client, DEPENDENCIES[resource] || []) : undefined, [client, active, resource]);
}

// Fetch carries the normal Authorization header (no token in a URL), while
// runtimeUrl and same-origin cookies also support the managed runtime gateway.
export function startTripUpdates(client: QueryClient) {
  const guard = guardFor(client);
  let stopped = false;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let batch: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  const pending = new Set<string>();
  const seen: Record<string, number> = {};
  function schedule(keys = ALL) {
    for (const key of keys) pending.add(key);
    if (batch || document.visibilityState === 'hidden') return;
    batch = setTimeout(() => {
      batch = undefined;
      if (document.visibilityState === 'hidden') return;
      const keys = [...pending].filter(key => !guard.held.has(key));
      for (const key of keys) pending.delete(key);
      // Refetch cache data, never remount the screen or reset editor state.
      for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
    }, 100);
  }
  function receive(frame: string) {
    const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
    if (event !== 'ready' && event !== 'change') return;
    try {
      const data = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'));
      if (!data.revisions || typeof data.revisions !== 'object') return;
      if (event === 'ready') { backoff = 1000; schedule(); }
      for (const [resource, revision] of Object.entries(data.revisions)) {
        if (!Object.hasOwn(DEPENDENCIES, resource) || !Number.isSafeInteger(revision) || Number(revision) < 0) continue;
        if (seen[resource] !== revision) schedule(DEPENDENCIES[resource]);
        seen[resource] = Number(revision);
      }
    } catch { /* Ignore malformed notifications; bounded polling still catches up. */ }
  }
  async function connect() {
    controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const token = tokenStore.get();
      const response = await fetch(runtimeUrl('/api/events'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'same-origin', signal: controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Event stream unavailable');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.length > 64 * 1024) throw new Error('Event too large');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          receive(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
        }
      }
    } catch { /* Offline, auth expired, or proxy unavailable: retry with a cap. */ }
    finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (!stopped) {
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  function foreground() {
    if (document.visibilityState !== 'hidden') schedule([...ALL, 'config', 'me', 'hermes', 'flights', 'weather']);
  }
  const polling = setInterval(() => {
    if (document.visibilityState !== 'hidden') schedule();
  }, 60_000);
  const released = () => schedule([]);
  guard.released.add(released);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener('online', foreground);
  void connect();
  return () => {
    stopped = true; controller?.abort();
    guard.released.delete(released);
    clearTimeout(retry); clearTimeout(batch); clearInterval(polling);
    document.removeEventListener('visibilitychange', foreground);
    window.removeEventListener('online', foreground);
  };
}

export function useTripUpdates(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => enabled ? startTripUpdates(client) : undefined, [client, enabled]);
}
