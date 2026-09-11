import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { startTripUpdates, holdTripQueries } from './live-updates';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

it('coalesces notifications, refreshes dependencies, ignores duplicates, and catches up on reconnect', async () => {
  vi.useFakeTimers();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }), { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('tripToken', 'private-token');
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  stop = startTripUpdates(client);
  await vi.advanceTimersByTimeAsync(0);
  const emit = (event: string, revisions: Record<string, number>) => source.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify({ revisions })}\n\n`));
  emit('ready', { bookings: 0 });
  await vi.advanceTimersByTimeAsync(150);
  invalidate.mockClear();
  emit('change', { bookings: 1 }); emit('change', { bookings: 2 });
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate.mock.calls.map(call => call[0]?.queryKey?.[0])).toEqual(['bookings', 'itinerary', 'today', 'confirmations']);
  invalidate.mockClear(); emit('change', { bookings: 2 });
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[0]).toEqual(['/api/events', expect.objectContaining({ headers: { Authorization: 'Bearer private-token' }, credentials: 'same-origin' })]);
  source.close();
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  emit('ready', { bookings: 2 });
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate.mock.calls.some(call => call[0]?.queryKey?.[0] === 'budget')).toBe(true);
  stop(); source.close();
});

it('polls when streaming fails and refreshes on foreground', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  stop = startTripUpdates(client);
  await vi.advanceTimersByTimeAsync(60_150);
  expect(invalidate.mock.calls.some(call => call[0]?.queryKey?.[0] === 'photo-comments')).toBe(true);
  invalidate.mockClear();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate).toHaveBeenCalled();
  stop(); invalidate.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(invalidate).not.toHaveBeenCalled();
});


it('holds affected queries during editing and applies pending changes after closing', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const release = holdTripQueries(client, ['bookings']);
  stop = startTripUpdates(client);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate.mock.calls.some(call => call[0]?.queryKey?.[0] === 'bookings')).toBe(false);
  expect(invalidate.mock.calls.some(call => call[0]?.queryKey?.[0] === 'budget')).toBe(true);
  invalidate.mockClear(); release();
  await vi.advanceTimersByTimeAsync(150);
  expect(invalidate.mock.calls.map(call => call[0]?.queryKey)).toEqual([['bookings']]);
});
