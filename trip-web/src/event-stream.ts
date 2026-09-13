import { runtimeUrl, tokenStore } from './api';

// Shared transport only: callers own registration, invalidation and recovery policy.
export function startEventStream(path: string, receive: (frame: string) => void, connection?: (connected: boolean) => void) {
  let stopped = false;
  let controller: AbortController | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  async function connect() {
    controller = new AbortController();
    try {
      const token = tokenStore.get();
      const response = await fetch(runtimeUrl(path), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'same-origin', signal: controller.signal,
      });
      if (stopped) { await response.body?.cancel(); return; }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Event stream unavailable');
      reader = response.body.getReader();
      connection?.(true);
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          if (end > 65536) throw new Error('Event too large');
          backoff = 1000;
          receive(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        if (buffer.length > 65536) throw new Error('Event too large');
      }
    } catch { /* Disconnection, auth failure or proxy failure: bounded retries. */ }
    finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      reader = undefined;
      if (!stopped) {
        connection?.(false);
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    void reader?.cancel().catch(() => undefined);
    clearTimeout(retry);
  };
}
