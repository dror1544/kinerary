// Booking-specific fallback when an assistant client cannot transfer file bytes.
// The URL carries only a booking id. The browser supplies its own site session.
function renderConfirmationUploadPage({ bookingId, nonce }) {
  return `<!doctype html>
<html lang="en" data-booking-id="${bookingId}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload booking confirmation</title>
<style nonce="${nonce}">
  body { font: 16px system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; color: #1b2733; }
  label, button { display: block; margin: 1rem 0; }
  button { padding: .65rem 1rem; }
  #status { min-height: 2rem; }
</style>
</head>
<body>
<main>
  <h1>Upload booking confirmation</h1>
  <p id="booking-name"></p>
  <p>Choose the original PDF from your device. The upload is pending until this page verifies the saved file.</p>
  <form id="upload-form">
    <label for="file">Confirmation PDF (maximum 50 MB)</label>
    <input id="file" name="file" type="file" accept="application/pdf,.pdf" required disabled>
    <button id="submit" type="submit" disabled>Upload and verify</button>
  </form>
  <p id="status" role="status" aria-live="polite">Checking your trip sign-in and booking…</p>
</main>
<script nonce="${nonce}">
(async () => {
  const bookingId = Number(document.documentElement.dataset.bookingId);
  const status = document.getElementById('status');
  const fileInput = document.getElementById('file');
  const submit = document.getElementById('submit');
  const form = document.getElementById('upload-form');
  const bookingName = document.getElementById('booking-name');
  let token;
  try { token = localStorage.getItem('trip-token') || localStorage.getItem('tripToken'); } catch {}
  if (!token) { status.textContent = 'Sign in to this trip site, then reopen this link.'; return; }
  const headers = { authorization: 'Bearer ' + token };
  async function readBooking() {
    const r = await fetch('/api/bookings', { headers });
    if (!r.ok) throw new Error('Cannot read this booking (' + r.status + ').');
    const rows = await r.json();
    const booking = rows.find(row => row.id === bookingId);
    if (!booking) throw new Error('Booking not found on this trip.');
    return booking;
  }
  try {
    const access = await fetch('/api/mcp/connection', { headers });
    if (!access.ok) throw new Error('Sign in to this trip site, then reopen this link.');
    const connection = await access.json();
    if (connection.access !== 'read_write') throw new Error('Only a trip organizer can upload a confirmation.');
    const booking = await readBooking();
    bookingName.textContent = 'Booking: ' + booking.name;
    fileInput.disabled = false;
    submit.disabled = false;
    status.textContent = 'Ready for a PDF. Nothing has been uploaded yet.';
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file || file.type !== 'application/pdf' || file.size === 0 || file.size > 50 * 1024 * 1024) {
      status.textContent = 'Choose a nonempty PDF smaller than 50 MB.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Uploading and verifying…';
    try {
      // Recheck immediately before posting; a stale open page is not authority.
      await readBooking();
      const body = new FormData();
      body.append('file', file, file.name);
      const posted = await fetch('/api/bookings/' + bookingId + '/confirmation', { method: 'POST', headers, body });
      if (!posted.ok) throw new Error('Upload failed (' + posted.status + ').');
      const saved = await posted.json();
      if (!saved.ok || !saved.conf_file) throw new Error('Upload did not return a stored file.');
      const booking = await readBooking();
      if (booking.conf_file !== saved.conf_file) throw new Error('Booking did not link the uploaded file.');
      const original = await fetch('/api/bookings/confirmation/' + encodeURIComponent(saved.conf_file), { headers });
      if (!original.ok || !String(original.headers.get('content-type') || '').startsWith('application/pdf')) {
        throw new Error('Cannot read back the saved PDF.');
      }
      const uploadedBytes = new Uint8Array(await file.arrayBuffer());
      const storedBytes = new Uint8Array(await original.arrayBuffer());
      if (uploadedBytes.length !== storedBytes.length || uploadedBytes.some((byte, index) => byte !== storedBytes[index])) {
        throw new Error('The saved PDF differs from the selected file.');
      }
      status.textContent = 'PDF uploaded, linked to the booking, and verified.';
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

module.exports = { renderConfirmationUploadPage };
