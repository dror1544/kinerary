/**
 * rates-stand-in.js — a local stand-in for the exchange-rate service
 * (frankfurter.dev) the trip site and mcp/mcp.js call.
 *
 * Why it exists: these tests used to call the real service, so the nightly
 * preflight failed (a 502 from the route, 2026-11-23) whenever a third party
 * was down. This answers the same URL shape on 127.0.0.1 on a port the OS
 * picks, so it can neither collide with a leaked server nor leave the machine.
 *
 * It copies the real service's behaviour where a test leans on it:
 *   - GET /v1/latest?from=USD&to=JPY,ILS  -> { amount, base, date, rates }
 *   - GET /v1/latest?amount=N&from=EUR&to=USD -> amount converted at the table
 *   - from === to                        -> 422 (the one pair it cannot do)
 *   - an unknown currency code           -> 404
 * and it counts requests, because "a second call reuses the cache" and "a
 * USD-only trip makes no request" are claims about how many calls were made.
 *
 * Rates are units of the currency per 1 USD, ballpark-real so an assertion
 * such as "145,000 yen is well under $2000" still bites.
 */
import http from 'node:http';

export const RATES_PER_USD = {
  JPY: 150.25, ILS: 3.62, EUR: 0.92, GBP: 0.79, CHF: 0.88, CAD: 1.4, AUD: 1.52,
};
export const RATES_DATE = '2026-11-20';

/**
 * mode: 'ok' answers; 'error' answers 502; 'hang' accepts the request and
 * never answers (what a stalled upstream looks like to the caller).
 */
export async function startRatesStandIn({ mode = 'ok' } = {}) {
  const state = { mode, hits: 0, requests: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stand-in.invalid');
    state.hits += 1;
    state.requests.push(req.url);
    if (state.mode === 'hang') return;                       // never answers
    if (state.mode === 'error') {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'bad gateway' }));
    }
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname !== '/v1/latest') return send(404, { message: 'not found' });
    const from = (u.searchParams.get('from') || 'EUR').toUpperCase();
    const to = (u.searchParams.get('to') || '').toUpperCase().split(',').filter(Boolean);
    const amount = u.searchParams.has('amount') ? Number(u.searchParams.get('amount')) : 1;
    if (!to.length || to.includes(from)) return send(422, { message: 'invalid pair' });
    const perUsd = c => (c === 'USD' ? 1 : RATES_PER_USD[c]);
    if ([from, ...to].some(c => perUsd(c) === undefined)) return send(404, { message: 'not found' });
    const rates = {};
    for (const c of to) rates[c] = Math.round((amount * perUsd(c) / perUsd(from)) * 1e4) / 1e4;
    send(200, { amount, base: from, date: RATES_DATE, rates });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get hits() { return state.hits; },
    get requests() { return state.requests; },
    setMode(m) { state.mode = m; },
    close() {
      return new Promise(resolve => {
        server.closeAllConnections?.();   // a 'hang' leaves sockets open
        server.close(() => resolve());
      });
    },
  };
}
