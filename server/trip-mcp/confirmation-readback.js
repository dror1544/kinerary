const crypto = require('crypto');
const MAX_BYTES = 5 * 1024 * 1024;
const SITE_HELP = ' Open the authenticated trip site to view the original.';

// Fetch is supplied by the fixed-listener site client, never by caller input.
// One deadline covers headers and every streamed chunk, including stalled bodies.
async function readConfirmationPdf(fetchResponse, { deadlineMs = 10000 } = {}) {
  const controller = new AbortController();
  let response, timer;
  const fail = message => new Error(message + SITE_HELP);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(fail('Confirmation retrieval exceeded 10 seconds.'));
      controller.abort();
    }, deadlineMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetchResponse(controller.signal);
      if (response.status >= 300 && response.status < 400) throw fail('Confirmation redirects are refused.');
      if (response.status !== 200) throw fail('Linked confirmation is unavailable.');
      if ((response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/pdf') {
        throw fail('Only PDF (application/pdf) confirmations can be retrieved.');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw fail('Confirmation exceeds the 5 MiB retrieval limit.');
      let byte_count = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byte_count += bytes.length;
        if (byte_count > MAX_BYTES) throw fail('Confirmation exceeds the 5 MiB retrieval limit.');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, byte_count);
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('Confirmation has no PDF signature.');
      return { bytes, byte_count, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    })()]);
  } catch (err) {
    if (err.message?.endsWith(SITE_HELP)) throw err;
    throw fail('Confirmation retrieval failed.');
  } finally {
    clearTimeout(timer);
    controller.abort();
    response?.body?.destroy();
  }
}

module.exports = { readConfirmationPdf };
