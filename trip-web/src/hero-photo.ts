import { useEffect, useRef, useState } from 'react';
import { runtimeUrl, tokenStore, type TripConfig } from './api';

type LoadedPhoto = { url: string; release: () => void };
type Loader = (source: string, signal: AbortSignal) => Promise<LoadedPhoto>;

export function heroCandidates(config?: TripConfig, uploaded?: string | null, phaseId?: string) {
  const phase = config?.phases?.find(item => item.id === phaseId);
  return [...new Set([
    phase?.hero?.photo, uploaded, config?.meta?.homePhoto,
    config?.phases?.[0]?.hero?.photo, config?.meta?.mapPhoto,
    ...(config?.phases?.map(item => item.hero?.photo) || []),
  ].filter((url): url is string => Boolean(url?.trim())).map(url => url.trim()))];
}

export const loadHeroPhoto: Loader = async (source, signal) => {
  const url = new URL(source, `${window.location.origin}/`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported hero image URL');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 8000);
  let objectUrl: string | undefined;
  const image = new Image();
  let cancelDecode: (() => void) | undefined;
  try {
    let imageUrl = url.href;
    if (url.origin === window.location.origin) {
      const token = tokenStore.get();
      const response = await fetch(runtimeUrl(url.pathname) + url.search, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Hero image unavailable (${response.status})`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Hero response is not an image');
      objectUrl = URL.createObjectURL(blob);
      imageUrl = objectUrl;
    }
    if (controller.signal.aborted) throw new Error('Hero image load cancelled');
    image.src = imageUrl;
    // Decode before replacing the visible photo. A 200 response alone can be
    // an HTML error page or corrupt image, and CSS has no onerror callback.
    await Promise.race([
      image.decode(),
      new Promise<never>((_resolve, reject) => {
        cancelDecode = () => { image.src = ''; reject(new Error('Hero image load cancelled')); };
        controller.signal.addEventListener('abort', cancelDecode, { once: true });
      }),
    ]);
    return { url: imageUrl, release: () => { image.src = ''; if (objectUrl) URL.revokeObjectURL(objectUrl); } };
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    if (cancelDecode) controller.signal.removeEventListener('abort', cancelDecode);
  }
};

export function useHeroPhoto(sources: string[], loader: Loader = loadHeroPhoto) {
  const key = JSON.stringify(sources);
  const [photo, setPhoto] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const visible = useRef('');
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  useEffect(() => { retries.current = 0; }, [key]);
  // Keep decoded images for this mounted trip only. Private uploaded images
  // are object URLs, never persisted in a shared service-worker/local cache.
  const loaded = useRef(new Map<string, LoadedPhoto>());
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function select() {
      const candidates: string[] = JSON.parse(key);
      let failed = false;
      for (const source of candidates) {
        try {
          let image = loaded.current.get(source);
          if (!image) {
            image = await loader(source, controller.signal);
            if (controller.signal.aborted) { image.release(); return; }
            loaded.current.set(source, image);
            // Bound decoded-image memory while keeping the displayed image
            // alive for the outgoing transition.
            for (const [oldSource, oldImage] of loaded.current) {
              if (loaded.current.size <= 3) break;
              if (oldSource !== source && oldImage.url !== visible.current) {
                oldImage.release(); loaded.current.delete(oldSource);
              }
            }
          }
          if (controller.signal.aborted) return;
          visible.current = image.url;
          setPhoto(image.url);
          setUnavailable(false);
          if (failed) retryLater();
          return;
        } catch {
          if (controller.signal.aborted) return;
          failed = true;
        }
      }
      // Never clear the last good image just because a new source failed.
      setUnavailable(true);
      if (failed) retryLater();
    }
    function retryLater() {
      const delay = [5000, 30_000, 120_000][retries.current++];
      if (delay) retry = setTimeout(() => setAttempt(value => value + 1), delay);
    }
    void select();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [key, attempt, loader]);
  useEffect(() => {
    const retry = () => { retries.current = 0; setAttempt(value => value + 1); };
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
      for (const image of loaded.current.values()) image.release();
      loaded.current.clear();
    };
  }, []);
  return { photo, unavailable };
}
