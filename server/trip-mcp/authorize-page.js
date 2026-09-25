// The page an organizer sees when Claude or ChatGPT sends them here to connect.
//
// The site keeps its session in localStorage, not a cookie, so the server
// cannot see who is signed in when the browser arrives. The page does the
// sign-in itself with the site's own login APIs (password, Google), then asks
// for consent and posts the decision with that session as a Bearer header.
// Because the decision needs a header a cross-site form cannot set, a hostile
// page cannot submit it on the organizer's behalf.
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside <script>: `<` is the only character that can end the element.
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');

const STRINGS = {
  en: {
    title: 'Connect an AI assistant',
    wants: 'wants to manage this trip as you',
    wantsRead: 'wants to read this trip as you',
    callsItself: 'calls itself',
    shared: 'Everything it reads — including notes about travellers, such as health needs — is sent to the company that runs that assistant.',
    can: 'It will be able to read the trip and change bookings, the plan, the budget and participants — the same things you can do on the site. You can disconnect it at any time from the site\'s menu.',
    canRead: 'It will be able to read the trip — the plan, bookings, budget and what others posted — but not change anything. You can disconnect it at any time from the site\'s menu.',
    signIn: 'Sign in with your trip account',
    username: 'Username', password: 'Password', submit: 'Sign in',
    as: 'Signed in as', other: 'Use a different account',
    allow: 'Allow', deny: 'Cancel',
    notOrganizer: 'This account is not on this trip.',
    wrong: 'Wrong username or password.', failed: 'Something went wrong. Try again.',
    local: 'an app on this computer',
  },
  he: {
    title: 'חיבור עוזר AI',
    wants: 'מבקש לנהל את הטיול הזה בשמך',
    wantsRead: 'מבקש לקרוא את הטיול הזה בשמך',
    callsItself: 'מציג את עצמו בשם',
    shared: 'כל מה שהוא קורא — כולל הערות על המטיילים, כמו צרכים רפואיים — נשלח לחברה שמפעילה את העוזר הזה.',
    can: 'הוא יוכל לקרוא את הטיול ולשנות הזמנות, את התוכנית, את התקציב ואת המשתתפים — אותם דברים שאתם יכולים לעשות באתר. אפשר לנתק אותו בכל עת מהתפריט באתר.',
    canRead: 'הוא יוכל לקרוא את הטיול — התוכנית, ההזמנות, התקציב ומה שאחרים כתבו — אבל לא לשנות דבר. אפשר לנתק אותו בכל עת מהתפריט באתר.',
    signIn: 'התחברו עם חשבון הטיול',
    username: 'שם משתמש', password: 'סיסמה', submit: 'התחברות',
    as: 'מחוברים בתור', other: 'חשבון אחר',
    allow: 'אישור', deny: 'ביטול',
    notOrganizer: 'החשבון הזה אינו חלק מהטיול הזה.',
    wrong: 'שם משתמש או סיסמה שגויים.', failed: 'משהו השתבש. נסו שוב.',
    local: 'אפליקציה במחשב הזה',
  },
};

function renderAuthorizePage({ nonce, lang, clientName, redirectHost, isLoopback, params }) {
  const t = STRINGS[lang] || STRINGS.en;
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  // The destination host is the identity: it is where the code goes and the
  // one thing a registering app cannot choose freely. Its self-chosen name is
  // shown only as a claim.
  const dest = isLoopback ? escapeHtml(t.local) : escapeHtml(redirectHost);
  const claim = clientName ? ` <span class="muted">(${escapeHtml(t.callsItself)} “${escapeHtml(clientName)}”)</span>` : '';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(t.title)}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#f6f5f2; --card:#fff; --fg:#1d1d1b; --muted:#6b6b66; --accent:#1f6f5c; --line:#dedcd6; --warn:#a33b20; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#222220; --fg:#eeede9; --muted:#a4a39d; --accent:#5cc2a4; --line:#3a3a37; --warn:#f08a6b; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:1.15rem; margin:0 0 4px; }
  .trip { color:var(--muted); margin:0 0 20px; }
  p { margin:0 0 14px; }
  .muted { color:var(--muted); font-size:.9rem; }
  label { display:block; font-size:.9rem; margin:10px 0 4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  .row { display:flex; gap:10px; margin-top:18px; }
  button { flex:1; padding:11px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button.link { border:0; padding:0; color:var(--accent); flex:none; text-decoration:underline; }
  .error { color:var(--warn); }
  [hidden] { display:none !important; }
  #google { margin-top:14px; min-height:44px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(t.title)}</h1>
  <p class="trip" id="trip"></p>

  <section id="login" hidden>
    <p>${escapeHtml(t.signIn)}</p>
    <form id="login-form">
      <label for="u">${escapeHtml(t.username)}</label>
      <input id="u" autocomplete="username" required>
      <label for="p">${escapeHtml(t.password)}</label>
      <input id="p" type="password" autocomplete="current-password" required>
      <div class="row"><button class="primary" type="submit">${escapeHtml(t.submit)}</button></div>
    </form>
    <div id="google"></div>
  </section>

  <section id="consent" hidden>
    <p><strong>${dest}</strong>${claim} <span id="wants"></span>.</p>
    <p class="muted" id="can"></p>
    <p class="muted">${escapeHtml(t.shared)}</p>
    <p class="muted">${escapeHtml(t.as)} <strong id="who"></strong> · <button class="link" id="switch" type="button">${escapeHtml(t.other)}</button></p>
    <div class="row">
      <button id="deny" type="button">${escapeHtml(t.deny)}</button>
      <button id="allow" class="primary" type="button">${escapeHtml(t.allow)}</button>
    </div>
  </section>

  <p id="error" class="error" role="alert" hidden></p>
</main>
<script nonce="${nonce}">
(() => {
  const PARAMS = ${scriptJson(params)};
  const T = ${scriptJson({ wrong: t.wrong, failed: t.failed, notOrganizer: t.notOrganizer, wants: t.wants, wantsRead: t.wantsRead, can: t.can, canRead: t.canRead })};
  const $ = id => document.getElementById(id);
  let session = null;
  const stored = () => { try { return localStorage.getItem('trip-token') || localStorage.getItem('tripToken'); } catch { return null; } };
  const show = id => { for (const s of ['login', 'consent']) $(s).hidden = s !== id; };
  const fail = msg => { $('error').textContent = msg; $('error').hidden = !msg; };
  const json = async (path, init = {}) => {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    let body = null; try { body = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body };
  };
  async function adopt(token) {
    const me = await json('/api/auth/me', { headers: { authorization: 'Bearer ' + token } });
    if (!me.ok) return false;
    // Organizers grant read and write, everyone else read only; the server
    // decides the same way, this only says it before they click.
    $('wants').textContent = me.body.is_organizer ? T.wants : T.wantsRead;
    $('can').textContent = me.body.is_organizer ? T.can : T.canRead;
    session = token; fail('');
    // The trip's name is shown only to someone signed in, and only as the
    // sanitized /api/config serves it.
    const cfg = await json('/api/config', { headers: { authorization: 'Bearer ' + token } });
    const title = cfg.ok && cfg.body && cfg.body.meta && cfg.body.meta.title;
    $('trip').textContent = (title && typeof title === 'object' ? (title[document.documentElement.lang] || title.en || title.he) : title) || '';
    $('who').textContent = me.body.name_en || me.body.name || me.body.username;
    show('consent');
    return true;
  }
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault(); fail('');
    const r = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('u').value, password: $('p').value }) });
    if (!r.ok) return fail(r.status === 401 ? T.wrong : T.failed);
    if (!await adopt(r.body.token)) fail(T.failed);
  });
  $('switch').addEventListener('click', () => { session = null; fail(''); show('login'); });
  async function decide(decision) {
    const r = await json('/oauth/authorize/decision', { method: 'POST', headers: { authorization: 'Bearer ' + session }, body: JSON.stringify({ ...PARAMS, decision }) });
    if (r.ok && r.body && r.body.redirect_to) { window.location.replace(r.body.redirect_to); return; }
    fail(r.status === 403 ? T.notOrganizer : T.failed);
  }
  $('allow').addEventListener('click', () => decide('allow'));
  $('deny').addEventListener('click', () => decide('deny'));
  async function google() {
    const h = await json('/api/health');
    const clientId = h.ok && h.body && h.body.googleClientId;
    if (!clientId) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.nonce = ${scriptJson(nonce)};
    s.onload = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: async ({ credential }) => {
        fail('');
        const r = await json('/api/auth/google-login', { method: 'POST', body: JSON.stringify({ idToken: credential }) });
        if (!r.ok || !(await adopt(r.body.token))) fail(T.failed);
      } });
      window.google.accounts.id.renderButton($('google'), { type: 'standard', theme: 'outline', size: 'large', locale: document.documentElement.lang });
    };
    document.head.appendChild(s);
  }
  (async () => {
    const existing = stored();
    if (existing && await adopt(existing)) return;
    show('login'); google();
  })();
})();
</script>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cannot connect</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:480px;margin:auto"><h1 style="font-size:1.2rem">This connection request cannot be completed</h1><p>${escapeHtml(message)}</p></body></html>`;
}

// What a person sees on opening the connector address in a browser. It is an
// address for Claude or ChatGPT, not a page — say so, and say where it goes.
// Nothing from the trip is shown: this is served without sign-in.
function renderConnectorInfoPage({ url, lang }) {
  const he = lang === 'he';
  const t = he ? {
    title: 'כתובת לחיבור עוזר AI',
    lead: 'זו לא כתובת לדפדפן. זו הכתובת שמדביקים ב-Claude או ב-ChatGPT כדי לחבר אותם לטיול:',
    claude: 'Claude: הגדרות ← מחברים ← הוספת מחבר מותאם.',
    chatgpt: 'ChatGPT (באתר): הגדרות ← אבטחה והתחברות ← מצב מפתח, ואז + ליצירת אפליקציה עם הכתובת, ובחרו OAuth.',
    then: 'ייפתח דף מהאתר; התחברו עם חשבון הטיול ואשרו.',
  } : {
    title: 'AI assistant connector address',
    lead: 'This is not a web page. It is the address you paste into Claude or ChatGPT to connect them to this trip:',
    claude: 'Claude: Settings → Connectors → Add custom connector.',
    chatgpt: 'ChatGPT (on the web): Settings → Security and login → Developer mode, then + to create an app with this address, and choose OAuth.',
    then: 'A page from this site opens; sign in with your trip account and allow.',
  };
  return `<!doctype html><html lang="${he ? 'he' : 'en'}" dir="${he ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(t.title)}</title></head>
<body style="font:16px/1.6 system-ui,sans-serif;padding:24px;max-width:520px;margin:auto">
<h1 style="font-size:1.2rem">${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.lead)}</p>
<p><code dir="ltr" style="display:block;padding:10px;border:1px solid #ccc;border-radius:8px;overflow-wrap:anywhere">${escapeHtml(url)}</code></p>
<ul><li>${escapeHtml(t.claude)}</li><li>${escapeHtml(t.chatgpt)}</li></ul>
<p>${escapeHtml(t.then)}</p>
</body></html>`;
}

module.exports = { renderAuthorizePage, renderErrorPage, renderConnectorInfoPage };
