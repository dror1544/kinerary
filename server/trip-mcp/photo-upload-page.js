// The photo upload page a member's own Claude or ChatGPT hands them (get_photo_upload_link), for an assistant that cannot
// transfer image bytes itself. Beside confirmation-upload-page.js and in its shape: the address carries nothing (no booking id, no
// caption, no text a model wrote), the page contains no trip data or credential, and the browser sends its OWN site session to
// the site's established routes, so every route applies the checks it applies to that person.
//
// Unlike the confirmation page it is for any signed-in member, not only an organizer: it does what the site's own album
// already lets a member do (POST /api/photos/upload, then optionally POST /api/moments), and nothing else.
//
// It says "done" only after reading back what it wrote: every photo in the album listing, attributed to this person, with the
// stored file the size of the one chosen; and, with a caption, the moment in the moments list linking exactly those photos.
// The photos are sent one at a time (the site names a photo from the clock, so two at once could collide).
const MAX_PHOTOS = 20;
const MAX_BYTES = 50 * 1024 * 1024;

const STRINGS = {
  en: {
    title: 'Add photos to the trip',
    intro: 'Choose up to 20 photos from your device. They go to the trip album under your name. Add a caption if you want them saved as a trip moment; a moment starts as a draft that only you and the organizers can see until it is published.',
    files: 'Photos (up to 20, 50 MB each)',
    caption: 'Moment caption (optional)',
    submit: 'Upload and check',
    checking: 'Checking your trip sign-in…',
    signIn: 'Sign in to this trip site, then reopen this link.',
    ready: 'Ready. Nothing has been uploaded yet.',
    pick: 'Choose between 1 and 20 photos, each not empty and smaller than 50 MB.',
    uploading: 'Uploading photo {n} of {total}…',
    verifying: 'Checking what was saved…',
    uploadFailed: 'Upload failed ({status}). Nothing after this photo was sent.',
    notSaved: 'A photo could not be read back from the album.',
    sizeDiffers: 'A saved photo differs from the one you chose.',
    momentFailed: 'The photos are saved, but the moment could not be created ({status}).',
    momentMissing: 'The moment could not be read back.',
    donePhotos: 'Done: {n} photo(s) saved to the album and checked.',
    doneMoment: 'Done: {n} photo(s) saved to the album, and a draft moment created from them. Both were checked.',
  },
  he: {
    title: 'הוספת תמונות לטיול',
    intro: 'בחרו עד 20 תמונות מהמכשיר. הן יישמרו באלבום הטיול על שמכם. הוסיפו כותרת אם רוצים לשמור אותן גם כ"רגע בטיול"; הרגע נשאר טיוטה שרק אתם והמארגנים רואים עד שיפורסם.',
    files: 'תמונות (עד 20, עד 50MB כל אחת)',
    caption: 'כותרת לרגע (לא חובה)',
    submit: 'העלאה ובדיקה',
    checking: 'בודקים את ההתחברות לאתר הטיול…',
    signIn: 'התחברו לאתר הטיול ואז פתחו את הקישור שוב.',
    ready: 'מוכן. עדיין לא הועלה דבר.',
    pick: 'בחרו בין תמונה אחת ל-20 תמונות, לא ריקות ופחות מ-50MB.',
    uploading: 'מעלים תמונה {n} מתוך {total}…',
    verifying: 'בודקים מה נשמר…',
    uploadFailed: 'ההעלאה נכשלה ({status}). לא נשלח דבר אחרי התמונה הזו.',
    notSaved: 'לא הצלחנו לקרוא תמונה מהאלבום.',
    sizeDiffers: 'תמונה שנשמרה שונה מזו שבחרתם.',
    momentFailed: 'התמונות נשמרו, אבל לא ניתן היה ליצור את הרגע ({status}).',
    momentMissing: 'לא הצלחנו לקרוא את הרגע שנוצר.',
    donePhotos: 'בוצע: {n} תמונות נשמרו באלבום ונבדקו.',
    doneMoment: 'בוצע: {n} תמונות נשמרו באלבום, ונוצר מהן רגע כטיוטה. הכול נבדק.',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderPhotoUploadPage({ nonce, lang = 'en' }) {
  const l = lang === 'he' ? 'he' : 'en';
  const t = STRINGS[l];
  // The script's strings are data in a JSON island's place: serialised once, with "<" escaped so nothing can close the tag.
  const strings = JSON.stringify(t).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<style nonce="${nonce}">
  body { font: 16px system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; color: #1b2733; }
  label, button { display: block; margin: 1rem 0; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem; }
  button { padding: .65rem 1rem; }
  #status { min-height: 2rem; }
</style>
</head>
<body>
<main>
  <h1>${esc(t.title)}</h1>
  <p>${esc(t.intro)}</p>
  <form id="upload-form">
    <label for="files">${esc(t.files)}</label>
    <input id="files" name="files" type="file" accept="image/*" multiple required disabled>
    <label for="caption">${esc(t.caption)}</label>
    <input id="caption" name="caption" type="text" maxlength="200" disabled>
    <button id="submit" type="submit" disabled>${esc(t.submit)}</button>
  </form>
  <p id="status" role="status" aria-live="polite">${esc(t.checking)}</p>
</main>
<script nonce="${nonce}">
(async () => {
  const T = ${strings};
  const say = (key, vars = {}) => T[key].replace(/\\{(\\w+)\\}/g, (_, k) => String(vars[k]));
  const MAX_PHOTOS = ${MAX_PHOTOS};
  const MAX_BYTES = ${MAX_BYTES};
  const status = document.getElementById('status');
  const filesInput = document.getElementById('files');
  const captionInput = document.getElementById('caption');
  const submit = document.getElementById('submit');
  const form = document.getElementById('upload-form');
  let token;
  try { token = localStorage.getItem('trip-token') || localStorage.getItem('tripToken'); } catch {}
  if (!token) { status.textContent = say('signIn'); return; }
  const headers = { authorization: 'Bearer ' + token };
  try {
    // Any signed-in member passes: this is the site's own "who am I", and it refuses the agent key.
    const access = await fetch('/api/mcp/connection', { headers });
    if (!access.ok) throw new Error(say('signIn'));
    filesInput.disabled = false;
    captionInput.disabled = false;
    submit.disabled = false;
    status.textContent = say('ready');
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const files = Array.from(filesInput.files || []);
    const caption = String(captionInput.value || '').trim();
    if (!files.length || files.length > MAX_PHOTOS || files.some(f => !f || !f.size || f.size > MAX_BYTES || !String(f.type || '').startsWith('image/'))) {
      status.textContent = say('pick');
      return;
    }
    submit.disabled = true;
    try {
      const saved = [];
      // One at a time, in the order chosen: the site names a photo from the clock.
      for (let i = 0; i < files.length; i++) {
        status.textContent = say('uploading', { n: i + 1, total: files.length });
        const body = new FormData();
        body.append('photo', files[i], files[i].name);
        body.append('phase', 'general');
        body.append('source', 'connector');
        const posted = await fetch('/api/photos/upload', { method: 'POST', headers, body });
        if (!posted.ok) throw new Error(say('uploadFailed', { status: posted.status }));
        const answer = await posted.json();
        if (!answer.ok || !answer.photo || !answer.photo.id) throw new Error(say('notSaved'));
        saved.push({ id: String(answer.photo.id), username: answer.photo.username, size: files[i].size });
      }
      status.textContent = say('verifying');
      const listed = await fetch('/api/photos', { headers });
      if (!listed.ok) throw new Error(say('notSaved'));
      const album = await listed.json();
      for (const photo of saved) {
        const row = Array.isArray(album) ? album.find(p => String(p.id) === photo.id) : null;
        if (!row || row.username !== photo.username) throw new Error(say('notSaved'));
        const stored = await fetch(row.url, { headers });
        if (!stored.ok || !String(stored.headers.get('content-type') || '').startsWith('image/')) throw new Error(say('notSaved'));
        if ((await stored.arrayBuffer()).byteLength !== photo.size) throw new Error(say('sizeDiffers'));
      }
      if (!caption) { status.textContent = say('donePhotos', { n: saved.length }); return; }
      const made = await fetch('/api/moments', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ caption, photo_ids: saved.map(p => p.id), source: 'connector' }),
      });
      if (!made.ok) throw new Error(say('momentFailed', { status: made.status }));
      const moment = await made.json();
      const mine = await fetch('/api/moments', { headers });
      const rows = mine.ok ? await mine.json() : [];
      const back = Array.isArray(rows) ? rows.find(m => m.id === moment.id) : null;
      if (!back || JSON.stringify(back.photo_ids) !== JSON.stringify(saved.map(p => p.id))) throw new Error(say('momentMissing'));
      status.textContent = say('doneMoment', { n: saved.length });
    } catch (error) {
      status.textContent = error.message || say('notSaved');
    } finally {
      submit.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderPhotoUploadPage, MAX_PHOTOS, MAX_BYTES };
