// `isInternalPath` (path mode, /t/<trip>/...) reads the same normalisation as host mode's `internalApiPath` (`spellsInternal`).
// The HTTP tests in gateway.test.js and host-mode.test.js send the spellings through the real servers; this one calls the checker
// directly for the spellings a client library resolves before sending (`..`), which a request through fetch cannot carry.
import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  NODE_ENV: "test", CONTROL_PLANE_INTERNAL_ORIGIN: "http://127.0.0.1:9", RUNTIME_EXCHANGE_KEY: "exchange-key",
  RUNTIME_COOKIE_SECRET: "cookie-secret-at-least-random", PORTAL_ORIGIN: "https://app.example.test", RUNTIME_ORIGIN: "https://runtime.example.test",
});
const { isInternalPath } = await import(`../server.js?internal-path=${Math.random()}`);

test("every spelling either checker blocked before is still blocked, and the three host mode blocked and path mode did not now are", () => {
  const blocked = [
    // pinned by the path-mode test in gateway.test.js
    "/api/internal/control-plane/participants", "/API/internal/control-plane/participants", "/Api/Internal/x", "/api/INTERNAL/x", "/api%2Finternal/x", "/api%2fINTERNAL/x",
    "/%61pi/internal/x", "/api/%69nternal/x", "/%41pi/%49nternal/x", "/api%252Finternal/x", "/%2561pi/internal/x", "/api//internal/x", "/api/internal", "/API/INTERNAL",
    "/api/internal%2Fx", "/api/internal/../internal/x", "/api/internal/%E0%A4%A", "/api/internal/%zz", "/API/INTERNAL/%zz/x", "/api/internal%2F%zz",
    "/api/internal/100%25.jpg", "/API/internal/%zz", "/%2561pi/internal/100%25.jpg", "/api%2Finternal/%E0%A4%A",
    // pinned by host mode's test (AC-R1.7)
    "/api/internal/", "/API/Internal/x", "/api/%2569nternal/x", "//api/internal/x", "/api/./internal/x", "/x/../api/internal/x", "/api\\internal/x",
    // the prefix test this mode had before blocked these, though they resolve elsewhere: kept blocked (never loosened)
    "/api/internal/../photos/x", "/api/internal/./x", "/api/internal/..",
    // the three found on 2026-11-23, blocked by host mode and not by this one
    "/api%5cinternal/x", "/api/internal;x/x", "/api;x/internal/x",
    // and their encoded / mixed forms
    "/api%5Cinternal/x", "/api/internal%3bx/x", "/api%3bx/internal/x", "/api%255cinternal/x", "/api\\internal;x/x", "/api;x/../api/internal/x", "/api/internal;a=b/x",
  ];
  for (const path of blocked) assert.equal(isInternalPath(path), true, path);
});

test("ordinary paths are still proxied: a literal percent sign, encoded slashes in a file name, Hebrew names, and near-miss segments", () => {
  const ordinary = [
    "/api/photos/file/100%25.jpg", "/api/photos/file/100%25%20fun.jpg", "/api/photos/file/a%2Fb.jpg", "/api/photos/file/a%252Fb.jpg", "/api/photos/file/%E2%82%AC5.jpg",
    "/api/photos/file/%D7%A9%D7%9C%D7%95%D7%9D.jpg", "/api/photos/file/שלום.jpg", "/api/internals-x", "/api/internal-notes", "/api/internals-are-not-a-thing",
    "/api/not-internal/x", "/apix/internal/x", "/", "", "/api", "/api/photos", "/internal/api/x", "/api/photos/internal", "/api/photos/file/a;b.jpg", "/api/photos/file/a%5Cb.jpg",
  ];
  for (const path of ordinary) assert.equal(isInternalPath(path), false, path);
});
