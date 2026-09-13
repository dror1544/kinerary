import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanTools } from './plan-tools';
import { Trivia, useTriviaConnection } from './trivia';
import { External } from './parity-ui';
import { phaseDates } from './phase-calendar';

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(value); return value;
}
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const config = { phases: [{ id: 'ny', dates: { start: '2027-03-11', end: '2027-03-13' } }] };
const itinerary = { revision: 'original-snapshot', days: [], items: [] };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

it('clearing the day releases the editing state and shared actions', () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/original') ? { days: [], items: [] } : [])));
  const c = client();
  render(<QueryClientProvider client={c}><PlanTools lang="en" config={config} itinerary={itinerary} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2027-03-11' } });
  expect(screen.getByRole('button', { name: 'Import original schedule' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Import original schedule' })).toBeEnabled();
});

it.each(['Save day title', 'Swap these days'])('%s sends the captured revision after background data changes', async button => {
  const fetcher = vi.fn(async (url: string) => response(url.endsWith('/original') ? { days: [], items: [] } : []));
  vi.stubGlobal('fetch', fetcher);
  const c = client();
  const view = (revision: string) => <QueryClientProvider client={c}><PlanTools lang="en" config={config} itinerary={{ ...itinerary, revision }} /></QueryClientProvider>;
  const { rerender } = render(view('snapshot'));
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2027-03-11' } });
  fireEvent.change(screen.getByLabelText('Swap with'), { target: { value: '2027-03-12' } });
  rerender(view('newer'));
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(fetcher.mock.calls.some(args => (args as unknown as [string, RequestInit])[1]?.method)).toBe(true));
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(new Headers(calls.find(([, init]) => init?.method)?.[1].headers).get('If-Match')).toBe('snapshot');
});

it('unifies calendar dates without losing planned outliers', () => {
  expect(phaseDates(['2027-03-11', '2027-03-12'], ['2027-03-11', '2027-03-14'])).toEqual(['2027-03-11', '2027-03-12', '2027-03-14']);
});
it('rejects malformed external URLs on parity screens', () => {
  render(<><External url="https://">Invalid</External><External url="https://example.com">Valid</External></>);
  expect(screen.queryByRole('link', { name: 'Invalid' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Valid' })).toHaveAttribute('href', 'https://example.com/');
});

it('retains trivia connection on phase changes and reconnects for a new game', async () => {
  const cancelled = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetcher);
  function Connection({ game, status }: { game: string; status: string }) {
    const connected = useTriviaConnection(true, game);
    return <span>{status}:{String(connected)}</span>;
  }
  const c = client();
  const view = (game: string, status: string) => <QueryClientProvider client={c}><Connection game={game} status={status} /></QueryClientProvider>;
  const { rerender } = render(view('one', 'lobby'));
  await screen.findByText('lobby:true');
  rerender(view('one', 'question'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
  rerender(view('two', 'lobby'));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it('does not tick the trivia tree in the lobby and uses slow recovery polling when connected', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/events')
    ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    : response(url.endsWith('/state') ? { status: 'lobby', gameId: 'one', question: null, players: {}, myAnswer: null } : [])));
  const c = client();
  render(<QueryClientProvider client={c}><Trivia lang="en" /></QueryClientProvider>);
  await screen.findByText('Connected');
  await act(async () => {});
  expect(interval.mock.calls.some(([, delay]) => delay === 250)).toBe(false);
  expect(interval.mock.calls.some(([, delay]) => delay === 60000)).toBe(true);
});

it('cannot submit plan edits without a captured revision', () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/original') ? { days: [], items: [] } : [])));
  const c = client();
  render(<QueryClientProvider client={c}><PlanTools lang="en" config={config} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2027-03-11' } });
  fireEvent.change(screen.getByLabelText('Swap with'), { target: { value: '2027-03-12' } });
  expect(screen.getByRole('button', { name: 'Save day title' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Swap these days' })).toBeDisabled();
});
