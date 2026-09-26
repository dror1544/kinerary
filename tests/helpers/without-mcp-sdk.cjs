// Preloaded with `node --require` to make the MCP SDK unresolvable, as on a
// container whose `npm install` did not fetch it. The trip site must still boot
// and serve; only the organizer connector may be lost.
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@modelcontextprotocol/sdk')) {
    const err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return resolve.call(this, request, ...rest);
};
