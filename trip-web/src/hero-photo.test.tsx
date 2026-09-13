import { Hero } from "./App";
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { heroCandidates, loadHeroPhoto, useHeroPhoto } from './hero-photo';
import { tokenStore } from './api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('keeps an ordered list of fallbacks rather than stopping at a broken nonempty URL', () => {
  expect(heroCandidates({ meta: { homePhoto: '/home.jpg', mapPhoto: '/map.jpg' }, phases: [
    { id: 'one', hero: { photo: '/first.jpg' } }, { id: 'two', hero: { photo: '/broken.jpg' } },
  ] }, '/uploaded.jpg', 'two')).toEqual(['/broken.jpg', '/uploaded.jpg', '/home.jpg', '/first.jpg', '/map.jpg']);
});

it('loads private hero images with authorization and never puts the token in the URL', async () => {
  tokenStore.set('private-token');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified-image');
  const decode = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('Image', class { src = ''; decode = decode; });
  const result = await loadHeroPhoto('/api/ui/hero/uploaded.png', new AbortController().signal);
  expect(fetchMock).toHaveBeenCalledWith('/api/ui/hero/uploaded.png', expect.objectContaining({ headers: { Authorization: 'Bearer private-token' }, redirect: 'error' }));
  expect(decode).toHaveBeenCalled();
  expect(result.url).toBe('blob:verified-image');
});

it('does not send bearer credentials to third-party image hosts', async () => {
  tokenStore.set('private-token');
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', class { src = ''; decode = vi.fn().mockResolvedValue(undefined); });
  const result = await loadHeroPhoto('https://images.example.test/phase.jpg', new AbortController().signal);
  expect(result.url).toBe('https://images.example.test/phase.jpg');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a successful HTML response instead of treating it as a loaded photo', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })));
  await expect(loadHeroPhoto('/api/ui/hero/missing.png', new AbortController().signal)).rejects.toThrow(/image/);
});

it('keeps the last good photo during a slow or failed phase change, then uses a working fallback', async () => {
  let rejectBroken!: (error: Error) => void;
  const loader = vi.fn((source: string) => source === 'broken'
    ? new Promise<{ url: string; release: () => void }>((_resolve, reject) => { rejectBroken = reject; })
    : Promise.resolve({ url: source, release: vi.fn() }));
  const { result, rerender } = renderHook(({ sources }) => useHeroPhoto(sources, loader), { initialProps: { sources: ['first'] } });
  await waitFor(() => expect(result.current.photo).toBe('first'));
  rerender({ sources: ['broken', 'fallback'] });
  expect(result.current.photo).toBe('first');
  await act(async () => rejectBroken(new Error('404')));
  await waitFor(() => expect(result.current.photo).toBe('fallback'));
});

it('an obsolete slow load cannot replace the current phase photo', async () => {
  let finishOld!: (value: { url: string; release: () => void }) => void;
  const release = vi.fn();
  const loader = vi.fn((source: string) => source === 'old'
    ? new Promise<{ url: string; release: () => void }>(resolve => { finishOld = resolve; })
    : Promise.resolve({ url: source, release: vi.fn() }));
  const { result, rerender } = renderHook(({ sources }) => useHeroPhoto(sources, loader), { initialProps: { sources: ['old'] } });
  rerender({ sources: ['new'] });
  await waitFor(() => expect(result.current.photo).toBe('new'));
  await act(async () => finishOld({ url: 'old', release }));
  expect(result.current.photo).toBe('new');
  expect(release).toHaveBeenCalled();
});


it('uses the trip prefix for a gateway-hosted private hero', async () => {
  vi.resetModules();
  const runtimeWindow = window as Window & { runtimePath?: (path: string) => string };
  runtimeWindow.runtimePath = path => `/t/trip_example123${path}`;
  try {
    const { loadHeroPhoto: gatewayLoader } = await import('./hero-photo');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gateway-image');
    vi.stubGlobal('Image', class { src = ''; decode = vi.fn().mockResolvedValue(undefined); });
    await gatewayLoader('/api/ui/hero/photo.png', new AbortController().signal);
    expect(fetchMock.mock.calls[0][0]).toBe('/t/trip_example123/api/ui/hero/photo.png');
  } finally { delete runtimeWindow.runtimePath; }
});

it('times out a stalled image instead of blocking fallbacks indefinitely', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Image', class { src = ''; decode = () => new Promise<void>(() => {}); });
  const outcome = loadHeroPhoto('https://images.example.test/stalled.jpg', new AbortController().signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(8000);
  expect(await outcome).toBeInstanceOf(Error);
});

it('keeps the last working image when all replacements fail', async () => {
  const loader = vi.fn((source: string) => source === 'good'
    ? Promise.resolve({ url: 'good', release: vi.fn() }) : Promise.reject(new Error('unavailable')));
  const { result, rerender } = renderHook(({ sources }) => useHeroPhoto(sources, loader), { initialProps: { sources: ['good'] } });
  await waitFor(() => expect(result.current.photo).toBe('good'));
  rerender({ sources: ['broken'] });
  await waitFor(() => expect(result.current.unavailable).toBe(true));
  expect(result.current.photo).toBe('good');
});


it('renders an authenticated, decoded photo in the actual Hero component', async () => {
  tokenStore.set('private-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rendered-hero');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('Image', class { src = ''; decode = vi.fn().mockResolvedValue(undefined); });
  const { container } = render(<Hero config={{ meta: { homePhoto: '/api/ui/hero/photo.png' } }}
    lang="en" activeTab="today" activeModule={null} openTab={vi.fn()} openModule={vi.fn()} openMenu={vi.fn()} />);
  await waitFor(() => expect(container.querySelector('header')).toHaveAttribute('data-photo-state', 'ready'));
  expect((container.querySelector('.hero-image-arriving') as HTMLElement).style.backgroundImage).toContain('blob:rendered-hero');
  expect((container.querySelector('.hero-image-arriving') as HTMLElement).style.backgroundImage).not.toContain('/api/ui/hero/');
});
