// The trip-logo fallback for an assistant client that cannot transfer file bytes (docs/specs/sprint-9/x-trip-logo.md).
// The page carries no trip data and no credential: the browser supplies its own site session, the site's routes
// (organizer-or-agent only, switch-gated) are the boundary, and the page re-checks both before it offers a file.
// "Done" is said only after the saved logo was read back: GET /api/ui-settings must name an uploaded logo, and the
// bytes served at that address must be a PNG whose hash is the version in the address.
function renderLogoUploadPage({ nonce }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload trip logo</title>
<style nonce="${nonce}">
  body { font: 16px system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; color: #1b2733; }
  label, button { display: block; margin: 1rem 0; }
  button { padding: .65rem 1rem; }
  #status { min-height: 2rem; }
  #preview { max-width: 12rem; max-height: 12rem; background: #f2f4f6; border-radius: .5rem; }
  #preview[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <h1>Upload trip logo</h1>
  <p>Choose a PNG, JPEG, WebP or GIF (maximum 8 MB). It appears in the trip's header and login page and as the icon of a newly installed app. The upload is pending until this page has verified the saved logo.</p>
  <form id="upload-form">
    <label for="file">Logo image</label>
    <input id="file" name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required disabled>
    <button id="submit" type="submit" disabled>Upload and verify</button>
  </form>
  <img id="preview" alt="The trip's saved logo" hidden>
  <p id="status" role="status" aria-live="polite">Checking your trip sign-in…</p>
</main>
<script nonce="${nonce}">
(async () => {
  const status = document.getElementById('status');
  const fileInput = document.getElementById('file');
  const submit = document.getElementById('submit');
  const form = document.getElementById('upload-form');
  const preview = document.getElementById('preview');
  let token;
  try { token = localStorage.getItem('trip-token') || localStorage.getItem('tripToken'); } catch {}
  if (!token) { status.textContent = 'Sign in to this trip site, then reopen this link.'; return; }
  const headers = { authorization: 'Bearer ' + token };
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  async function readSettings() {
    const r = await fetch('/api/ui-settings', { headers });
    if (!r.ok) throw new Error('Cannot read the trip settings (' + r.status + ').');
    return r.json();
  }
  try {
    const access = await fetch('/api/mcp/connection', { headers });
    if (!access.ok) throw new Error('Sign in to this trip site, then reopen this link.');
    const connection = await access.json();
    if (connection.access !== 'read_write') throw new Error('Only a trip organizer can change the trip logo.');
    const config = await fetch('/api/config', { headers });
    if (!config.ok) throw new Error('Cannot read this trip (' + config.status + ').');
    const features = (await config.json()).features;
    if (!features || features.trip_logo !== true) throw new Error('The trip logo is not turned on for this trip.');
    fileInput.disabled = false;
    submit.disabled = false;
    status.textContent = 'Ready for an image. Nothing has been uploaded yet.';
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file || !TYPES.includes(file.type) || file.size === 0 || file.size > 8 * 1024 * 1024) {
      status.textContent = 'Choose a nonempty PNG, JPEG, WebP or GIF smaller than 8 MB.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Uploading and verifying…';
    try {
      const body = new FormData();
      body.append('logo', file, file.name);
      const posted = await fetch('/api/ui-settings/logo', { method: 'POST', headers, body });
      if (posted.status === 403) throw new Error('Only a trip organizer can change the trip logo.');
      if (posted.status === 409) throw new Error('The trip logo is not turned on for this trip.');
      if (posted.status === 413) throw new Error('That image is larger than 8 MB.');
      if (posted.status === 400) throw new Error('That file is not an image the site can use (PNG, JPEG, WebP or GIF, under 40 megapixels).');
      if (!posted.ok) throw new Error('Upload failed (' + posted.status + ').');
      // Read it back from the site, not from the upload's own answer.
      const settings = await readSettings();
      const logo = settings.logo;
      if (!logo || logo.source !== 'upload' || typeof logo.url !== 'string') throw new Error('The site did not save the logo.');
      const version = new URL(logo.url, 'http://trip.invalid').searchParams.get('v');
      const served = await fetch(logo.url);
      if (!served.ok || !String(served.headers.get('content-type') || '').startsWith('image/png')) throw new Error('Cannot read back the saved logo.');
      const bytes = await served.arrayBuffer();
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
        if (hex !== version) throw new Error('The saved logo differs from what the site reports.');
      }
      preview.src = logo.url;
      preview.hidden = false;
      status.textContent = 'Logo uploaded and verified. It shows in the trip header, the login page and the app icon of a new install.';
    } catch (error) {
      status.textContent = error.message || 'Upload could not be verified.';
    } finally {
      submit.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderLogoUploadPage };
