/**
 * A trip site whose PAYLOAD is older than the control plane (the mixed-version window: the control plane restarts onto a release
 * before each trip is redeployed). Reached over real HTTP, through the real `HttpRuntimeAccountAdapter`, because what matters is how the
 * adapter reads the answers.
 *
 * What an old payload (`origin/main:server/control-plane-auth.js`) has: `GET …/participants/:username` (200 `{username}`, or a JSON 404
 * `{error:"NOT_FOUND"}`) and `POST …/participants` (the invite's provision). What it does NOT have: `GET …/participants` (the list),
 * `POST …/participants/adopt`, `POST …/participants/release`. Express answers those with its default 404, an HTML page; the runtime
 * gateway forwards that status and body untouched.
 *
 * `mode`: "old" = as above. "outage" = every route answers 503. A test closes the server for "connection refused".
 */
import { createServer, type Server } from "node:http";
import { HttpRuntimeAccountAdapter } from "../../src/portal.js";

export interface OldPayloadSite {
  origin: string;
  adapter: HttpRuntimeAccountAdapter;
  /** Every request that reached the door, `METHOD path`. */
  calls: string[];
  mode: "old" | "outage";
  close(): Promise<void>;
}

const EXPRESS_404 = (method: string, path: string) =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${method} ${path}</pre>\n</body>\n</html>\n`;

export async function startOldPayloadSite(usernames: readonly string[]): Promise<OldPayloadSite> {
  const calls: string[] = [];
  const state = { mode: "old" as "old" | "outage" };
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      calls.push(`${method} ${path}`);
      if (state.mode === "outage") { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"RUNTIME_UNAVAILABLE"}'); return; }
      const one = /^\/internal\/t\/[^/]+\/participants\/([^/]+)$/.exec(path);
      if (method === "GET" && one && one[1] !== "adopt" && one[1] !== "release") {
        const username = decodeURIComponent(one[1]!);
        if (usernames.includes(username)) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ username })); return; }
        response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"NOT_FOUND"}'); return;
      }
      if (method === "POST" && /^\/internal\/t\/[^/]+\/participants$/.test(path)) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return; }
      // everything else is a route this payload does not have
      response.writeHead(404, { "content-type": "application/json" }); response.end(EXPRESS_404(method, path));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, calls, adapter: new HttpRuntimeAccountAdapter(origin, "k"),
    get mode() { return state.mode; }, set mode(value) { state.mode = value; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
