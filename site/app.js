/* =========================================================
   Trip Site · App
   ========================================================= */

/* =========================================================
   LANGUAGE
   ========================================================= */
function detectLang() {
  const saved = localStorage.getItem('trip-lang');
  if (saved) return saved;
  const locale = (navigator.languages?.[0] || navigator.language || 'he').toLowerCase();
  return locale.startsWith('he') ? 'he' : 'en';
}
let currentLang = detectLang();

function applyLang(lang) {
  currentLang = lang;
  localStorage.setItem('trip-lang', lang);
  const root = document.getElementById('root');
  const tr = T[lang];
  root.lang = lang;
  root.dir = tr.dir;

  // text nodes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (tr[key] !== undefined) el.textContent = tr[key];
  });
  // html nodes
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml;
    if (tr[key] !== undefined) el.innerHTML = tr[key];
  });
  // placeholder nodes
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.dataset.i18nPh;
    if (tr[key] !== undefined) el.placeholder = tr[key];
  });
  // password placeholder (legacy explicit)
  const pwdInput = document.getElementById('pwd-input');
  if (pwdInput) pwdInput.placeholder = tr['login_pwd_placeholder'];

  // lang toggle active state
  document.querySelectorAll('.lang-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.l === lang);
  });

  // re-render current hero
  const activeTab = document.querySelector('.section.active');
  if (activeTab) setHero(activeTab.id);

  // update map popups if map is already open
  if (mapInited) updateMapPopups(lang);

  renderTaskDeadlines(lang);
  showLoggedIn();

  // re-render ratings in new language (config-driven)
  (window.TRIP_CONFIG?.phases || []).forEach(p => {
    const idFull  = `ratings-${p.id}`;
    const idShort = p.short_id ? `ratings-${p.short_id}` : null;
    if (document.getElementById(idFull)?.children.length)  renderRatings(idFull,  VENUES[p.id] || VENUES[p.short_id]);
    if (idShort && document.getElementById(idShort)?.children.length) renderRatings(idShort, VENUES[p.short_id]);
  });

  // re-render config-driven sections in new language
  const _cfg = window.TRIP_CONFIG;
  renderStats(_cfg);
  renderAlerts(_cfg);
  renderFamilies(_cfg);
  renderTasks(_cfg);
  renderTaskDeadlines(lang); // must run after renderTasks rebuilds the DOM
  renderInfo(_cfg);
  (_cfg?.phases || []).forEach(p => { renderPhaseHotelCard(p); renderDays(p); });
  renderPhotoUploads(_cfg);

  // re-render packing lists in new language (config-driven)
  renderPacking('pack-general', PACKING.general);
  (window.TRIP_CONFIG?.phases || []).forEach(p => {
    const key = p.short_id || p.id;
    renderPacking(`pack-${key}`, PACKING[key]);
    if (p.short_id) renderPacking(`pack-${p.id}`, PACKING[p.id]);
  });

  // re-render RSVP cards in new language (config-driven)
  const allActs = [];
  (window.TRIP_CONFIG?.phases || []).forEach(p => {
    const key = p.short_id || p.id;
    (RSVP_ACTIVITIES[key] || RSVP_ACTIVITIES[p.id] || []).forEach(a => {
      if (!allActs.find(x => x.id === a.id)) allActs.push(a);
    });
  });
  allActs.forEach(a => {
    const card = document.getElementById(`rsvp-card-${a.id}`);
    if (card) card.outerHTML = renderRsvpCard(a);
  });

  // refresh phase dropdowns when language changes
  populatePhaseSectionDropdowns(window.TRIP_CONFIG, lang);

  // re-render dynamically-built album share links in current language
  for (const [phase, url] of Object.entries(ALBUM_SHARE_URLS || {})) {
    if (!url) continue;
    const link = `<a class="album-share-btn" href="${url}" target="_blank">${tr.album_open}</a>`;
    document.querySelectorAll(`[data-album-phase="${phase}"]`).forEach(el => { el.innerHTML = link; });
  }
}

function renderTaskDeadlines(lang) {
  const isHe = lang === 'he';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  document.querySelectorAll('.task-deadline').forEach(el => {
    const row = el.closest('tr[data-tid]');
    if (row && taskDoneCache[row.dataset.tid]) return; // done state overrides deadline
    const dl = el.dataset.deadline;
    if (!dl || dl === 'ongoing') {
      el.className = 'badge bg';
      el.textContent = isHe ? 'בתהליך ✅' : 'Ongoing ✅';
      return;
    }
    const deadline = new Date(dl);
    deadline.setHours(0, 0, 0, 0);
    const diff = Math.round((deadline - today) / 864e5);

    if (diff < 0) {
      el.className = 'badge br';
      el.textContent = isHe ? `פג תוקף` : `Overdue`;
    } else if (diff === 0) {
      el.className = 'badge br';
      el.textContent = isHe ? 'היום! ⚡' : 'Today! ⚡';
    } else if (diff <= 7) {
      el.className = 'badge br';
      el.textContent = isHe ? `${diff} ימים ⚠️` : `${diff}d ⚠️`;
    } else if (diff <= 21) {
      el.className = 'badge bo';
      el.textContent = isHe ? `${diff} ימים` : `${diff}d`;
    } else {
      el.className = 'badge bg';
      el.textContent = isHe ? `${diff} ימים` : `${diff}d`;
    }
  });
}

// ── TASK DONE ─────────────────────────────────────────────────────────────────
let taskDoneCache = {};

async function loadTaskDone() {
  try {
    const res = await fetch('/api/tasks/done');
    const rows = await res.json();
    taskDoneCache = {};
    rows.forEach(r => { taskDoneCache[r.task_id] = r; });
    renderTaskDoneState();
  } catch(e) {}
}

function renderTaskDoneState() {
  document.querySelectorAll('tr[data-tid]').forEach(row => {
    const tid = row.dataset.tid;
    const done = taskDoneCache[tid];
    const cell = row.querySelector('.task-done-cell');
    const deadlineEl = row.querySelector('.task-deadline');
    if (!cell) return;

    if (done) {
      row.classList.add('task-done');
      if (deadlineEl) {
        deadlineEl.className = 'badge bg';
        deadlineEl.textContent = '✅ בוצע';
      }
      const who = done.user ? done.user.name : done.done_by;
      cell.innerHTML = `<button class="task-done-btn done" onclick="toggleTaskDone('${tid}')" title="בוצע על ידי ${who}">↩ בטל</button>`;
    } else {
      row.classList.remove('task-done');
      renderTaskDeadlines(currentLang); // restore deadline badge
      cell.innerHTML = currentUser
        ? `<button class="task-done-btn" onclick="toggleTaskDone('${tid}')">✓ בוצע</button>`
        : '';
    }
  });
}

async function toggleTaskDone(taskId) {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/tasks/${taskId}/done`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('trip-token') }
    });
    const data = await res.json();
    if (data.done) {
      taskDoneCache[taskId] = data;
    } else {
      delete taskDoneCache[taskId];
    }
    renderTaskDeadlines(currentLang);
    renderTaskDoneState();
  } catch(e) {}
}

/* =========================================================
   HERO PER TAB
   ========================================================= */
let HERO = {
  home: {
    photo: "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=2400&q=80&auto=format&fit=crop",
    title: "TRIP",
    label: "",
    sub: "",
    blurb: "",
    meta: "",
    cta: "בחר שלב",
    countdown: true
  },
  mapview: {
    photo: "https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?w=2400&q=80&auto=format&fit=crop",
    title: "ROUTE",
    label: "— 8 יעדים · 6,500 ק\"מ",
    sub: "מפת המסלול המלאה",
    blurb: "ממנהטן ועד מנהטן ביץ' — דרך 8 יעדים, 3 אזורי זמן, שלושה שלבים.",
    meta: "INTERACTIVE MAP",
    cta: "צפה במפה",
    countdown: false
  },
  // Per-phase entries (ny/dallas/colorado/westcoast in the original single-trip
  // version) are intentionally absent here — buildGlobalsFromConfig() sets
  // HERO[phase.id] from trip.config.json for every phase that has a hero.blurb,
  // which every real trip does; setHero() falls back to HERO.home if a phase
  // config omits hero.blurb. No need to duplicate trip content here.
  bookings: {
    photo: "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=2400&q=80&auto=format&fit=crop",
    title: "BOOKINGS",
    label: "— הזמנות והכנות",
    sub: "כל הטיסות, מלונות, רכבים ואטרקציות",
    blurb: "מה כבר סגור, מה דחוף לעדכן.",
    meta: "CHECKLIST",
    cta: "צפה ברשימה",
    countdown: false
  },
  photos: {
    photo: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=2400&q=80&auto=format&fit=crop",
    title: "PHOTOS",
    label: "— זיכרונות מהדרך",
    sub: "גלריית תמונות המשפחה",
    blurb: "כולם יוכלו להעלות תמונות לכל שלב — לזיכרון משפחתי משותף.",
    meta: "TRIP GALLERY",
    cta: "העלה תמונות",
    countdown: false
  },
  info: {
    photo: "https://images.unsplash.com/photo-1502472584811-0a2f2feb8968?w=2400&q=80&auto=format&fit=crop",
    title: "INFO",
    label: "— מדריך משפחתי",
    sub: "בריאות, חירום, אריזה, תקשורת",
    blurb: "כל מה שצריך לדעת לפני, במהלך ואחרי. שמרו את המספרים בטלפון.",
    meta: "FAMILY HANDBOOK",
    cta: "צפה במידע",
    countdown: false
  }
};

// alt photos for NY tweak
const NY_PHOTOS = [
  "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=2400&q=80&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1543158266-0066955047b0?w=2400&q=80&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1518391846015-55a9cc003b25?w=2400&q=80&auto=format&fit=crop"
];

/* =========================================================
   AUTH (multi-user, server-side JWT)
   ========================================================= */
let currentUser = null;
let isOrganizer = false;
const PHASE_PLAN = {}; // phase_id → array of plan items loaded from DB
const PHASE_PLAN_DAYS = {}; // phase_id → { date: {label_he,label_en,...} }

async function doLogin() {
  const username = document.getElementById('user-input').value.trim().toLowerCase();
  const password = document.getElementById('pwd-input').value.trim();
  const tr = T[currentLang];
  if (!username || !password) { document.getElementById('pwd-err').textContent = tr.err_empty; return; }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('pwd-err').textContent = tr.err_wrong; return; }
    localStorage.setItem('trip-token', data.token);
    localStorage.setItem('trip-user', JSON.stringify(data.user));
    // /api/config is session-protected. Reload into the authenticated bootstrap
    // so no trip data is fetched before a valid browser session exists.
    window.location.reload();
    return;
  } catch {
    document.getElementById('pwd-err').textContent = tr.err_wrong;
  }
}

// Convention: {Username}.png, {Username}2.png, {Username}3.png, ...
// First letter capital, rest lowercase. Add files in both avatars/ and avatars/FullPhoto/.
// Code auto-discovers up to AVATAR_MAX variants by probing — no list needed.
const AVATAR_MAX = 9;

function _avatarBaseName(username) {
  const u = username.toLowerCase();
  return u.charAt(0).toUpperCase() + u.slice(1);
}

// Use today's date as cache-buster so new avatar files are discovered the same day
// they're added, without hammering origin on every probe.
const _PROBE_BUST = new Date().toISOString().slice(0, 10).replace(/-/g, '');

function _probeImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(src.split('/').pop());
    img.onerror = () => resolve(null);
    img.src = `${src}?d=${_PROBE_BUST}`;
  });
}

async function _discoverAvatarFiles(username) {
  const base = _avatarBaseName(username);
  const candidates = [`${base}.png`];
  for (let n = 2; n <= AVATAR_MAX; n++) candidates.push(`${base}${n}.png`);
  const results = await Promise.all(candidates.map(f => _probeImage(`/avatars/${f}`)));
  const found = results.filter(Boolean);
  return found.length ? found : [`${base}.png`];
}

function _activeAvatarFile(username) {
  const u = username.toLowerCase();
  if (currentUser && currentUser.username === u && currentUser.avatar_file) return currentUser.avatar_file;
  return localStorage.getItem(`avatar_${u}`) || `${_avatarBaseName(u)}.png`;
}

function avatarSrc(username) {
  const u = username.toLowerCase();
  // Google profile photo is only a default — an explicitly picked/uploaded
  // avatar_file always wins.
  if (currentUser && currentUser.username === u && !currentUser.avatar_file && currentUser.google_picture) {
    return currentUser.google_picture;
  }
  return `/avatars/${_activeAvatarFile(username)}`;
}

function showLoggedIn() {
  if (!currentUser) return;
  // Side menu user block
  const smUser = document.getElementById('sm-user');
  const smAvatar = document.getElementById('sm-user-avatar');
  const smName = document.getElementById('sm-user-name');
  const smFamily = document.getElementById('sm-user-family');
  if (smUser && smAvatar && smName && smFamily) {
    const displayN = uname(currentUser.username, currentUser);
    smAvatar.innerHTML = '';
    const img = document.createElement('img');
    img.src = avatarSrc(currentUser.username);
    img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:top;display:block;';
    img.onerror = () => {
      img.onerror = () => { img.remove(); smAvatar.textContent = displayN[0]; smAvatar.style.background = currentUser.color; };
      img.src = `/avatars/${currentUser.username}.jpg`;
    };
    smAvatar.style.background = 'transparent';
    smAvatar.appendChild(img);
    smName.textContent = displayN;
    smFamily.textContent = currentUser.familyName || '';
    smUser.style.display = 'flex';

    smAvatar.onclick = () => openAvatarLightbox(currentUser.username);
    initAvatarLightbox();
  }
}

// ── Avatar Lightbox / Carousel ──────────────────────────────────────────────

const lbState = { username: '', files: [], index: 0, cropper: null, originalFile: null };

async function openAvatarLightbox(username) {
  const u = username.toLowerCase();
  const files = await _discoverAvatarFiles(u);
  const active = _activeAvatarFile(u);
  lbState.username = u;
  lbState.files = files;
  lbState.index = Math.max(0, files.indexOf(active));

  _buildLightboxSlides();

  const lb = document.getElementById('avatar-lightbox');
  if (lb) lb.classList.add('open');
  _updateLightboxUI();
  _updateGoogleConnectUI();
}

// Reflects current link state whenever the avatar lightbox is (re)opened or
// right after a connect/disconnect action — shows the GIS button when not yet
// linked, or "Connected as <email>" + a disconnect button when linked.
function _updateGoogleConnectUI() {
  const wrap = document.getElementById('avatar-lb-google-wrap');
  if (!wrap || wrap.style.display !== 'flex') return; // Google Sign-In not configured on this deployment
  const tr = T[currentLang] || T['he'];
  const statusEl = document.getElementById('avatar-lb-google-status');
  const btnEl = document.getElementById('avatar-lb-google-btn');
  const disconnectBtn = document.getElementById('avatar-lb-google-disconnect');
  const linked = currentUser?.username === lbState.username && currentUser?.google_email;

  if (linked) {
    if (statusEl) statusEl.textContent = `✓ ${tr.avatar_google_connected_prefix || 'Connected as'} ${currentUser.google_email}`;
    if (btnEl) btnEl.style.display = 'none';
    if (disconnectBtn) disconnectBtn.style.display = '';
  } else {
    if (statusEl) statusEl.textContent = '';
    if (btnEl) btnEl.style.display = '';
    if (disconnectBtn) disconnectBtn.style.display = 'none';
  }
}

// Same last resort as the side-menu avatar (showLoggedIn): no photo at all,
// so show the user's initial on their color instead of a broken-image icon.
function _avatarInitialsEl() {
  const displayN = uname(lbState.username, currentUser);
  const el = document.createElement('div');
  el.className = 'avatar-lb-initials';
  el.textContent = (displayN || '?')[0];
  el.style.background = currentUser?.color || 'var(--ink-2)';
  return el;
}

function _buildLightboxSlides() {
  const track = document.getElementById('avatar-lb-track');
  if (!track) return;
  track.innerHTML = '';

  lbState.files.forEach((file, i) => {
    const slide = document.createElement('div');
    slide.className = 'avatar-lb-slide';

    const img = document.createElement('img');
    img.className = 'avatar-lb-photo';
    img.draggable = false;
    img.alt = file;
    // Hidden while (re)trying sources so a failed load never flashes the
    // browser's native broken-image icon — only becomes visible on success.
    img.style.visibility = 'hidden';
    img.onload = () => { img.style.visibility = ''; };
    img.onerror = () => {
      img.onerror = () => { img.remove(); slide.appendChild(_avatarInitialsEl()); };
      img.src = `/avatars/${file}`;
    };
    img.src = `/avatars/FullPhoto/${file}`;

    slide.appendChild(img);
    track.appendChild(slide);
  });

  // Touch swipe
  let touchStartX = 0;
  track.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) lbGoTo(lbState.index + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

function _updateLightboxUI() {
  const track = document.getElementById('avatar-lb-track');
  const dotsEl = document.getElementById('avatar-lb-dots');
  const useBtn = document.getElementById('avatar-lb-use');
  const prev = document.getElementById('avatar-lb-prev');
  const next = document.getElementById('avatar-lb-next');
  if (!track) return;

  const { files, index, username } = lbState;
  const hasMultiple = files.length > 1;

  track.style.transform = `translateX(${-index * 100}%)`;

  // Dots
  if (dotsEl) {
    dotsEl.innerHTML = '';
    if (hasMultiple) {
      files.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = 'avatar-lb-dot' + (i === index ? ' active' : '');
        dot.onclick = () => lbGoTo(i);
        dotsEl.appendChild(dot);
      });
    }
  }

  // Prev/Next visibility
  if (prev) prev.style.visibility = hasMultiple ? '' : 'hidden';
  if (next) next.style.visibility = hasMultiple ? '' : 'hidden';

  // Use button
  const tr = (T[currentLang] || T['he']) || {};
  if (useBtn) {
    const stored = localStorage.getItem(`avatar_${username}`);
    const currentFile = (currentUser?.avatar_file) || (stored && files.includes(stored) ? stored : files[0]);
    const isActive = files[index] === currentFile;
    useBtn.textContent = isActive ? (tr.avatar_active || '✓ הפרופיל הנוכחי') : (tr.avatar_set || 'הגדר כאווטאר שלי');
    useBtn.disabled = isActive;
  }

  // Upload button label
  const uploadBtn = document.getElementById('avatar-lb-upload');
  if (uploadBtn) {
    uploadBtn.textContent = tr.avatar_upload || '📷 העלה תמונה חדשה';
    uploadBtn.disabled = false;
  }

  // "Reset to default" — only shown when there's an explicit choice to reset
  const resetBtn = document.getElementById('avatar-lb-reset-default');
  if (resetBtn) {
    const hasOverride = currentUser?.username === username && currentUser?.avatar_file;
    resetBtn.style.display = hasOverride ? '' : 'none';
    resetBtn.textContent = tr.avatar_reset_default || '↺ חזור לברירת המחדל';
  }
}

function lbGoTo(i) {
  const len = lbState.files.length;
  lbState.index = ((i % len) + len) % len;
  _updateLightboxUI();
}

function lbClose() {
  const lb = document.getElementById('avatar-lightbox');
  if (lb) lb.classList.remove('open');
  if (lbState.cropper) { lbState.cropper.destroy(); lbState.cropper = null; }
  lbState.originalFile = null;
  lb?.querySelector('.avatar-lb-box')?.classList.remove('cropping', 'changing-password');
  const pwNew = document.getElementById('avatar-lb-pw-new');
  const pwConfirm = document.getElementById('avatar-lb-pw-confirm-input');
  const pwStatus = document.getElementById('avatar-lb-pw-status');
  if (pwNew) pwNew.value = '';
  if (pwConfirm) pwConfirm.value = '';
  if (pwStatus) pwStatus.textContent = '';
}

function initAvatarLightbox() {
  const lb = document.getElementById('avatar-lightbox');
  if (!lb || lb._lbBound) return;
  lb._lbBound = true;

  lb.addEventListener('click', e => { if (e.target === lb) lbClose(); });
  document.getElementById('avatar-lb-close')?.addEventListener('click', lbClose);
  document.getElementById('avatar-lb-prev')?.addEventListener('click', () => lbGoTo(lbState.index - 1));
  document.getElementById('avatar-lb-next')?.addEventListener('click', () => lbGoTo(lbState.index + 1));

  document.getElementById('avatar-lb-use')?.addEventListener('click', async () => {
    const { username, files, index } = lbState;
    const chosen = files[index];
    localStorage.setItem(`avatar_${username}`, chosen);
    if (currentUser && currentUser.username === username) {
      currentUser.avatar_file = chosen;
      const token = localStorage.getItem('trip-token');
      if (token) {
        fetch('/api/auth/avatar', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ avatar_file: chosen })
        }).catch(() => {});
      }
    }
    const smAvatar = document.getElementById('sm-user-avatar');
    if (smAvatar) {
      const img = smAvatar.querySelector('img');
      if (img) img.src = avatarSrc(username);
    }
    _updateLightboxUI();
  });

  document.getElementById('avatar-lb-reset-default')?.addEventListener('click', async () => {
    const { username } = lbState;
    if (!(currentUser && currentUser.username === username)) return;
    localStorage.removeItem(`avatar_${username}`);
    currentUser.avatar_file = null;
    localStorage.setItem('trip-user', JSON.stringify(currentUser));
    const token = localStorage.getItem('trip-token');
    if (token) {
      fetch('/api/auth/avatar', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    const files = await _discoverAvatarFiles(username);
    lbState.files = files;
    lbState.index = Math.max(0, files.indexOf(_activeAvatarFile(username)));
    _buildLightboxSlides();
    _updateLightboxUI();
    showLoggedIn(); // refresh the small side-menu avatar (Google photo or convention default)
  });

  // ── Upload flow: file → crop panel → confirm → POST cropped + full ──
  const fileInput    = document.getElementById('avatar-lb-file');
  const uploadBtn    = document.getElementById('avatar-lb-upload');
  const cropPanel    = document.getElementById('avatar-lb-crop-panel');
  const cropImg      = document.getElementById('avatar-lb-crop-img');
  const cropConfirm  = document.getElementById('avatar-lb-crop-confirm');
  const cropCancel   = document.getElementById('avatar-lb-crop-cancel');
  const cropStatus   = document.getElementById('avatar-lb-crop-status');
  const lbBox        = lb.querySelector('.avatar-lb-box');

  function _showCropPanel(file) {
    const tr = (T[currentLang] || T['he']) || {};
    const reader = new FileReader();
    reader.onload = e => {
      cropImg.src = e.target.result;
      lbBox.classList.add('cropping');
      if (lbState.cropper) lbState.cropper.destroy();
      lbState.cropper = new Cropper(cropImg, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 0.85,
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
      });
      lbState.originalFile = file;
      cropConfirm.textContent = tr.avatar_crop_confirm || 'העלה';
      cropCancel.textContent  = tr.avatar_crop_cancel  || 'ביטול';
      cropConfirm.disabled = false;
      cropCancel.disabled  = false;
      if (cropStatus) cropStatus.textContent = '';
    };
    reader.readAsDataURL(file);
  }

  function _hideCropPanel() {
    if (lbState.cropper) { lbState.cropper.destroy(); lbState.cropper = null; }
    lbBox.classList.remove('cropping');
    lbState.originalFile = null;
  }

  uploadBtn?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) _showCropPanel(file);
  });

  cropCancel?.addEventListener('click', _hideCropPanel);

  cropConfirm?.addEventListener('click', async () => {
    if (!lbState.cropper || !lbState.originalFile) return;
    const token = localStorage.getItem('trip-token');
    if (!token) return;
    const tr = (T[currentLang] || T['he']) || {};

    cropConfirm.textContent = tr.avatar_uploading || 'מעלה...';
    cropConfirm.disabled = true;
    cropCancel.disabled  = true;
    if (cropStatus) cropStatus.textContent = '';

    try {
      const canvas = lbState.cropper.getCroppedCanvas({ width: 400, height: 400, imageSmoothingQuality: 'high' });
      const croppedBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

      const form = new FormData();
      form.append('avatar',    croppedBlob, 'avatar.png');
      form.append('fullPhoto', lbState.originalFile, lbState.originalFile.name);

      const res = await fetch('/api/auth/avatar/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw new Error('upload failed');
      const { avatar_file } = await res.json();

      if (currentUser) currentUser.avatar_file = avatar_file;
      localStorage.setItem(`avatar_${lbState.username}`, avatar_file);

      _hideCropPanel();

      const files = await _discoverAvatarFiles(lbState.username);
      lbState.files = files;
      lbState.index = Math.max(0, files.indexOf(avatar_file));
      _buildLightboxSlides();
      _updateLightboxUI();

      const smAvatar = document.getElementById('sm-user-avatar');
      const smImg = smAvatar?.querySelector('img');
      if (smImg) smImg.src = avatarSrc(lbState.username);
    } catch {
      if (cropStatus) cropStatus.textContent = tr.avatar_upload_error || 'שגיאה בהעלאה';
      cropConfirm.textContent = tr.avatar_crop_confirm || 'העלה';
      cropConfirm.disabled = false;
      cropCancel.disabled  = false;
    }
  });

  // ── Change password ──────────────────────────────────────────────────────
  const pwToggle  = document.getElementById('avatar-lb-pw-toggle');
  const pwPanel   = document.getElementById('avatar-lb-pw-panel');
  const pwNew     = document.getElementById('avatar-lb-pw-new');
  const pwConfirm = document.getElementById('avatar-lb-pw-confirm-input');
  const pwStatus  = document.getElementById('avatar-lb-pw-status');
  const pwSave    = document.getElementById('avatar-lb-pw-save');
  const pwCancel  = document.getElementById('avatar-lb-pw-cancel');

  function _hidePwPanel() {
    lbBox.classList.remove('changing-password');
    if (pwNew) pwNew.value = '';
    if (pwConfirm) pwConfirm.value = '';
    if (pwStatus) pwStatus.textContent = '';
  }

  pwToggle?.addEventListener('click', () => {
    lbBox.classList.add('changing-password');
    pwNew?.focus();
  });

  pwCancel?.addEventListener('click', _hidePwPanel);

  // ── Connect / disconnect Google ──────────────────────────────────────────
  document.getElementById('avatar-lb-google-disconnect')?.addEventListener('click', async () => {
    const token = localStorage.getItem('trip-token');
    if (!token) return;
    try {
      await fetch('/api/auth/google-link', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (currentUser) {
        currentUser.google_email = null;
        currentUser.google_picture = null;
        localStorage.setItem('trip-user', JSON.stringify(currentUser));
      }
      _updateGoogleConnectUI();
      showLoggedIn(); // fall back to the file-based avatar now that Google is disconnected
    } catch {}
  });

  pwSave?.addEventListener('click', async () => {
    const tr = (T[currentLang] || T['he']) || {};
    const token = localStorage.getItem('trip-token');
    if (!token) return;

    const next = pwNew?.value || '';
    const confirmVal = pwConfirm?.value || '';
    if (pwStatus) pwStatus.textContent = '';

    if (next.length < 4) {
      if (pwStatus) pwStatus.textContent = tr.avatar_pw_too_short || 'הסיסמה חייבת להיות לפחות 4 תווים';
      return;
    }
    if (next !== confirmVal) {
      if (pwStatus) pwStatus.textContent = tr.avatar_pw_mismatch || 'הסיסמאות אינן תואמות';
      return;
    }

    pwSave.textContent = tr.avatar_pw_saving || 'שומר...';
    pwSave.disabled = true;
    pwCancel.disabled = true;

    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: next }),
      });
      if (!res.ok) throw new Error('password update failed');
      if (pwStatus) pwStatus.textContent = tr.avatar_pw_success || '✓ הסיסמה עודכנה';
      pwNew.value = '';
      pwConfirm.value = '';
      setTimeout(_hidePwPanel, 1200);
    } catch {
      if (pwStatus) pwStatus.textContent = tr.avatar_pw_error || 'שגיאה בעדכון הסיסמה';
    } finally {
      pwSave.textContent = tr.avatar_pw_save || 'שמור';
      pwSave.disabled = false;
      pwCancel.disabled = false;
    }
  });
}

// ── GOOGLE SIGN-IN ────────────────────────────────────────────────────────────
// One GIS callback handles both flows, told apart by whether currentUser is
// already set: logged out → login with a linked Google account; logged in →
// link the Google account onto the current (already-predefined) user.
async function initGoogleAuth() {
  let clientId = null;
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    clientId = d.googleClientId || null;
  } catch {}
  if (!clientId || typeof google === 'undefined' || !google.accounts?.id) return;

  google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });

  const loginWrap = document.getElementById('google-signin-wrap');
  if (loginWrap) {
    loginWrap.style.display = 'flex';
    google.accounts.id.renderButton(document.getElementById('google-signin-btn'), {
      type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', width: 280,
    });
  }

  const googleWrap = document.getElementById('avatar-lb-google-wrap');
  if (googleWrap) {
    googleWrap.style.display = 'flex';
    google.accounts.id.renderButton(document.getElementById('avatar-lb-google-btn'), {
      type: 'standard', theme: 'outline', size: 'medium', text: 'continue_with', width: 220,
    });
    _updateGoogleConnectUI();
  }
}

async function handleGoogleCredential(response) {
  const idToken = response.credential;
  const tr = T[currentLang] || T['he'];

  if (currentUser) {
    // Already logged in → this is the "connect" flow from the avatar screen
    const token = localStorage.getItem('trip-token');
    const statusEl = document.getElementById('avatar-lb-google-status');
    try {
      const res = await fetch('/api/auth/google-link', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (statusEl) statusEl.textContent = data.error === 'already_linked'
          ? (tr.avatar_google_conflict || 'This Google account is already linked to someone else')
          : (tr.avatar_google_error || 'Could not connect Google account');
        return;
      }
      currentUser.google_email = data.google_email;
      currentUser.google_picture = data.google_picture;
      localStorage.setItem('trip-user', JSON.stringify(currentUser));
      _updateGoogleConnectUI();
      showLoggedIn(); // refresh the small side-menu avatar if no avatar was explicitly picked
    } catch {
      if (statusEl) statusEl.textContent = tr.avatar_google_error || 'Could not connect Google account';
    }
    return;
  }

  // Logged out → login flow
  try {
    const res = await fetch('/api/auth/google-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('pwd-err').textContent = data.error === 'not_linked'
        ? (tr.err_google_not_linked || 'No account is linked to this Google login yet — log in with your username and password first, then connect Google from your profile.')
        : (tr.err_wrong || 'Login failed');
      return;
    }
    localStorage.setItem('trip-token', data.token);
    localStorage.setItem('trip-user', JSON.stringify(data.user));
    // /api/config is session-protected. Reload into the authenticated bootstrap
    // so no trip data is fetched before a valid browser session exists.
    window.location.reload();
    return;
  } catch {
    document.getElementById('pwd-err').textContent = tr.err_wrong;
  }
}

// ── TELEGRAM LOGIN ────────────────────────────────────────────────────────────
// Login-only (no "connect" flow — Telegram identity is bound server-side via
// trip.config.json telegram_id, not something a browser session can link).
async function initTelegramAuth() {
  let botUsername = null;
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    botUsername = d.telegramBotUsername || null;
  } catch {}
  renderTelegramLogin(botUsername);
}

// Called by Telegram's widget script (data-onauth="onTelegramAuth(user)"),
// a plain global function since app.js loads as a classic (non-module) script.
async function onTelegramAuth(user) {
  const tr = T[currentLang] || T['he'];
  try {
    const res = await fetch('/api/auth/telegram-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('pwd-err').textContent = telegramLoginErrorMessage(data.error, tr);
      return;
    }
    localStorage.setItem('trip-token', data.token);
    localStorage.setItem('trip-user', JSON.stringify(data.user));
    // /api/config is session-protected. Reload into the authenticated bootstrap
    // so no trip data is fetched before a valid browser session exists.
    window.location.reload();
    return;
  } catch {
    document.getElementById('pwd-err').textContent = tr.err_wrong;
  }
}

function buildLoginPicker() {
  const picker = document.getElementById('login-picker');
  if (!picker) return;
  const userInput = document.getElementById('user-input');
  // Pre-auth: window.LOGIN_ROSTER (from /api/config/roster) carries name/name_en
  // directly, since window.USERS_CACHE isn't populated until after login.
  const PEOPLE = (window.LOGIN_ROSTER || []).map(p => ({ u: p.username, color: p.color, name: p.name, name_en: p.name_en }));
  picker.innerHTML = '';
  PEOPLE.forEach(({ u, color, name: nameHe, name_en }) => {
    const name = currentLang === 'en' ? (name_en || u) : (nameHe || u);
    const chip = document.createElement('div');
    chip.className = 'lp-chip';
    chip.dataset.u = u;
    const img = document.createElement('img');
    img.src = avatarSrc(u);
    img.alt = name;
    img.style.borderColor = color;
    img.onerror = () => {
      img.onerror = () => {
        img.onerror = null;
        // Canvas fallback
        const c = document.createElement('canvas'); c.width = c.height = 88;
        const ctx = c.getContext('2d');
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(44,44,44,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((name[0] || '?').toUpperCase(), 44, 46);
        img.src = c.toDataURL();
      };
      img.src = `/avatars/${u}.jpg`;
    };
    const nameEl = document.createElement('div');
    nameEl.className = 'lp-name';
    nameEl.textContent = name;
    chip.append(img, nameEl);
    chip.addEventListener('click', () => {
      picker.querySelectorAll('.lp-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      userInput.value = u;
      document.getElementById('pwd-input').focus();
    });
    picker.appendChild(chip);
  });
}

async function checkAuth() {
  const token = localStorage.getItem('trip-token');
  const savedUser = localStorage.getItem('trip-user');
  if (token && savedUser) {
    try {
      const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        currentUser = await res.json();
        isOrganizer = !!currentUser.is_organizer;
        localStorage.setItem('trip-user', JSON.stringify(currentUser));
        showLoggedIn();
        document.getElementById('login-overlay').style.display = 'none';
        return true;
      }
    } catch {}
  }
  localStorage.removeItem('trip-token');
  localStorage.removeItem('trip-user');
  return false;
}

function doLogout() {
  localStorage.removeItem('trip-token');
  localStorage.removeItem('trip-user');
  currentUser = null;
  const smUser = document.getElementById('sm-user');
  if (smUser) smUser.style.display = 'none';
  // Close side menu if open
  document.getElementById('side-menu')?.classList.remove('open');
  document.getElementById('side-overlay')?.classList.remove('open');
  document.getElementById('burger-btn')?.classList.remove('open');
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('user-input').value = '';
  document.getElementById('pwd-input').value = '';
  document.getElementById('pwd-err').textContent = '';
}

document.getElementById('pwd-btn').addEventListener('click', doLogin);
document.getElementById('pwd-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('user-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pwd-input').focus(); });
document.getElementById('sm-logout-btn').addEventListener('click', doLogout);

/* =========================================================
   USERS CACHE (for ratings display)
   ========================================================= */
function loadUsersCache() {
  const participants = window.TRIP_CONFIG?.participants;
  if (participants?.length) {
    window.USERS_CACHE = {};
    participants.forEach(p => {
      window.USERS_CACHE[p.username] = { name: p.name, name_en: p.name_en, color: p.color };
    });
  } else {
    // fallback if config not loaded
    window.USERS_CACHE = {};
  }
}

function uname(username, userObj) {
  const cache = window.USERS_CACHE?.[username];
  if (currentLang === 'en') {
    return cache?.name_en || userObj?.name_en || cache?.name || userObj?.name || username;
  }
  return cache?.name || userObj?.name || username;
}

/* =========================================================
   TRIP CLOCK
   ========================================================= */
// Three states, not one. The original only counted down to departure and, once
// that passed, wrote a rocket into the days slot and returned early — leaving
// hours/minutes/seconds on their "–" placeholders forever. Any trip whose
// departure is in the past therefore displayed a permanently broken timer,
// which is every past trip and every demo of one.
//
// Counting is only interesting before the trip. Once it starts, "time until it
// ends" is the one number nobody wants on screen, so the card stops counting
// and answers "where am I?" instead: the active phase and which day of the trip
// this is, clicking through to that phase's page. After → a finished state.
/* TRIP_CLOCK_BEGIN */
function tripPhaseNow(meta, now = new Date()) {
  const dep = meta?.departure ? new Date(meta.departure) : null;
  if (!dep || isNaN(dep)) return null;
  // returnDate is a plain YYYY-MM-DD (the day everyone gets home), so the trip
  // is still running for the whole of that day — end of it, not the start.
  let end = null;
  if (meta.returnDate) {
    end = new Date(`${meta.returnDate}T23:59:59`);
    if (isNaN(end)) end = null;
  }
  if (now < dep)             return { state: 'before',   target: dep };
  if (end && now <= end)     return { state: 'during',   target: end };
  if (end)                   return { state: 'finished', target: null };
  // No returnDate to work from: departure has passed and we can't tell whether
  // the trip is still running. "Finished" is the wrong guess mid-trip, so show
  // the in-progress state without a timer rather than declaring it over.
  return { state: 'during', target: null };
}

// Calendar day as a comparable integer. Built from UTC on purpose: a DST shift
// inside the trip makes a local day 23 or 25 hours long, which would round a
// plain millisecond division to the wrong day.
function dayIndex(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function localYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Day 4 of 12" — day 1 is the departure day itself.
function tripDayNumber(meta, now = new Date()) {
  const dep = meta?.departure ? new Date(meta.departure) : null;
  if (!dep || isNaN(dep)) return null;
  const day = dayIndex(now) - dayIndex(dep) + 1;
  if (day < 1) return null;
  // meta.totalDays is the length the hero already advertises ("5 people · 11
  // days"), so it wins over the raw departure→return span — the two disagree
  // whenever the trip opens with a night flight. Clamp rather than let the two
  // numbers contradict each other: "day 12 of 11" is worse than a repeated
  // final day. Noon avoids YYYY-MM-DD parsing as UTC midnight, which lands on
  // the previous day west of Greenwich.
  const ret  = meta.returnDate ? new Date(`${meta.returnDate}T12:00:00`) : null;
  const span = ret && !isNaN(ret) ? dayIndex(ret) - dayIndex(dep) + 1 : null;
  const total = meta.totalDays || span || null;
  return { day: total ? Math.min(day, total) : day, total };
}

// Which phase the trip is in right now.
function currentTripPhase(phases, now = new Date()) {
  const list = (phases || [])
    .filter(p => p?.dates?.start)
    .sort((a, b) => String(a.dates.start).localeCompare(String(b.dates.start)));
  if (!list.length) return null;
  const today = localYMD(now);
  // Phases share their boundary day — you check out of one and into the next on
  // the same date — so the phase being travelled *into* wins.
  const inRange = list.filter(p => p.dates.start <= today && today <= (p.dates.end || p.dates.start));
  if (inRange.length) return inRange[inRange.length - 1];
  // Evening of an outbound flight that lands tomorrow, or a gap between two
  // phases: point at where the trip is heading, not where it's been.
  return list.find(p => p.dates.start > today) || list[list.length - 1];
}

function tripClockState(cfg, now = new Date()) {
  const state = tripPhaseNow(cfg?.meta, now);
  if (!state || state.state !== 'during') return state;
  const counted = tripDayNumber(cfg?.meta, now) || {};
  return {
    ...state,
    phase:     currentTripPhase(cfg?.phases, now),
    day:       counted.day  || null,
    totalDays: counted.total || null,
  };
}

// The whole card is the hit target mid-trip, and nothing at all otherwise —
// leaving a stale role/tabindex behind would hand keyboard users a button that
// silently does nothing once the trip is over.
function setClockTarget(card, phaseId, label) {
  if (!card) return;
  card.classList.toggle('clickable', !!phaseId);
  if (phaseId) {
    card.setAttribute('data-phase-tab', phaseId);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    if (label) { card.setAttribute('aria-label', label); card.setAttribute('title', label); }
  } else {
    ['data-phase-tab', 'role', 'tabindex', 'aria-label', 'title'].forEach(a => card.removeAttribute(a));
  }
}

function tick(now = new Date()) {
  const cfg = window.TRIP_CONFIG;
  const clock = tripClockState(cfg, now);
  if (!clock) return; // config not loaded yet — nothing to count down to

  const el = id => document.getElementById(id);
  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  const tr = (typeof T !== 'undefined' && T[currentLang]) || {};

  const card     = el('hero-countdown');
  const units    = el('cd-units');
  const live     = el('cd-live');
  const finished = el('cd-finished');
  const caption  = el('cd-caption');

  if (units)    units.hidden    = clock.state !== 'before';
  if (live)     live.hidden     = clock.state !== 'during';
  if (finished) finished.hidden = clock.state !== 'finished';

  if (clock.state === 'finished') {
    setClockTarget(card, null);
    if (caption) caption.textContent = '';
    if (finished) finished.textContent = tr.cd_finished || '✅ הטיול הסתיים';
    return;
  }

  if (clock.state === 'during') {
    const p = clock.phase;
    const title = typeof p?.title === 'object' ? (p.title[currentLang] || p.title.he) : (p?.title || p?.tabLabel || '');
    setClockTarget(card, p?.id || null, tr.cd_open_phase);
    if (caption) caption.textContent = tr.cd_in_progress || '';
    setText('cd-live-phase', [p?.emoji, title].filter(Boolean).join(' '));
    setText('cd-live-day', clock.day
      ? (clock.totalDays
          ? (tr.cd_day_of || '{n}/{total}').replace('{n}', clock.day).replace('{total}', clock.totalDays)
          : (tr.cd_day || '{n}').replace('{n}', clock.day))
      : '');
    setText('cd-live-arrow', currentLang === 'he' ? '←' : '→');
    return;
  }

  setClockTarget(card, null);
  if (caption) caption.textContent = tr.cd_until_departure || '';

  const diff = Math.max(0, clock.target - now);
  setText('cd-d', Math.floor(diff / 86400000));
  setText('cd-h', String(Math.floor((diff % 86400000) / 3600000)).padStart(2, '0'));
  setText('cd-m', String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0'));
  setText('cd-s', String(Math.floor((diff % 60000) / 1000)).padStart(2, '0'));
}

// Wired once, on the card rather than on the live block, so the click target is
// the whole card; tick() decides per second whether it currently leads anywhere.
function wireTripClock() {
  const card = document.getElementById('hero-countdown');
  if (!card) return;
  const open = () => {
    const tab = card.getAttribute('data-phase-tab');
    if (tab) switchTab(tab);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
}

wireTripClock();
setInterval(tick, 1000); tick();
/* TRIP_CLOCK_END */

/* =========================================================
   TABS + HERO SWAP
   ========================================================= */
let mapInited = false;

/* =========================================================
   MAP DATA (bilingual)
   ========================================================= */
let MAP_STOPS = [];
const mapMarkers = [];

function buildMapPopup(s, lang) {
  const isHe = lang === 'he';
  const name = isHe ? s.name_he : s.name_en;
  const dir  = isHe ? 'rtl' : 'ltr';
  const confLabel   = isHe ? 'אישור' : 'Confirmation';
  const privateStay = isHe ? 'לינה פרטית' : 'Private stay';
  const hasConf = s.conf !== '–';
  return `<div dir="${dir}" style="min-width:180px;font-family:'Heebo',sans-serif">
    <strong style="font-size:1.05em">${s.emoji} ${name}</strong><br>
    📅 ${s.dates}<br>
    🏨 ${s.hotel}<br>
    ${hasConf ? `✅ ${confLabel}: <code>${s.conf}</code>` : `🏠 ${privateStay}`}
  </div>`;
}

function updateMapPopups(lang) {
  MAP_STOPS.forEach((s, i) => {
    if (mapMarkers[i]) mapMarkers[i].setPopupContent(buildMapPopup(s, lang));
  });
}

function setHero(tabId) {
  const h = HERO[tabId] || HERO.home;
  const tr = T[currentLang];
  // mapview is the only framework tab whose T key differs from its tab ID
  const k = tabId === 'mapview' ? 'map' : tabId;

  const img = document.getElementById('hero-img');
  const headline = document.getElementById('hero-headline');
  const label = document.getElementById('hero-label');
  const sub = document.getElementById('hero-subtitle');
  const blurb = document.getElementById('hero-blurb');
  const meta = document.getElementById('hero-meta');
  const cta = document.getElementById('hero-cta');
  const countdown = document.querySelector('.hero-countdown');

  if (img) img.style.backgroundImage = `url("${h.photo}")`;
  if (headline) headline.innerHTML = `${h.title}<span class="dot">.</span>`;
  const i18n = h._i18n; // bilingual source from config (preferred over T)
  if (label) label.textContent = (i18n?.label?.[currentLang]) || tr[`hero_${k}_label`] || h.label;
  if (sub)   sub.textContent   = (i18n?.sub?.[currentLang])   || tr[`hero_${k}_sub`]   || h.sub;
  if (blurb) blurb.textContent = (i18n?.blurb?.[currentLang]) || tr[`hero_${k}_blurb`] || h.blurb;
  if (meta) meta.textContent = h.meta;
  if (cta) {
    const arrow = currentLang === 'he' ? '←' : '→';
    const ctaText = (i18n?.cta?.[currentLang]) || tr[`hero_${k}_cta`] || h.cta;
    cta.innerHTML = `${ctaText} <span class="arrow">${arrow}</span>`;
  }
  if (countdown) countdown.style.display = h.countdown ? '' : 'none';
  const heroRight = document.querySelector('.hero-right');
  if (heroRight) heroRight.classList.toggle('meta-centered', tabId === 'photos');
}

function switchTab(tabId) {
  document.querySelectorAll('.topnav a, .sm-link').forEach(a => a.classList.toggle('active', a.dataset.tab === tabId));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === tabId));
  setHero(tabId);
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (tabId === 'mapview' && !mapInited) { initMap(); mapInited = true; }
  if (tabId === 'photos') loadPhotosGallery();
  if (tabId === 'lostfound') loadLostFound();
  if (tabId === 'budget') loadBudget();
  if (tabId === 'bookings') loadBookings();
  if (tabId === 'ny')        { loadPhaseAlbum('ny');        loadPhaseBookings('nyc'); }
  if (tabId === 'dallas')    { loadPhaseAlbum('dallas');    loadPhaseBookings('dallas'); }
  if (tabId === 'colorado')  { loadPhaseAlbum('colorado');  loadPhaseBookings('colorado'); }
  if (tabId === 'westcoast') { loadPhaseAlbum('wc');        loadPhaseBookings('west_coast'); }
}

// Restart spinning GIF on logo hover
const logoWrap = document.querySelector('.topbar-logo-wrap');
if (logoWrap) {
  logoWrap.addEventListener('mouseenter', () => {
    const gif = logoWrap.querySelector('.topbar-logo-gif');
    const s = gif.src;
    gif.src = '';
    gif.src = s;
  });
}

document.querySelectorAll('.topnav a').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    switchTab(a.dataset.tab);
  });
});

// Hero CTA scrolls to content
document.getElementById('hero-cta').addEventListener('click', () => {
  const active = document.querySelector('.section.active');
  if (active) {
    const body = active.querySelector('.sec-body, .statstrip');
    if (body) body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/* =========================================================
   MAP
   ========================================================= */
function initMap() {
  const _mapCfg = window.TRIP_CONFIG?.map;
  const map = L.map('leaflet-map').setView(_mapCfg?.center || [30, 10], _mapCfg?.zoom || 3);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(map);

  const route = MAP_STOPS.map(s => [s.lat, s.lng]);
  L.polyline(route, { color: '#0a0f1c', weight: 2.5, opacity: 0.85, dashArray: '8 6' }).addTo(map);

  MAP_STOPS.forEach((s, i) => {
    const icon = L.divIcon({
      html: `<div style="background:${s.color};color:#fff;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:1.2em;box-shadow:0 4px 12px rgba(0,0,0,.35);border:2px solid #fff">${s.emoji}</div>`,
      iconSize: [38, 38], iconAnchor: [19, 19], className: ''
    });
    const marker = L.marker([s.lat, s.lng], { icon }).addTo(map);
    marker.bindPopup(buildMapPopup(s, currentLang));
    mapMarkers[i] = marker;
  });
}

/* =========================================================
   WEATHER
   ========================================================= */
// Empty by default — buildGlobalsFromConfig() fills WX_LOCS[weatherKey] from each
// phase's own accommodation.weatherKey + mapStop lat/lng.
const WX_LOCS = {};
function wxIcon(c) {
  if (c === 0) return '☀️';
  if (c <= 3) return '🌤️';
  if (c <= 48) return '🌫️';
  if (c <= 57) return '🌦️';
  if (c <= 67) return '🌧️';
  if (c <= 77) return '❄️';
  if (c <= 82) return '🌦️';
  return '⛈️';
}
function dayName(iso) {
  const d = new Date(iso);
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return days[d.getDay()];
}
async function loadWx(id) {
  const el = document.getElementById('wx-' + id);
  if (!el) return;
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  if (el.dataset.loaded) return;
  const trWx = T[currentLang] || T['he'];
  el.innerHTML = `<span style="color:var(--ink-2)">${trWx.wx_loading}</span>`;
  const loc = WX_LOCS[id];
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=7`;
    const r = await fetch(url);
    const d = await r.json();
    const days = d.daily;
    const daysHtml = days.time.slice(0, 7).map((t, i) => `
      <div class="wx-day">
        <span class="wi">${wxIcon(days.weathercode[i])}</span>
        <span class="wt">${Math.round(days.temperature_2m_max[i])}° / ${Math.round(days.temperature_2m_min[i])}°</span>
        <span class="wd">${dayName(t)}<br>${t.slice(5)}</span>
      </div>`).join('');
    el.innerHTML = `<strong>${loc.name} — ${trWx.wx_forecast.replace('🌤 ', '')} 7 days</strong><div class="wx-days">${daysHtml}</div>`;
    el.dataset.loaded = '1';
  } catch (e) {
    el.innerHTML = `<span style="color:var(--urgent)">${trWx.wx_error}</span>`;
  }
}
window.loadWx = loadWx;

/* =========================================================
   POI (ITINERARY LOCATIONS) — expandable per-attraction panels
   ========================================================= */
const WX_CACHE = {};

// POI_DATA (maps/waze/ticket links keyed by data-poi id) intentionally removed —
// it only ever enhanced li[data-poi] elements, which lived exclusively in the
// static per-phase sections removed from index.html. venues[] in trip.config.json
// is the config-driven equivalent for a real trip's points of interest.

function _buildPoiBody(poi) {
  const venueRow = (v) => `
    <div class="poi-venue-name">${v.name}</div>
    <div class="poi-links">
      <a class="btn poi-btn" href="${v.maps}" target="_blank">🗺️ Maps</a>
      <a class="btn poi-btn" href="${v.waze}" target="_blank">🔵 Waze</a>
      ${v.tickets ? `<a class="btn poi-btn" href="${v.tickets}" target="_blank">🎫 אתר / כרטיסים</a>` : ''}
    </div>`;
  let html = '';
  if (poi.venues) {
    html = poi.venues.map((v, i) => (i > 0 ? '<hr class="poi-sep">' : '') + venueRow(v)).join('');
  } else {
    html = `<div class="poi-links">
      <a class="btn poi-btn" href="${poi.maps}" target="_blank">🗺️ Maps</a>
      <a class="btn poi-btn" href="${poi.waze}" target="_blank">🔵 Waze</a>
      ${poi.tickets ? `<a class="btn poi-btn" href="${poi.tickets.url}" target="_blank">🎫 ${poi.tickets.label}</a>` : ''}
    </div>`;
  }
  if (poi.wx) html += '<div class="poi-wx-wrap"></div>';
  return html;
}

async function _loadPoiWeather(wxWrap, wxKey) {
  if (!WX_LOCS[wxKey]) return;
  const trPoi = T[currentLang] || T['he'];
  wxWrap.dataset.loaded = '1';
  wxWrap.innerHTML = `<span class="loc-wx-loading">${trPoi.wx_loading}</span>`;
  try {
    if (!WX_CACHE[wxKey]) {
      const loc = WX_LOCS[wxKey];
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=7`;
      WX_CACHE[wxKey] = await (await fetch(url)).json();
    }
    const d = WX_CACHE[wxKey].daily;
    wxWrap.innerHTML = `<div class="loc-wx-label">${trPoi.wx_forecast}</div><div class="loc-wx-days">${d.time.slice(0,7).map((t,i) => `<div class="loc-wx-day"><span class="wi">${wxIcon(d.weathercode[i])}</span><div class="wt">${Math.round(d.temperature_2m_max[i])}°/${Math.round(d.temperature_2m_min[i])}°</div><div class="wd">${i === 0 ? (currentLang === 'he' ? 'היום' : 'Today') : dayName(t)}</div></div>`).join('')}</div>`;
  } catch(e) {
    wxWrap.innerHTML = `<span style="color:var(--urgent);font-size:12px">${trPoi.wx_error}</span>`;
  }
}

function initPoiItems() {
  document.querySelectorAll('li[data-poi]').forEach(li => {
    const poi = POI_DATA[li.dataset.poi];
    if (!poi) return;
    li.classList.add('poi-li');
    const expand = document.createElement('span');
    expand.className = 'poi-expand';
    expand.textContent = '▶';
    li.insertBefore(expand, li.firstChild);
    const body = document.createElement('div');
    body.className = 'poi-body';
    body.innerHTML = _buildPoiBody(poi);
    li.appendChild(body);
    li.addEventListener('click', function(e) {
      if (e.target.closest('a')) return;
      const isOpen = li.classList.contains('open');
      li.classList.toggle('open', !isOpen);
      if (!isOpen && poi.wx) {
        const wxWrap = body.querySelector('.poi-wx-wrap:not([data-loaded])');
        if (wxWrap) _loadPoiWeather(wxWrap, poi.wx);
      }
    });
  });
}
document.addEventListener('DOMContentLoaded', initPoiItems);

async function toggleLocPanel(btn) {
  const panel = btn.closest('.loc-panel');
  const body = panel.querySelector('.loc-panel-body');
  const wxKey = panel.dataset.wxkey;
  const willOpen = !body.classList.contains('open');
  body.classList.toggle('open', willOpen);
  btn.classList.toggle('open', willOpen);
  if (!willOpen || body.dataset.loaded) return;
  body.dataset.loaded = '1';
  const wxWrap = body.querySelector('.loc-wx-wrap');
  if (!wxWrap || !wxKey || !WX_LOCS[wxKey]) return;
  const loc = WX_LOCS[wxKey];
  const trLoc = T[currentLang] || T['he'];
  wxWrap.innerHTML = `<span class="loc-wx-loading">${trLoc.wx_loading}</span>`;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=2`;
    const r = await fetch(url);
    const d = await r.json();
    const days = d.daily;
    const labels = currentLang === 'he' ? ['היום', 'מחר'] : ['Today', 'Tomorrow'];
    const html = days.time.slice(0, 2).map((t, i) => `
      <div class="loc-wx-day">
        <span class="wi">${wxIcon(days.weathercode[i])}</span>
        <div class="wt">${Math.round(days.temperature_2m_max[i])}° / ${Math.round(days.temperature_2m_min[i])}°</div>
        <div class="wd">${labels[i]}<br><span style="font-family:var(--font-mono)">${t.slice(5)}</span></div>
        ${days.precipitation_sum[i] > 0.1 ? `<div class="rain">🌧️ ${days.precipitation_sum[i].toFixed(1)} mm</div>` : ''}
      </div>`).join('');
    wxWrap.innerHTML = `<div class="loc-wx-label">${trLoc.wx_forecast}</div><div class="loc-wx-days">${html}</div>`;
  } catch(e) {
    wxWrap.innerHTML = `<span style="color:var(--urgent);font-size:12px">${trLoc.wx_error}</span>`;
  }
}
window.toggleLocPanel = toggleLocPanel;

/* =========================================================
   RATINGS (server-backed, multi-user)
   ========================================================= */
// Empty by default — buildGlobalsFromConfig() fills VENUES[phase.id] from each
// phase's own venues[] in trip.config.json. No hardcoded per-phase fallback here
// on purpose: a phase without venues[] should show none, not another trip's.
let VENUES = {};

let allRatings = {};

async function loadRatings() {
  try {
    const res = await fetch('/api/ratings');
    if (res.ok) allRatings = await res.json();
  } catch {}
  ['ratings-ny', 'ratings-dallas', 'ratings-colorado', 'ratings-wc'].forEach((id, i) => {
    const key = ['ny', 'dallas', 'colorado', 'wc'][i];
    renderRatings(id, VENUES[key]);
  });
}

function buildRatingChips(venueId) {
  const ratings = allRatings[venueId] || {};
  return Object.entries(ratings).map(([u, r]) => {
    const color = window.USERS_CACHE?.[u]?.color || '#888';
    const name = uname(u);
    const isMe = currentUser?.username === u;
    const meLabel = (T[currentLang]||T['he']).rating_me;
    return `<span class="rating-chip${isMe ? ' rating-chip-me' : ''}" style="background:${color}" title="${name}: ${r}★">${isMe ? meLabel : name[0]} <span class="stars-val">${r}★</span></span>`;
  }).join('');
}

function renderRatings(containerId, venues) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = venues.map(v => {
    const myRating = currentUser ? (allRatings[v.id]?.[currentUser.username] || 0) : 0;
    const stars = [5, 4, 3, 2, 1].map(n => `<input type="radio" id="${v.id}-s${n}" name="${v.id}" value="${n}" ${myRating == n ? 'checked' : ''}><label for="${v.id}-s${n}">★</label>`).join('');
    const chips = buildRatingChips(v.id);
    const vname = typeof v.name === 'object' ? (v.name[currentLang] || v.name.he) : v.name;
    return `<div class="rating-card" id="rc-${v.id}">
      <h4>${vname}</h4>
      <div class="stars">${stars}</div>
      <textarea class="rating-note" id="note-${v.id}" placeholder="${(T[currentLang]||T['he']).rating_note_ph}"></textarea>
      <br>
      <button class="save-btn" onclick="saveRating('${v.id}')">${(T[currentLang]||T['he']).rating_save}</button>
      <span class="saved-msg" id="saved-${v.id}">${(T[currentLang]||T['he']).rating_saved}</span>
      <a class="trip-link" href="${v.url}" target="_blank">${(T[currentLang]||T['he']).rating_ta_link}</a>
      <div class="rating-others" id="ro-${v.id}">${chips}</div>
      <button class="vc-toggle" id="vc-toggle-${v.id}" onclick="toggleVenueComments('${v.id}')">💬 ${(T[currentLang]||T['he']).ph_comments}</button>
      <div class="vc-thread" id="vc-thread-${v.id}"></div>
    </div>`;
  }).join('');
}

async function saveRating(id) {
  const stars = document.querySelector(`input[name="${id}"]:checked`)?.value;
  if (!stars || !currentUser) return;
  const token = localStorage.getItem('trip-token');
  try {
    await fetch('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ venue: id, rating: parseInt(stars) })
    });
    if (!allRatings[id]) allRatings[id] = {};
    allRatings[id][currentUser.username] = parseInt(stars);
    const ro = document.getElementById('ro-' + id);
    if (ro) ro.innerHTML = buildRatingChips(id);
    const msg = document.getElementById('saved-' + id);
    if (msg) { msg.style.display = 'inline'; setTimeout(() => msg.style.display = 'none', 2000); }
  } catch {}
}
window.saveRating = saveRating;

/* =========================================================
   VENUE COMMENTS
   ========================================================= */
const venueCommentsCache = {};

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


async function toggleVenueComments(venueId) {
  const thread = document.getElementById(`vc-thread-${venueId}`);
  const btn    = document.getElementById(`vc-toggle-${venueId}`);
  if (!thread) return;

  if (!venueCommentsCache[venueId]) {
    try {
      const res = await fetch(`/api/comments/venue/${venueId}`);
      venueCommentsCache[venueId] = res.ok ? await res.json() : [];
    } catch { venueCommentsCache[venueId] = []; }
  }

  const isOpen = thread.classList.contains('open');
  if (isOpen) {
    thread.classList.remove('open');
    const n = venueCommentsCache[venueId].length;
    btn.textContent = `💬 ${n} ${(T[currentLang]||T['he']).ph_comments}`;
  } else {
    renderVenueCommentThread(venueId);
    thread.classList.add('open');
  }
}

function renderVenueCommentThread(venueId) {
  const thread = document.getElementById(`vc-thread-${venueId}`);
  const btn    = document.getElementById(`vc-toggle-${venueId}`);
  if (!thread) return;
  const comments = venueCommentsCache[venueId] || [];
  if (btn) btn.textContent = `💬 ${comments.length} ${(T[currentLang]||T['he']).ph_comments} ▲`;

  const list = comments.map(c => {
    const color = c.user?.color || '#888';
    const name  = uname(c.username, c.user);
    const time  = new Date(c.created_at).toLocaleDateString('he-IL');
    return `<div class="vc-comment">
      <div class="vc-avatar" style="background:${color}">${name[0]}</div>
      <div>
        <span class="vc-name">${escapeHtml(name)}</span><span class="vc-meta">${time}</span>
        <div class="vc-body">${escapeHtml(c.body)}</div>
      </div>
    </div>`;
  }).join('');

  const trC = T[currentLang] || T['he'];
  const inputHtml = currentUser ? `
    <div class="vc-input-row">
      <input class="vc-input" id="vc-input-${venueId}" type="text" placeholder="${trC.ph_comment_ph}"
        onkeydown="if(event.key==='Enter')submitVenueComment('${venueId}')">
      <button class="vc-send" onclick="submitVenueComment('${venueId}')">${trC.ph_send}</button>
    </div>` : '';

  thread.innerHTML = list + inputHtml;
}

async function submitVenueComment(venueId) {
  if (!currentUser) return;
  const input = document.getElementById(`vc-input-${venueId}`);
  const body  = input?.value.trim();
  if (!body) return;
  const token = localStorage.getItem('trip-token');
  try {
    const res = await fetch(`/api/comments/venue/${venueId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body })
    });
    if (!res.ok) return;
    const comment = await res.json();
    if (!venueCommentsCache[venueId]) venueCommentsCache[venueId] = [];
    venueCommentsCache[venueId].push(comment);
    input.value = '';
    renderVenueCommentThread(venueId);
  } catch {}
}
window.toggleVenueComments = toggleVenueComments;
window.submitVenueComment  = submitVenueComment;

/* =========================================================
   RSVPs
   ========================================================= */
// Empty by default — buildGlobalsFromConfig() fills RSVP_ACTIVITIES[phase.id] from
// each phase's own rsvp_activities[] in trip.config.json. No hardcoded fallback
// here on purpose, same reasoning as VENUES above.
let RSVP_ACTIVITIES = {};

const rsvpCache = {};

async function loadRsvps(containerId, activities) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Fetch all activities for this section in parallel
  await Promise.all(activities.map(async a => {
    try {
      const res = await fetch(`/api/rsvps/${a.id}`);
      rsvpCache[a.id] = res.ok ? await res.json() : [];
    } catch { rsvpCache[a.id] = []; }
  }));

  container.innerHTML = activities.map(a => renderRsvpCard(a)).join('');
}

function renderRsvpCard(activity) {
  const rsvps = rsvpCache[activity.id] || [];
  const myRsvp = currentUser ? rsvps.find(r => r.username === currentUser.username) : null;
  const tr = T[currentLang] || T['he'];
  const title = typeof activity.title === 'object' ? (activity.title[currentLang] || activity.title.he) : activity.title;
  const price = typeof activity.price === 'object' ? (activity.price[currentLang] || activity.price.he) : activity.price;

  const statusLabel = { yes: tr.rsvp_status_yes, no: tr.rsvp_status_no, maybe: tr.rsvp_status_maybe };
  const chips = rsvps.map(r => {
    const emoji = r.status === 'yes' ? '✅' : r.status === 'no' ? '❌' : '🤔';
    const color = r.user?.color || '#888';
    const name  = uname(r.username, r.user);
    return `<span class="rsvp-chip" style="background:${color}" title="${name}: ${statusLabel[r.status] || r.status}">${emoji} ${name}</span>`;
  }).join('');

  const btnClass = (s) => `rsvp-btn${myRsvp?.status === s ? ` active-${s}` : ''}`;

  return `<div class="rsvp-card" id="rsvp-card-${activity.id}">
    <div class="rsvp-title">${title}</div>
    <div class="rsvp-meta">📅 ${activity.date} · ${price}</div>
    ${currentUser ? `<div class="rsvp-btns">
      <button class="${btnClass('yes')}"   onclick="setRsvp('${activity.id}','yes'  )">${tr.rsvp_yes}</button>
      <button class="${btnClass('no')}"    onclick="setRsvp('${activity.id}','no'   )">${tr.rsvp_no}</button>
      <button class="${btnClass('maybe')}" onclick="setRsvp('${activity.id}','maybe')">${tr.rsvp_maybe}</button>
    </div>` : ''}
    ${chips ? `<div class="rsvp-responses">${chips}</div>` : ''}
  </div>`;
}

async function setRsvp(activityId, status) {
  if (!currentUser) return;
  const token = localStorage.getItem('trip-token');
  try {
    const res = await fetch(`/api/rsvps/${activityId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status })
    });
    if (!res.ok) return;
    // Update cache
    if (!rsvpCache[activityId]) rsvpCache[activityId] = [];
    const existing = rsvpCache[activityId].findIndex(r => r.username === currentUser.username);
    const entry = { username: currentUser.username, status, user: currentUser };
    if (existing >= 0) rsvpCache[activityId][existing] = entry;
    else rsvpCache[activityId].push(entry);

    // Find which section this activity belongs to and re-render the card only
    const allActivities = [...RSVP_ACTIVITIES.co, ...RSVP_ACTIVITIES.wc];
    const activity = allActivities.find(a => a.id === activityId);
    if (activity) {
      const card = document.getElementById(`rsvp-card-${activityId}`);
      if (card) card.outerHTML = renderRsvpCard(activity);
    }
  } catch {}
}
window.setRsvp = setRsvp;

/* =========================================================
   PACKING
   ========================================================= */
// Only a generic packing_general default lives here — buildGlobalsFromConfig()
// overwrites PACKING.general from cfg.packing_general when the trip provides one,
// and fills PACKING[phase.id] per phase from phase.packing[]. No hardcoded
// per-phase (colorado/wc/etc.) fallback, same reasoning as VENUES above.
let PACKING = {
  general: [
    [{ he: 'מסמכים',     en: 'Documents'    }, { he: 'דרכון',           en: 'Passport'           }],
    [{ he: 'מסמכים',     en: 'Documents'    }, { he: 'ביטוח נסיעות',     en: 'Travel insurance'    }],
    [{ he: 'אלקטרוניקה', en: 'Electronics'  }, { he: 'מטען + כבלים',     en: 'Charger + cables'    }],
    [{ he: 'בריאות',     en: 'Health'       }, { he: 'תרופות קבועות',    en: 'Regular medications' }],
  ],
};
function renderPacking(containerId, items) {
  const c = document.getElementById(containerId);
  if (!c) return;
  const lang = currentLang || 'he';
  const cats = {};
  // buildGlobalsFromConfig() only sets PACKING[phase.id] when phase.packing is
  // non-empty, but the pack-<id> container div is created for *every* phase —
  // so a phase with "packing": [] resolves to undefined here. The initial
  // render guards with `if (p.packing?.length)`, applyLang() does not, and an
  // unguarded throw there aborts the rest of the language switch (RSVP cards
  // and everything after it silently stop re-rendering). Normalize at the
  // choke point so all four call sites are safe.
  (Array.isArray(items) ? items : []).forEach(([catObj, itemObj]) => {
    const cat  = catObj[lang]  || catObj.he;
    const item = itemObj[lang] || itemObj.he;
    (cats[cat] = cats[cat] || []).push({ key: itemObj.he, label: item });
  });
  c.innerHTML = Object.entries(cats).map(([cat, itms]) => `
    <div class="pack-cat">
      <h4>${cat}</h4>
      ${itms.map(({ key, label }) => {
        const storeKey = `pack-${containerId}-${key}`;
        const checked = localStorage.getItem(storeKey) === '1';
        return `<div class="pack-item">
          <input type="checkbox" id="${storeKey}" ${checked ? 'checked' : ''} onchange="localStorage.setItem('${storeKey}',this.checked?'1':'0')">
          <label for="${storeKey}">${label}</label>
        </div>`;
      }).join('')}
    </div>`).join('');
}

/* =========================================================
   PHOTOS (server-backed, multi-user)
   ========================================================= */
async function checkImmichStatus() {
  const dot = document.getElementById('immich-dot');
  const txt = document.getElementById('immich-status-text');
  if (!dot || !txt) return;
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    const tr = T[currentLang] || T['he'];
    if (d.immich) { dot.className = 'immich-dot ok'; txt.textContent = tr.immich_ok; }
    else { dot.className = 'immich-dot err'; txt.textContent = tr.immich_err; }
  } catch {
    const tr = T[currentLang] || T['he'];
    dot.className = 'immich-dot err';
    txt.textContent = tr.immich_offline;
  }
}

function triggerUpload(phase) {
  if (!currentUser) return;
  document.getElementById('file-' + phase).click();
}

async function uploadPhotos(phase, input) {
  const token = localStorage.getItem('trip-token');
  if (!token) return;
  const log = document.getElementById('upload-log');
  const files = Array.from(input.files);
  if (!files.length) return;

  // Build progress UI
  const tr = T[currentLang] || T['he'];
  const progressId = 'upload-progress-' + Date.now();
  const uploadTitle = tr.upload_uploading.replace('{n}', files.length);
  const progressHtml = `<div id="${progressId}" class="upload-progress-box">
    <div class="upload-progress-title">${uploadTitle}</div>
    ${files.map((f, i) => `<div class="upload-row" id="${progressId}-${i}">
      <span class="upload-spinner">⏳</span>
      <span class="upload-fname">${f.name}</span>
      <div class="upload-bar-wrap"><div class="upload-bar" id="${progressId}-bar-${i}"></div></div>
    </div>`).join('')}
  </div>`;
  if (log) log.innerHTML = progressHtml + log.innerHTML;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rowEl = document.getElementById(`${progressId}-${i}`);
    const barEl = document.getElementById(`${progressId}-bar-${i}`);
    const spinEl = rowEl?.querySelector('.upload-spinner');

    try {
      await new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('photo', file);
        fd.append('phase', phase);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/photos/upload');
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && barEl) barEl.style.width = `${Math.round(e.loaded / e.total * 100)}%`;
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const data = JSON.parse(xhr.responseText);
            if (spinEl) spinEl.textContent = '✅';
            if (barEl) { barEl.style.width = '100%'; barEl.classList.add('done'); }
            prependPhotoCard(data.photo, phase);
            resolve(data);
          } else {
            if (spinEl) spinEl.textContent = '❌';
            reject(new Error(`שגיאה ${xhr.status}`));
          }
        };
        xhr.onerror = () => { if (spinEl) spinEl.textContent = '❌'; reject(new Error(tr.upload_network_err)); };
        xhr.send(fd);
      });
    } catch (e) {
      if (rowEl) rowEl.querySelector('.upload-fname').textContent += ` — ${e.message}`;
    }
  }

  // After all done — collapse progress after 3s
  setTimeout(() => {
    const box = document.getElementById(progressId);
    if (box) box.classList.add('upload-done');
  }, 3000);

  input.value = '';
}

function initDragDrop() {
  document.querySelectorAll('.photo-upload-area[data-phase]').forEach(area => {
    const phase = area.dataset.phase;

    area.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      area.classList.add('drag-over');
    });

    area.addEventListener('dragleave', e => {
      if (area.contains(e.relatedTarget)) return;
      area.classList.remove('drag-over');
    });

    area.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      area.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length) uploadPhotos(phase, { files });
    });
  });
}

// In-memory stores for photo social data
let allPhotoReactions = {};   // { photoId: { emoji: [username,...] } }
const photoCommentsCache = {}; // { photoId: [comment,...] }

const REACTION_EMOJIS = ['❤️','😂','🔥','😍','👏'];

const ALBUM_SHARE_URLS = {};

async function loadAlbumShareLinks() {
  for (const phase of ['ny', 'dallas', 'colorado', 'wc']) {
    try {
      const res = await fetch(`/api/album-share/${phase}`);
      if (!res.ok) continue;
      const { url } = await res.json();
      ALBUM_SHARE_URLS[phase] = url;
      const label = (T[currentLang] || T['he']).album_open;
      const link = `<a class="album-share-btn" href="${url}" target="_blank">${label}</a>`;
      document.querySelectorAll(`[data-album-phase="${phase}"]`).forEach(el => { el.innerHTML = link; });
    } catch {
      document.querySelectorAll(`[data-album-phase="${phase}"]`).forEach(el => { el.innerHTML = ''; });
    }
  }
}

function sharePhotoFacebook(photoId) {
  window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(`${location.origin}/photo/${photoId}`)}`, '_blank');
}

async function sharePhotoInstagram(filename) {
  const photoUrl = `/api/photos/file/${filename}`;
  try {
    const blob = await fetch(photoUrl).then(r => r.blob());
    const ext = filename.split('.').pop() || 'jpg';
    const file = new File([blob], `photo.${ext}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: document.title });
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  // Desktop fallback: download the image
  const a = document.createElement('a');
  a.href = photoUrl; a.download = filename; a.click();
}

function askDeletePhoto(id) {
  const tr = T[currentLang] || T['he'];
  const wrap = document.getElementById(`pgdel-${id}`);
  if (!wrap) return;
  wrap.innerHTML = `
    <span class="pg-delete-confirm-txt">${tr.ph_delete_confirm}</span>
    <button class="pg-delete-confirm-yes" onclick="confirmDeletePhoto('${id}')" title="${tr.ph_delete_yes}">✓</button>
    <button class="pg-delete-confirm-no"  onclick="cancelDeletePhoto('${id}')"  title="${tr.ph_delete_no}">✕</button>`;
}

function cancelDeletePhoto(id) {
  const tr = T[currentLang] || T['he'];
  const wrap = document.getElementById(`pgdel-${id}`);
  if (!wrap) return;
  wrap.innerHTML = `<button class="pg-delete-btn" onclick="askDeletePhoto('${id}')" title="${tr.ph_delete}">🗑️</button>`;
}

async function confirmDeletePhoto(id) {
  const tr = T[currentLang] || T['he'];
  const token = localStorage.getItem('trip-token');
  const wrap = document.getElementById(`pgdel-${id}`);
  if (wrap) wrap.innerHTML = `<span class="pg-delete-confirm-txt">${tr.ph_deleting}</span>`;
  try {
    const res = await fetch(`/api/photos/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    document.getElementById(`pgcard-${id}`)?.remove();
  } catch (e) {
    if (wrap) wrap.innerHTML = `<span class="pg-delete-confirm-txt" style="color:var(--urgent)">${tr.ph_delete_err}</span>`;
    setTimeout(() => cancelDeletePhoto(id), 2000);
  }
}

window.askDeletePhoto     = askDeletePhoto;
window.cancelDeletePhoto  = cancelDeletePhoto;
window.confirmDeletePhoto = confirmDeletePhoto;

function buildPhotoCard(p, reactions) {
  const tr     = T[currentLang] || T['he'];
  const color  = p.user?.color  || '#888';
  const name   = uname(p.username, p.user);
  const date   = new Date(p.uploadedAt).toLocaleDateString('he-IL');

  const myReactions = new Set(
    REACTION_EMOJIS.filter(e => reactions?.[e]?.includes(currentUser?.username))
  );

  const reactionBar = REACTION_EMOJIS.map(e => {
    const users = reactions?.[e] || [];
    const count = users.length;
    const active = myReactions.has(e) ? 'active' : '';
    const tooltip = users.map(u => uname(u)).join(', ');
    return `<button class="pg-react-btn ${active}" title="${tooltip}" onclick="togglePhotoReaction('${p.id}','${e}')">${e}${count > 0 ? `<span>${count}</span>` : ''}</button>`;
  }).join('');

  const commentCount = photoCommentsCache[p.id]?.length ?? 0;

  const isOwner = currentUser?.username === p.username;

  return `<div class="pg-card" id="pgcard-${p.id}">
    <img src="/api/photos/file/${p.filename}" loading="lazy" alt="">
    ${isOwner ? `<div class="pg-delete-wrap" id="pgdel-${p.id}">
      <button class="pg-delete-btn" onclick="askDeletePhoto('${p.id}')" title="${tr.ph_delete}">🗑️</button>
    </div>` : ''}
    <div class="pg-meta">
      <div class="pg-avatar" style="background:${color}">${name[0]}</div>
      <div class="pg-info"><div class="pg-name">${escapeHtml(name)}</div><div>${date}</div></div>
      <div class="pg-share-btns">
        <button class="pg-share-btn pg-share-fb" onclick="sharePhotoFacebook('${p.id}')" title="${tr.ph_share_fb}"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></button>
        <button class="pg-share-btn pg-share-ig" onclick="sharePhotoInstagram('${p.filename}')" title="${tr.ph_share_ig}"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></button>
      </div>
    </div>
    <div class="pg-reaction-bar" id="pg-reactions-${p.id}">${reactionBar}</div>
    <button class="vc-toggle pg-ct" id="pg-ct-${p.id}" onclick="togglePhotoComments('${p.id}')">💬 ${commentCount} ${tr.ph_comments}</button>
    <div class="vc-thread" id="pg-thread-${p.id}"></div>
  </div>`;
}

function prependPhotoCard(photo, phase) {
  const galleryIds = ['photos-gallery'];
  const actualPhase = phase || photo.phase;
  if (actualPhase) galleryIds.push(`phase-gallery-${actualPhase}`);
  galleryIds.forEach(id => {
    const gallery = document.getElementById(id);
    if (!gallery) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildPhotoCard(photo, {});
    gallery.prepend(wrapper.firstElementChild);
  });
}

async function loadPhaseAlbum(phase) {
  const gallery = document.getElementById(`phase-gallery-${phase}`);
  if (!gallery || gallery.dataset.loaded === '1') return;
  gallery.dataset.loaded = '1';
  const tr = T[currentLang] || T['he'];
  gallery.innerHTML = `<p style="color:var(--ink-2);padding:16px 0">${tr.album_loading || '...'}</p>`;
  try {
    const [photosRes, reactionsRes, commentsRes] = await Promise.all([
      fetch(`/api/photos?phase=${phase}`),
      fetch('/api/reactions'),
      fetch('/api/comments/photo'),
    ]);
    const photos      = photosRes.ok   ? await photosRes.json()   : [];
    const reactions   = reactionsRes.ok ? await reactionsRes.json() : {};
    const allComments = commentsRes.ok  ? await commentsRes.json() : {};
    Object.assign(photoCommentsCache, allComments);
    Object.assign(allPhotoReactions, reactions);
    gallery.innerHTML = photos.length
      ? photos.map(p => buildPhotoCard(p, reactions[p.id])).join('')
      : `<p style="color:var(--ink-2);padding:16px 0">${tr.album_empty || 'אין תמונות עדיין'}</p>`;
    loadAlbumShareLinks();
  } catch {
    gallery.dataset.loaded = '';
    gallery.innerHTML = '';
  }
}

async function loadPhotosGallery(phase) {
  const gallery = document.getElementById('photos-gallery');
  if (!gallery) return;
  try {
    const [photosRes, reactionsRes, commentsRes] = await Promise.all([
      fetch(phase ? `/api/photos?phase=${phase}` : '/api/photos'),
      fetch('/api/reactions'),
      fetch('/api/comments/photo'),
    ]);
    const photos   = photosRes.ok   ? await photosRes.json()    : [];
    allPhotoReactions          = reactionsRes.ok ? await reactionsRes.json() : {};
    const allComments          = commentsRes.ok  ? await commentsRes.json()  : {};
    // Pre-populate comments cache
    Object.assign(photoCommentsCache, allComments);

    gallery.innerHTML = photos.map(p => buildPhotoCard(p, allPhotoReactions[p.id])).join('');
    loadAlbumShareLinks();
  } catch {}
}

async function togglePhotoReaction(photoId, emoji) {
  if (!currentUser) return;
  const token = localStorage.getItem('trip-token');
  try {
    const res = await fetch(`/api/reactions/${photoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emoji })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!allPhotoReactions[photoId]) allPhotoReactions[photoId] = {};
    const users = allPhotoReactions[photoId][emoji] || [];
    if (data.action === 'added') {
      if (!users.includes(currentUser.username)) allPhotoReactions[photoId][emoji] = [...users, currentUser.username];
    } else {
      allPhotoReactions[photoId][emoji] = users.filter(u => u !== currentUser.username);
    }
    // Re-render the reaction bar only
    const bar = document.getElementById(`pg-reactions-${photoId}`);
    if (bar) {
      const myReactions = new Set(REACTION_EMOJIS.filter(e => allPhotoReactions[photoId]?.[e]?.includes(currentUser.username)));
      bar.innerHTML = REACTION_EMOJIS.map(e => {
        const users2 = allPhotoReactions[photoId]?.[e] || [];
        const count = users2.length;
        const active = myReactions.has(e) ? 'active' : '';
        const tooltip = users2.map(u => window.USERS_CACHE?.[u]?.name || u).join(', ');
        return `<button class="pg-react-btn ${active}" title="${tooltip}" onclick="togglePhotoReaction('${photoId}','${e}')">${e}${count > 0 ? `<span>${count}</span>` : ''}</button>`;
      }).join('');
    }
  } catch {}
}

async function togglePhotoComments(photoId) {
  const thread = document.getElementById(`pg-thread-${photoId}`);
  const btn    = document.getElementById(`pg-ct-${photoId}`);
  if (!thread) return;

  if (!photoCommentsCache[photoId]) {
    try {
      const res = await fetch(`/api/comments/photo/${photoId}`);
      photoCommentsCache[photoId] = res.ok ? await res.json() : [];
    } catch { photoCommentsCache[photoId] = []; }
  }

  const isOpen = thread.classList.contains('open');
  if (isOpen) {
    thread.classList.remove('open');
    if (btn) btn.textContent = `💬 ${photoCommentsCache[photoId].length} ${(T[currentLang]||T['he']).ph_comments}`;
  } else {
    renderPhotoCommentThread(photoId);
    thread.classList.add('open');
  }
}

function renderPhotoCommentThread(photoId) {
  const thread = document.getElementById(`pg-thread-${photoId}`);
  const btn    = document.getElementById(`pg-ct-${photoId}`);
  if (!thread) return;
  const comments = photoCommentsCache[photoId] || [];
  if (btn) btn.textContent = `💬 ${comments.length} ${(T[currentLang]||T['he']).ph_comments} ▲`;

  const list = comments.map(c => {
    const color = c.user?.color || '#888';
    const name  = uname(c.username, c.user);
    const time  = new Date(c.created_at).toLocaleDateString('he-IL');
    return `<div class="vc-comment">
      <div class="vc-avatar" style="background:${color}">${name[0]}</div>
      <div>
        <span class="vc-name">${escapeHtml(name)}</span><span class="vc-meta">${time}</span>
        <div class="vc-body">${escapeHtml(c.body)}</div>
      </div>
    </div>`;
  }).join('');

  const trPC = T[currentLang] || T['he'];
  const inputHtml = currentUser ? `
    <div class="vc-input-row">
      <input class="vc-input" id="pg-input-${photoId}" type="text" placeholder="${trPC.ph_comment_ph}"
        onkeydown="if(event.key==='Enter')submitPhotoComment('${photoId}')">
      <button class="vc-send" onclick="submitPhotoComment('${photoId}')">${trPC.ph_send}</button>
    </div>` : '';

  thread.innerHTML = list + inputHtml;
}

async function submitPhotoComment(photoId) {
  if (!currentUser) return;
  const input = document.getElementById(`pg-input-${photoId}`);
  const body  = input?.value.trim();
  if (!body) return;
  const token = localStorage.getItem('trip-token');
  try {
    const res = await fetch(`/api/comments/photo/${photoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body })
    });
    if (!res.ok) return;
    const comment = await res.json();
    if (!photoCommentsCache[photoId]) photoCommentsCache[photoId] = [];
    photoCommentsCache[photoId].push(comment);
    input.value = '';
    renderPhotoCommentThread(photoId);
    // Update comment count on toggle button
    const btn = document.getElementById(`pg-ct-${photoId}`);
    if (btn) btn.textContent = `💬 ${photoCommentsCache[photoId].length} ${(T[currentLang]||T['he']).ph_comments} ▲`;
  } catch {}
}
window.togglePhotoReaction  = togglePhotoReaction;
window.togglePhotoComments  = togglePhotoComments;
window.submitPhotoComment   = submitPhotoComment;
window.toggleTaskDone       = toggleTaskDone;

window.triggerUpload = triggerUpload;
window.uploadPhotos = uploadPhotos;

/* =========================================================
   LOST & FOUND
   ========================================================= */
function showLostFoundForm() {
  document.getElementById('lf-overlay').style.display = 'flex';
}
function hideLostFoundForm() {
  document.getElementById('lf-overlay').style.display = 'none';
  ['lf-name','lf-phone','lf-location','lf-item'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const err = document.getElementById('lf-err');
  if (err) err.textContent = '';
}
async function submitLostFound() {
  const name     = document.getElementById('lf-name')?.value.trim();
  const phone    = document.getElementById('lf-phone')?.value.trim();
  const location = document.getElementById('lf-location')?.value.trim();
  const item     = document.getElementById('lf-item')?.value.trim();
  const err      = document.getElementById('lf-err');
  const tr = T[currentLang] || T['he'];

  const showErr = (msg) => {
    if (!err) return;
    err.style.color = 'var(--urgent)';
    err.textContent = msg;
  };

  if (!name || !item) { showErr(tr.lf_err_req || 'נא למלא שם ותיאור הפריט.'); return; }
  const btn = document.querySelector('.lf-submit');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/lost-found', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, location, item }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
    if (err) { err.style.color = 'var(--ok)'; err.textContent = tr.lf_success || '✅ הדיווח נשלח!'; }
    if (btn) btn.style.display = 'none';
    document.querySelectorAll('.lf-box input, .lf-box textarea').forEach(el => el.style.display = 'none');
  } catch (e) {
    showErr((tr.lf_err_server || 'שגיאה בשליחה.') + ' — ' + e.message);
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   PARTICIPANT ENROLLMENT (one-time #enroll=<token> link)
   Fragment, not a query param: never sent to the server (so it can't land
   in an access log) and excluded from Referer headers by the URL spec
   itself (so no cross-origin leak to the third-party origins this page
   loads) — stronger than a query string plus a referrer-policy meta tag.
   ========================================================= */
function enrollmentTokenFromUrl() {
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('enroll');
}
function showEnrollmentForm() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('enroll-overlay').style.display = 'flex';
}
async function submitEnrollment() {
  const token = enrollmentTokenFromUrl();
  const password = document.getElementById('enroll-pwd-input')?.value || '';
  const confirmPassword = document.getElementById('enroll-pwd-confirm-input')?.value || '';
  const err = document.getElementById('enroll-err');
  const tr = T[currentLang] || T['he'];

  const showErr = (msg) => { if (err) { err.style.color = 'var(--urgent)'; err.textContent = msg; } };

  if (!token) { showErr(tr.enroll_err_invalid || 'קישור לא תקין.'); return; }
  if (password.length < 4) { showErr(tr.enroll_err_short || 'הסיסמה קצרה מדי.'); return; }
  if (password !== confirmPassword) { showErr(tr.enroll_err_mismatch || 'הסיסמאות אינן תואמות.'); return; }

  try {
    const res = await fetch('/api/auth/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const messages = {
        invalid_or_used_token: tr.enroll_err_invalid || 'הקישור אינו תקף או שכבר נעשה בו שימוש.',
        token_expired: tr.enroll_err_expired || 'פג תוקף הקישור — בקש/י קישור חדש.',
      };
      showErr(messages[data.error] || tr.enroll_err_server || 'שגיאה בשמירת הסיסמה.');
      return;
    }
    // Land on the normal login screen, password-ready — never auto-login
    // with a password that was just typed into a one-time-link page.
    window.location.href = window.location.pathname;
  } catch {
    showErr(tr.enroll_err_server || 'שגיאה בשמירת הסיסמה.');
  }
}
window.submitEnrollment = submitEnrollment;

async function loadLostFound() {
  const list = document.getElementById('lf-list');
  if (!list) return;
  const token = localStorage.getItem('trip-token');
  if (!token) return;
  try {
    const res = await fetch('/api/lost-found', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const items = await res.json();
    const badge = document.getElementById('lf-badge');
    const newCount = items.filter(i => !i.resolved).length;
    if (badge) {
      badge.textContent = newCount;
      badge.style.display = newCount > 0 ? 'inline-flex' : 'none';
    }
    const tr = T[currentLang];
    const locale = currentLang === 'he' ? 'he-IL' : 'en-US';
    if (!items.length) { list.innerHTML = `<p style="color:var(--ink-2);text-align:center;padding:40px 0">${tr.lf_empty}</p>`; return; }
    list.innerHTML = items.map(i => `
      <div class="lf-card ${i.resolved ? 'lf-resolved' : ''}" id="lf-card-${i.id}">
        <div class="lf-card-header">
          <span class="lf-status-dot ${i.resolved ? 'resolved' : 'open'}"></span>
          <strong class="lf-finder">${escapeHtml(i.name)}</strong>
          <span class="lf-time">${new Date(i.created_at).toLocaleString(locale)}</span>
        </div>
        <div class="lf-card-item">🎒 ${escapeHtml(i.item)}</div>
        ${i.location ? `<div class="lf-card-loc">📍 ${escapeHtml(i.location)}</div>` : ''}
        ${i.phone ? `<div class="lf-card-contact">📞 <a href="tel:${encodeURIComponent(i.phone)}">${escapeHtml(i.phone)}</a></div>` : ''}
        <button class="lf-resolve-btn" onclick="toggleLfResolve(${i.id}, ${i.resolved ? 0 : 1})">
          ${i.resolved ? tr.lf_reopen : tr.lf_resolve}
        </button>
      </div>`).join('');
  } catch {}
}

async function toggleLfResolve(id, resolved) {
  const token = localStorage.getItem('trip-token');
  await fetch(`/api/lost-found/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
  loadLostFound();
}

window.showLostFoundForm  = showLostFoundForm;
window.hideLostFoundForm  = hideLostFoundForm;
window.submitLostFound    = submitLostFound;
window.toggleLfResolve    = toggleLfResolve;

/* =========================================================
   BUDGET
   ========================================================= */
// Rebuilt entirely from cfg.budget.phase_labels at runtime (see
// buildGlobalsFromConfig()) — starts empty, not pinned to one trip's phases.
const BUDGET_PHASES = {};
// Rebuilt from cfg.budget.phases at runtime (see buildGlobalsFromConfig(), which
// clears this via .length = 0 before repopulating) — starts empty on purpose.
const BUDGET_PHASE_ORDER = [];

const BUDGET_CAT_ICON = { flight:'✈️', hotel:'🏨', car:'🚗', attraction:'🎡', food:'🍽️', insurance:'🛡️', other:'📌' };

async function loadBudget() {
  const token = localStorage.getItem('trip-token');
  const content  = document.getElementById('budget-content');
  const grandEl  = document.getElementById('budget-grand-total');
  const addWrap  = document.getElementById('budget-add-wrap');
  const missingEl = document.getElementById('budget-missing-alert');
  if (!content) return;
  try {
    const res = await fetch('/api/budget', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(res.status);
    const items = await res.json();

    // Group by phase
    const byPhase = {};
    for (const item of items) {
      if (!byPhase[item.phase]) byPhase[item.phase] = [];
      byPhase[item.phase].push(item);
    }

    let grandTotal = 0;
    const missingItems = [];
    const isHe = currentLang === 'he';
    let html = '';

    for (const phase of BUDGET_PHASE_ORDER) {
      const phaseItems = byPhase[phase] || [];
      if (!phaseItems.length) continue;
      const phaseMeta = BUDGET_PHASES[phase];
      const phaseLabel = isHe ? phaseMeta.label : phaseMeta.en;
      let phaseTotal = 0;
      let rows = '';
      for (const item of phaseItems) {
        const icon = BUDGET_CAT_ICON[item.category] || '📌';
        const isUnknown = item.is_estimate && item.amount === 0;
        const amtStr = isUnknown ? '?' : (item.is_estimate ? `~$${item.amount.toLocaleString()}` : `$${item.amount.toLocaleString()}`);
        if (isUnknown) missingItems.push(item.description);
        if (!isUnknown) phaseTotal += item.amount;
        const amtClass = isUnknown ? 'budget-unknown' : item.is_estimate ? 'budget-est' : '';
        rows += `<tr class="${isUnknown ? 'budget-row-missing' : ''}" id="brow-${item.id}">
          <td class="budget-icon-cell">${icon}</td>
          <td class="budget-desc">${escapeHtml(item.description)}</td>
          <td class="budget-amount ${amtClass}" id="bamt-${item.id}">${amtStr}</td>
          ${token ? `<td class="budget-actions">
            <button class="budget-edit-btn" onclick="startEditBudget(${item.id},${item.amount})" title="ערוך">✏️</button>
            <button class="budget-del-btn" onclick="deleteBudgetItem(${item.id})" title="מחק">×</button>
          </td>` : '<td></td>'}
        </tr>`;
        grandTotal += isUnknown ? 0 : item.amount;
      }

      html += `<div class="budget-phase-card">
        <div class="budget-phase-header">
          <span class="budget-phase-label">${phaseLabel}</span>
          <span class="budget-phase-subtotal">$${phaseTotal.toLocaleString()}</span>
        </div>
        <table class="budget-table"><tbody>${rows}</tbody></table>
      </div>`;
    }

    const trB = T[currentLang] || T['he'];
    content.innerHTML = html || `<p style="opacity:.5;padding:16px">${trB.budget_no_data}</p>`;

    // Grand total
    grandEl.style.display = 'block';
    grandEl.innerHTML = `
      <span>סה״כ${missingItems.length ? ` (ללא ${missingItems.length} פריטים חסרים)` : ''}</span>
      <span class="budget-grand-num">$${grandTotal.toLocaleString()}</span>
      <span class="budget-per-person">≈ $${Math.round(grandTotal / (window.TRIP_CONFIG?.budget?.party_size || 7)).toLocaleString()} לנפש</span>`;

    // Missing alert
    if (missingItems.length) {
      missingEl.style.display = '';
      missingEl.innerHTML = `⚠️ <strong>הוצאות חסרות (${missingItems.length}):</strong> ${missingItems.map(d => escapeHtml(d)).join(' · ')}`;
    } else {
      missingEl.style.display = 'none';
    }

    // Show add form if logged in
    if (addWrap) addWrap.style.display = token ? '' : 'none';

  } catch (e) {
    const trBErr = T[currentLang] || T['he'];
    content.innerHTML = `<p style="color:var(--urgent)">${trBErr.budget_error_txt} — ${e.message}</p>`;
  }
}

async function addBudgetItem() {
  const phase   = document.getElementById('ba-phase')?.value;
  const cat     = document.getElementById('ba-category')?.value;
  const desc    = document.getElementById('ba-desc')?.value.trim();
  const amount  = parseFloat(document.getElementById('ba-amount')?.value) || 0;
  const est     = document.getElementById('ba-est')?.checked ? 1 : 0;
  const errEl   = document.getElementById('budget-add-err');
  if (!desc) { if (errEl) errEl.textContent = (T[currentLang]||T['he']).budget_desc_req; return; }
  const token = localStorage.getItem('trip-token');
  try {
    const res = await fetch('/api/budget', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase, category: cat, description: desc, amount, is_estimate: est }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    document.getElementById('ba-desc').value = '';
    document.getElementById('ba-amount').value = '';
    document.getElementById('ba-est').checked = false;
    if (errEl) errEl.textContent = '';
    loadBudget();
  } catch (e) {
    if (errEl) errEl.textContent = (T[currentLang]||T['he']).ph_delete_err + ': ' + e.message;
  }
}

async function deleteBudgetItem(id) {
  const token = localStorage.getItem('trip-token');
  await fetch(`/api/budget/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  loadBudget();
}

function startEditBudget(id, currentAmount) {
  const amtCell = document.getElementById(`bamt-${id}`);
  if (!amtCell) return;
  amtCell.innerHTML = `
    <input class="budget-edit-input" id="bedit-${id}" type="number" min="0" step="1" value="${currentAmount}" />
    <button class="budget-save-btn" onclick="saveBudgetEdit(${id})">✓</button>
    <button class="budget-cancel-btn" onclick="loadBudget()">✕</button>`;
  document.getElementById(`bedit-${id}`)?.focus();
}

async function saveBudgetEdit(id) {
  const input = document.getElementById(`bedit-${id}`);
  if (!input) return;
  const amount = parseFloat(input.value);
  if (isNaN(amount)) return;
  const token = localStorage.getItem('trip-token');
  await fetch(`/api/budget/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  loadBudget();
}

window.addBudgetItem    = addBudgetItem;
window.deleteBudgetItem = deleteBudgetItem;
window.startEditBudget  = startEditBudget;
window.saveBudgetEdit   = saveBudgetEdit;

/* =========================================================
   BOOKINGS
   ========================================================= */
const TYPE_ICONS = { flight: '✈️', hotel: '🏨', car: '🚗', attraction: '⚡', other: '📌' };
// Booking types that "can't be moved" once they exist — the anchor events
// the Home Full Overview is built from. attraction bookings are filtered
// further at call sites: a loose idea with no date isn't an anchor yet.
const ANCHOR_TYPES = ['flight', 'hotel', 'attraction'];

// Fallback for anywhere a Maps link is expected but no explicit mapsUrl was
// authored — builds a search link from whatever free-text address exists,
// so a still-TBD hotel is at least clickable to its area.
function googleMapsUrl(query) {
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
// Empty by default — unlisted phase ids just fall back to showing the raw id
// (see usage below), which is fine; no hardcoded per-trip phase list needed.
const PHASE_LABELS = {};

function bkConfUrls(confFile) {
  if (!confFile) return null;
  if (confFile.startsWith('booking-')) {
    const url = `/api/bookings/confirmation/${confFile}`;
    return { view: url, download: url };
  }
  return { view: `/confirmations/view/${confFile}`, download: `/confirmations/${confFile}` };
}

// Local to this section rather than reusing esc()/safeUrl() from the
// RENDER_FUNS region below: those are already relied on by ~30 call sites in
// the itinerary-plan-item renderers, and moving them out would drag that
// unrelated, separately-tested code along for the ride. Same escaping rules,
// scoped to booking-derived markup specifically.
function bkEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Only ever emit an http(s) href — a stored `javascript:` URL in a booking's
// location/wallet field would otherwise execute for every viewer.
function bkSafeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Shared by the Bookings tab (buildBookingRow) and the Home "Full Overview"
// anchor list — the clickable-reference badges (confirmation, PDF, wallet,
// location→Maps) are the same "review it" affordance in both places, so
// there's exactly one place that builds that markup. Every field here can be
// set by any authenticated participant via the booking form, so it's all
// escaped/sanitized before it reaches innerHTML.
function bookingRefBadges(b) {
  const urls = bkConfUrls(b.conf_file);
  const pdfLink = urls
    ? `<span class="conf-pdf-pair"><a class="conf-pdf" href="${urls.view}" target="_blank" title="View">👁</a><a class="conf-pdf" href="${urls.download}" download title="Download">⬇</a></span>`
    : '';
  const confBadge = b.confirmation ? `<span class="conf">${bkEsc(b.confirmation)}</span>` : '';
  const appleWalletBadge = b.pkpass_file
    ? `<a href="/api/bookings/wallet-apple/${encodeURIComponent(b.pkpass_file)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none;margin-right:4px;vertical-align:middle"><img src="/apple-wallet-badge.svg" alt="Add to Apple Wallet" style="height:52px;display:block"></a>`
    : '';
  // bkSafeUrl() only validates the scheme — the rest of an attacker-chosen
  // URL (e.g. a literal " character) still needs HTML-escaping before it's
  // safe to sit inside a quoted href attribute, same as esc(safeUrl(x)) is
  // already used for URLs elsewhere in this file (itinerary plan items).
  const googleWalletUrl = bkEsc(bkSafeUrl(b.google_wallet_url));
  const googleWalletBadge = googleWalletUrl
    ? `<a href="${googleWalletUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none;margin-right:4px;vertical-align:middle"><img src="/google-wallet-badge.svg" alt="Add to Google Wallet" style="height:52px;display:block"></a>`
    : '';
  const locationUrl = bkEsc(bkSafeUrl(b.location_url));
  const locationBadge = locationUrl
    ? `<a href="${locationUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:2px;color:var(--accent);font-size:12px;text-decoration:none;vertical-align:middle;margin-right:4px" title="Location">📍</a>`
    : '';
  return `${confBadge}${pdfLink}${appleWalletBadge}${googleWalletBadge}${locationBadge}`;
}

function buildBookingRow(b, canEdit) {
  const icon = TYPE_ICONS[b.type] || '📌';
  const cancelled = b.name.startsWith('❌');
  // date_from/date_to are accepted by POST/PATCH /api/bookings with no
  // format validation, so they're just as attacker-controlled as name.
  const dates = bkEsc([b.date_from, b.date_to].filter(Boolean).join(' → '));
  const pinBadge = b.pin ? `<span style="margin-right:6px;font-size:12px;color:var(--ink-2)">PIN: ${b.pin}</span>` : '';
  const costStr = b.cost ? `$${Number(b.cost).toLocaleString()}` : '–';
  const editBtn = canEdit
    ? `<button onclick="editBooking(${b.id})" style="border:none;background:none;cursor:pointer;font-size:13px;color:var(--accent);padding:0 4px" title="Edit">✏️</button>`
    : '';
  const delBtn = (canEdit && !b.seed_key)
    ? `<button onclick="deleteBooking(${b.id})" style="border:none;background:none;cursor:pointer;font-size:13px;color:var(--warn);padding:0 4px" title="Delete">🗑️</button>`
    : '';
  return `<tr style="${cancelled ? 'opacity:0.55;text-decoration:line-through' : ''}">
    <td>${icon} ${bkEsc(b.name)}</td>
    <td style="white-space:nowrap">${dates || '–'}</td>
    <td>${b.passengers || '–'}</td>
    <td>${bookingRefBadges(b)}${pinBadge}</td>
    <td style="white-space:nowrap">${costStr}</td>
    <td style="white-space:nowrap">${editBtn}${delBtn}</td>
  </tr>`;
}

async function loadBookings() {
  const el = document.getElementById('bookings-content');
  if (!el) return;
  const tr = T[currentLang] || T['he'];
  const token = localStorage.getItem('trip-token');
  const canEdit = !!token;
  const addBtn = document.getElementById('bk-add-main');
  if (addBtn) addBtn.style.display = canEdit ? '' : 'none';
  try {
    const res = await fetch('/api/bookings', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    if (!rows.length) { el.innerHTML = `<p style="color:var(--ink-2);padding:24px 0;text-align:center">${tr.bk_no_bookings}</p>`; return; }
    const byPhase = {};
    for (const b of rows) { (byPhase[b.phase] = byPhase[b.phase] || []).push(b); }
    // Config-driven, not the original trip's hardcoded ids — a booking whose
    // phase isn't in trip.config.json at all (renamed/removed phase, typo)
    // still gets a section instead of silently vanishing from the list.
    const knownPhases = ['intl_flights', ...(window.TRIP_CONFIG?.phases || []).map(p => p.id)];
    const leftoverPhases = Object.keys(byPhase).filter(p => !knownPhases.includes(p));
    const phaseOrder = [...knownPhases, ...leftoverPhases];
    let html = '';
    for (const phase of phaseOrder) {
      if (!byPhase[phase]) continue;
      const label = (PHASE_LABELS[phase] || {})[currentLang] || phase;
      html += `<h3 class="section-h3">${label}</h3>`;
      html += `<div class="tbl-wrap"><table>
        <tr><th>${tr.th_name || 'הזמנה'}</th><th>${tr.th_dates || 'תאריכים'}</th><th>${tr.th_passengers}</th><th>${tr.th_conf}</th><th>${tr.th_cost}</th><th></th></tr>
        ${byPhase[phase].map(b => buildBookingRow(b, canEdit)).join('')}
      </table></div>`;
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--warn);padding:16px 0">${tr.bk_err_server}</p>`;
  }
}

async function loadPhaseBookings(phase) {
  const el = document.getElementById(`phase-bookings-${phase}`);
  if (!el) return;
  const tr = T[currentLang] || T['he'];
  const token = localStorage.getItem('trip-token');
  const canEdit = !!token;
  const addBtn = document.getElementById(`bk-add-${phase}`);
  if (addBtn) addBtn.style.display = canEdit ? '' : 'none';
  try {
    const res = await fetch(`/api/bookings?phase=${phase}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    if (!rows.length) { el.innerHTML = ''; return; }
    let html = `<div class="tbl-wrap"><table>
      <tr><th>${tr.th_name || 'הזמנה'}</th><th>${tr.th_dates || 'תאריכים'}</th><th>${tr.th_passengers}</th><th>${tr.th_conf}</th><th>${tr.th_cost}</th><th></th></tr>
      ${rows.map(b => buildBookingRow(b, canEdit)).join('')}
    </table></div>`;
    el.innerHTML = html;
  } catch {
    el.innerHTML = '';
  }
}

async function extractBookingWithAI() {
  const tr = T[currentLang] || T['he'];
  const statusEl = document.getElementById('bk-extract-status');
  const btn = document.getElementById('bk-extract-btn');
  const urlVal = document.getElementById('bk-extract-url').value.trim();
  const fileEl = document.getElementById('bk-extract-file');
  const file = fileEl.files[0];

  if (!urlVal && !file) { statusEl.textContent = tr.bk_extract_error; return; }

  const token = localStorage.getItem('trip-token');
  btn.disabled = true;
  statusEl.style.color = '';
  statusEl.innerHTML = `<span class="inline-spinner"></span>${tr.bk_extract_loading}`;

  try {
    let body, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (file) {
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      body = JSON.stringify({ pdf_base64: base64, pdf_name: file.name });
    } else {
      body = JSON.stringify({ url: urlVal });
    }

    const r = await fetch('/api/bookings/extract', { method: 'POST', headers, body });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
    const data = await r.json();

    // Populate form fields with extracted data
    if (data.phase)        document.getElementById('bk-phase').value       = data.phase;
    if (data.type)         document.getElementById('bk-type').value        = data.type;
    if (data.name)         document.getElementById('bk-name').value        = data.name;
    if (data.date_from)    document.getElementById('bk-date-from').value   = data.date_from;
    if (data.date_to)      document.getElementById('bk-date-to').value     = data.date_to;
    if (data.passengers)   document.getElementById('bk-passengers').value  = data.passengers;
    if (data.confirmation) document.getElementById('bk-conf').value        = data.confirmation;
    if (data.pin)          document.getElementById('bk-pin').value         = data.pin;
    if (data.cost)         document.getElementById('bk-cost').value        = data.cost;
    if (data.notes)        document.getElementById('bk-notes').value       = data.notes;
    if (data.location_url) document.getElementById('bk-location-url').value = data.location_url;

    if (file) {
      // Same PDF already uploaded for extraction — carry it over as the
      // confirmation attachment too, instead of making them attach it
      // again below by hand.
      const dt = new DataTransfer();
      dt.items.add(file);
      document.getElementById('bk-file').files = dt.files;
    }

    statusEl.style.color = 'var(--ok, #16a34a)';
    statusEl.textContent = tr.bk_extract_success;
    document.getElementById('bk-extract-url').value = '';
    fileEl.value = '';
  } catch (e) {
    statusEl.style.color = 'var(--warn)';
    statusEl.textContent = `${tr.bk_extract_error}: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function showBookingForm(phase, bookingData) {
  document.getElementById('bk-id').value       = bookingData?.id ?? '';
  document.getElementById('bk-phase').value    = phase || bookingData?.phase || 'intl_flights';
  document.getElementById('bk-type').value     = bookingData?.type || 'flight';
  document.getElementById('bk-name').value     = bookingData?.name || '';
  document.getElementById('bk-date-from').value = bookingData?.date_from || '';
  document.getElementById('bk-date-to').value   = bookingData?.date_to || '';
  document.getElementById('bk-passengers').value = bookingData?.passengers || '';
  document.getElementById('bk-conf').value     = bookingData?.confirmation || '';
  document.getElementById('bk-pin').value      = bookingData?.pin || '';
  document.getElementById('bk-cost').value     = bookingData?.cost ?? '';
  document.getElementById('bk-notes').value    = bookingData?.notes || '';
  document.getElementById('bk-pkpass-file').value   = '';
  document.getElementById('bk-google-wallet').value = bookingData?.google_wallet_url || '';
  document.getElementById('bk-location-url').value  = bookingData?.location_url || '';
  document.getElementById('bk-file').value     = '';
  document.getElementById('bk-err').textContent = '';
  // Leftover from a previous extraction (text + color) otherwise stays on
  // screen — a stale "✓ Details extracted" can sit there for an entirely
  // new, unrelated booking.
  document.getElementById('bk-extract-url').value = '';
  document.getElementById('bk-extract-file').value = '';
  const extractStatusEl = document.getElementById('bk-extract-status');
  extractStatusEl.textContent = '';
  extractStatusEl.style.color = '';
  const tr = T[currentLang] || T['he'];
  document.getElementById('bk-form-title').textContent = bookingData ? tr.bk_form_edit : tr.bk_form_title;
  document.getElementById('bk-overlay').style.display = 'flex';
}

function hideBookingForm() {
  document.getElementById('bk-overlay').style.display = 'none';
}

async function submitBooking() {
  const tr = T[currentLang] || T['he'];
  const id       = document.getElementById('bk-id').value;
  const phase    = document.getElementById('bk-phase').value;
  const type     = document.getElementById('bk-type').value;
  const name     = document.getElementById('bk-name').value.trim();
  const errEl    = document.getElementById('bk-err');
  if (!name || !type) { errEl.textContent = tr.bk_err_req; return; }
  const token = localStorage.getItem('trip-token');
  const body = {
    phase, type, name,
    date_from:     document.getElementById('bk-date-from').value || null,
    date_to:       document.getElementById('bk-date-to').value   || null,
    passengers:    document.getElementById('bk-passengers').value.trim() || null,
    confirmation:  document.getElementById('bk-conf').value.trim()       || null,
    pin:           document.getElementById('bk-pin').value.trim()        || null,
    cost:             parseFloat(document.getElementById('bk-cost').value)         || 0,
    notes:            document.getElementById('bk-notes').value.trim()             || null,
    google_wallet_url: document.getElementById('bk-google-wallet').value.trim()   || null,
    location_url:     document.getElementById('bk-location-url').value.trim()     || null,
  };
  try {
    let newId = id;
    if (id) {
      const r = await fetch(`/api/bookings/${id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
    } else {
      const r = await fetch('/api/bookings', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
      const data = await r.json();
      newId = data.id;
    }
    const file = document.getElementById('bk-file').files[0];
    if (file && newId) {
      const fd = new FormData();
      fd.append('file', file);
      await fetch(`/api/bookings/${newId}/confirmation`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    }
    const pkpass = document.getElementById('bk-pkpass-file').files[0];
    if (pkpass && newId) {
      const fd = new FormData();
      fd.append('file', pkpass);
      await fetch(`/api/bookings/${newId}/wallet-apple`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    }
    hideBookingForm();
    loadBookings();
    if (body.phase) loadPhaseBookings(body.phase);
    loadHomeOverview(window.TRIP_CONFIG);
  } catch {
    errEl.textContent = tr.bk_err_server;
  }
}

async function deleteBooking(id) {
  const tr = T[currentLang] || T['he'];
  if (!confirm(tr.bk_confirm_del)) return;
  const token = localStorage.getItem('trip-token');
  await fetch(`/api/bookings/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  loadBookings();
  loadHomeOverview(window.TRIP_CONFIG);
}

async function editBooking(id) {
  const token = localStorage.getItem('trip-token');
  const res = await fetch('/api/bookings', { headers: { Authorization: `Bearer ${token}` } });
  const rows = await res.json();
  const b = rows.find(r => r.id === id);
  if (b) showBookingForm(b.phase, b);
}

window.showBookingForm = showBookingForm;
window.hideBookingForm = hideBookingForm;
window.submitBooking   = submitBooking;
window.deleteBooking   = deleteBooking;
window.editBooking     = editBooking;

/* =========================================================
   SIDE MENU (burger)
   ========================================================= */
(function () {
  const burgerBtn = document.getElementById('burger-btn');
  const sideMenu = document.getElementById('side-menu');
  const overlay = document.getElementById('side-overlay');
  const closeBtn = document.getElementById('sm-close');

  function open() {
    sideMenu.classList.add('open');
    overlay.classList.add('open');
    burgerBtn.classList.add('open');
  }
  function close() {
    sideMenu.classList.remove('open');
    overlay.classList.remove('open');
    burgerBtn.classList.remove('open');
  }

  burgerBtn?.addEventListener('click', () => sideMenu.classList.contains('open') ? close() : open());
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);

  document.querySelectorAll('.sm-link').forEach(a => {
    a.addEventListener('click', () => { switchTab(a.dataset.tab); close(); });
  });
})();

/* =========================================================
   TWEAKS PANEL
   ========================================================= */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "blue",
  "font": "heebo",
  "nyPhoto": 0
}/*EDITMODE-END*/;

const tweakState = { ...TWEAK_DEFAULTS };
const shell = document.querySelector('.shell');

function applyTweaks() {
  if (!shell) return;
  shell.dataset.palette = tweakState.palette;
  shell.dataset.font = tweakState.font;
  // Leftover from the original single-trip (New York) version. HERO is built
  // from trip.config.json phases, so HERO.ny exists only if a trip happens to
  // have a phase literally called "ny" — no generated trip does. Unguarded,
  // this threw on every real trip and took the REST OF BOOT with it: the
  // lang-toggle listener and initDragDrop() are registered on the lines
  // immediately after applyTweaks(), so the EN/HE button silently did nothing.
  // The test fixture's phases are named ny/colorado, which is exactly why the
  // suite never caught it.
  if (HERO.ny) HERO.ny.photo = NY_PHOTOS[tweakState.nyPhoto % NY_PHOTOS.length];
  // re-apply current hero if NY active
  const active = document.querySelector('.section.active');
  if (active && active.id === 'ny') setHero('ny');

  document.querySelectorAll('[data-tweak-key]').forEach(el => {
    const key = el.dataset.tweakKey;
    const val = el.dataset.tweakValue;
    el.classList.toggle('active', String(tweakState[key]) === String(val));
  });
}
function setTweak(key, value) {
  tweakState[key] = value;
  applyTweaks();
  try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [key]: value } }, '*'); } catch (e) {}
}
document.querySelectorAll('[data-tweak-key]').forEach(el => {
  el.addEventListener('click', () => {
    let v = el.dataset.tweakValue;
    if (!isNaN(Number(v))) v = Number(v);
    setTweak(el.dataset.tweakKey, v);
  });
});
const panel = document.querySelector('.tweaks');
window.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === '__activate_edit_mode') panel.classList.add('open');
  if (d.type === '__deactivate_edit_mode') panel.classList.remove('open');
});
window.parent.postMessage({ type: '__edit_mode_available' }, '*');
document.querySelector('.t-close')?.addEventListener('click', () => {
  panel.classList.remove('open');
  window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*');
});

/* =========================================================
   TRIP CONFIG LOADING
   ========================================================= */
async function loadTripConfig() {
  try {
    const token = localStorage.getItem('trip-token');
    const res = await fetch('/api/config', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) window.TRIP_CONFIG = await res.json();
  } catch (e) {
    console.warn('Could not load trip config, using hardcoded defaults:', e);
  }
}

async function loadPhasePlans() {
  const phases = window.TRIP_CONFIG?.phases || [];
  const token = localStorage.getItem('trip-token');
  if (!token) return;
  await Promise.all(phases.map(async p => {
    try {
      const h = { Authorization: `Bearer ${token}` };
      const [items, days] = await Promise.all([
        fetch(`/api/phases/${p.id}/plan`, { headers: h }),
        fetch(`/api/phases/${p.id}/plan/days`, { headers: h }),
      ]);
      if (items.ok) PHASE_PLAN[p.id] = await items.json();
      if (days.ok) {
        PHASE_PLAN_DAYS[p.id] = Object.fromEntries((await days.json()).map(d => [d.date, d]));
      }
    } catch {}
  }));
}

// Pre-auth "pick yourself" data for the login screen. /api/config now
// requires a session (it carries real trip content), so the picker uses the
// deliberately minimal, unauthenticated /api/config/roster instead.
async function loadLoginRoster() {
  try {
    const res = await fetch('/api/config/roster');
    if (res.ok) window.LOGIN_ROSTER = (await res.json()).participants || [];
  } catch (e) {
    console.warn('Could not load login roster:', e);
  }
}

function populatePhaseSectionDropdowns(cfg, lang) {
  if (!cfg?.budget?.phase_labels) return;
  const phaseLabels = cfg.budget.phase_labels;
  const phaseOrder  = cfg.budget.phases || Object.keys(phaseLabels);
  const useLang = lang || currentLang || 'he';
  ['ba-phase', 'bk-phase'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = phaseOrder.map(phase => {
      const lbl = phaseLabels[phase];
      return `<option value="${phase}">${lbl?.[useLang] || lbl?.he || phase}</option>`;
    }).join('');
  });
}

function buildPhaseNav(cfg) {
  const phases = cfg.phases || [];

  // 1. Rebuild top nav — remove hardcoded phase tabs, insert from config
  const topnav = document.querySelector('.topnav');
  if (topnav) {
    const frameworkTabIds = new Set(['home', 'mapview', 'bookings', 'budget', 'photos', 'info', 'lostfound']);
    const mapTab = topnav.querySelector('[data-tab="mapview"]');
    topnav.querySelectorAll('a[data-tab]').forEach(a => {
      if (!frameworkTabIds.has(a.dataset.tab)) a.remove();
    });
    phases.slice().reverse().forEach(p => {
      const a = document.createElement('a');
      a.dataset.tab = p.id;
      a.textContent = p.tabLabel || p.id.toUpperCase();
      a.addEventListener('click', e => { e.preventDefault(); switchTab(p.id); });
      if (mapTab?.nextSibling) topnav.insertBefore(a, mapTab.nextSibling);
      else topnav.appendChild(a);
    });
  }

  // 2. Side menu phase links
  const smPhaseLinks = document.getElementById('sm-phase-links');
  if (smPhaseLinks) {
    smPhaseLinks.innerHTML = phases.map(p => {
      const emoji = p.emoji || '📍';
      return `<a class="sm-link" data-tab="${p.id}">` +
        `<span class="lang-he">${emoji} ${p.title?.he || p.tabLabel}</span>` +
        `<span class="lang-en">${emoji} ${p.title?.en || p.tabLabel}</span></a>`;
    }).join('');
    smPhaseLinks.querySelectorAll('a[data-tab]').forEach(a => {
      a.addEventListener('click', () => switchTab(a.dataset.tab));
    });
  }

  // 3. Create section elements for phase IDs not already in HTML
  const beforeSection = document.getElementById('bookings');
  phases.forEach(p => {
    if (document.getElementById(p.id)) return;
    const sec = document.createElement('section');
    sec.className = 'section';
    sec.id = p.id;
    sec.innerHTML = `<div class="sec-body"><div class="sec-inner">` +
      `<h2 class="section-h2"><span class="lang-he">${p.title?.he || p.tabLabel}</span>` +
      `<span class="lang-en">${p.title?.en || p.tabLabel}</span></h2>` +
      (p.note ? `<p class="phase-note">${esc(p.note)}</p>` : '') +
      `<div id="hotel-${p.id}"></div>` +
      `<div id="sched-${p.id}"></div>` +
      `<div id="rsvp-${p.id}"></div>` +
      `<div id="pack-${p.id}"></div>` +
      `<div id="ratings-${p.id}"></div>` +
      `<div id="photos-${p.id}"></div>` +
      `</div></div>`;
    if (beforeSection) beforeSection.parentNode.insertBefore(sec, beforeSection);
  });
}

function buildGlobalsFromConfig(cfg) {
  if (!cfg) return;

  // HERO — override per-phase entries from config
  (cfg.phases || []).forEach(p => {
    if (!p.hero) return;
    HERO[p.id] = {
      photo: p.hero.photo,
      title: p.hero.title,
      label: p.hero.label?.he || p.hero.label,
      sub:   p.hero.sub?.he   || p.hero.sub,
      blurb: p.hero.blurb?.he || p.hero.blurb,
      meta:  p.hero.meta,
      cta:   p.hero.cta?.he   || p.hero.cta,
      // Every phase page shows the same live trip clock as home — no per-phase
      // opt-in; there's no case for a phase page without it.
      countdown: true,
      _i18n: p.hero, // store bilingual source for setHero
    };
  });

  // MAP_STOPS from config — prefer top-level map.stops, fall back to per-phase mapStop
  if (cfg.map?.stops?.length) {
    MAP_STOPS.length = 0;
    cfg.map.stops.forEach(s => MAP_STOPS.push({
      lat: s.lat, lng: s.lng, emoji: s.emoji,
      name_he: s.name?.he || s.name, name_en: s.name?.en || s.name,
      dates: s.dates, hotel: s.hotel, conf: s.conf, color: '#0a0f1c',
    }));
  } else {
    const derived = [];
    (cfg.phases || []).forEach(p => {
      const ms = p.mapStop;
      if (!ms || ms.lat == null) return;
      const accName = p.accommodation?.name;
      derived.push({
        lat: ms.lat, lng: ms.lng,
        emoji: ms.emoji || p.emoji || '📍',
        name_he: ms.name?.he || p.title?.he || p.id,
        name_en: ms.name?.en || p.title?.en || p.id,
        dates: ms.dates || p.dates?.display || '',
        hotel: ms.hotel || (typeof accName === 'string' ? accName : accName?.he || accName?.en || ''),
        conf: ms.conf || p.accommodation?.confirmation || '–',
        color: '#0a0f1c',
      });
    });
    if (derived.length) { MAP_STOPS.length = 0; derived.forEach(s => MAP_STOPS.push(s)); }
  }

  // WX_LOCS — derive from each phase's mapStop + weatherKey
  (cfg.phases || []).forEach(p => {
    const key = p.accommodation?.weatherKey || p.mapStop?.weatherKey;
    const stop = p.mapStop || p.mapStops?.[0];
    if (key && stop) WX_LOCS[key] = { name: p.title?.he || p.title, lat: stop.lat, lng: stop.lng };
    // Also handle multi-stop phases (hotels array with lat/lng)
    (p.hotels || []).forEach(h => {
      if (h.weatherKey && h.lat != null && h.lng != null) {
        WX_LOCS[h.weatherKey] = { name: h.location?.he || h.name, lat: h.lat, lng: h.lng };
      }
    });
  });

  // VENUES — rebuild from phases
  (cfg.phases || []).forEach(p => {
    if (p.venues?.length) VENUES[p.id] = p.venues;
  });

  // RSVP_ACTIVITIES — rebuild from phases
  (cfg.phases || []).forEach(p => {
    if (p.rsvp_activities?.length) RSVP_ACTIVITIES[p.id] = p.rsvp_activities;
  });

  // PACKING — general + per-phase
  if (cfg.packing_general?.length) PACKING.general = cfg.packing_general;
  (cfg.phases || []).forEach(p => {
    if (p.packing?.length) {
      PACKING[p.id] = p.packing;
      if (p.short_id) PACKING[p.short_id] = p.packing; // legacy alias (e.g. "wc" for "westcoast")
    }
  });

  // Legacy short-ID aliases for HTML element IDs that predate the config
  const ID_ALIAS = { colorado: 'co', westcoast: 'wc' };
  (cfg.phases || []).forEach(p => {
    const alias = p.short_id || ID_ALIAS[p.id];
    if (!alias) return;
    if (VENUES[p.id])          VENUES[alias]          = VENUES[p.id];
    if (RSVP_ACTIVITIES[p.id]) RSVP_ACTIVITIES[alias] = RSVP_ACTIVITIES[p.id];
    if (PACKING[p.id])         PACKING[alias]         = PACKING[p.id];
  });

  // Budget phase labels from config — replaces hardcoded BUDGET_PHASES/BUDGET_PHASE_ORDER
  if (cfg.budget?.phase_labels) {
    const phaseLabels = cfg.budget.phase_labels;
    Object.keys(BUDGET_PHASES).forEach(k => delete BUDGET_PHASES[k]);
    Object.entries(phaseLabels).forEach(([k, v]) => {
      BUDGET_PHASES[k] = { label: v.he || v, en: v.en || v.he || v };
    });
    if (cfg.budget.phases?.length) {
      BUDGET_PHASE_ORDER.length = 0;
      cfg.budget.phases.forEach(p => BUDGET_PHASE_ORDER.push(p));
    }
    populatePhaseSectionDropdowns(cfg);
  }

  // Budget h2 and note from config
  const budgetH2 = document.getElementById('budget-h2');
  if (budgetH2 && (cfg.meta?.title || cfg.budget?.scope_note)) {
    const title = cfg.meta?.title || '';
    const sn = cfg.budget?.scope_note || {};
    budgetH2.innerHTML = `<span class="lang-he">${title}${sn.he ? ' · ' + sn.he : ''}</span>` +
      `<span class="lang-en">${title}${sn.en ? ' · ' + sn.en : ''}</span>`;
  }
  const budgetNote = document.getElementById('budget-note');
  if (budgetNote && cfg.budget?.scope_note) {
    const sn = cfg.budget.scope_note;
    budgetNote.innerHTML = `<span class="lang-he">💡 ${sn.he || ''}</span>` +
      `<span class="lang-en">💡 ${sn.en || ''}</span>`;
  }

  // Build phase navigation (nav tabs, side menu, dynamic sections)
  buildPhaseNav(cfg);

  // Apply brand identity and update home hero from config meta
  applyBrandFromConfig(cfg);
}

/* =========================================================
   CONFIG-DRIVEN RENDER FUNCTIONS
   ========================================================= */
/* RENDER_FUNS_BEGIN */

// Escaping helpers live inside the render region because that is the only
// place that uses them (32 call sites, all below) — and because the region is
// what tests/helpers/dom.js extracts, so leaving them outside made the render
// code untestable in isolation.
//
// escapeHtml() elsewhere only ever fed element text, so it leaves quotes alone
// and assumes a string. Plan items come from the DB and the AI extraction path,
// where a value can land in an attribute and can be a number or object — so
// this one escapes quotes too and coerces first.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only ever emit an http(s) href. A stored `javascript:` location_url would
// otherwise execute for every family member who opens the phase tab.
function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function applyBrandFromConfig(cfg) {
  if (!cfg?.meta) return;
  const title = cfg.meta.title || 'Family Trip';
  const brand = cfg.meta.brand || title.split('—')[0].trim();

  document.title = title;
  const appleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleMeta) appleMeta.content = brand;

  const brandEl = document.getElementById('topbar-brand');
  if (brandEl) brandEl.innerHTML = `${brand} <span class="reg">®</span>`;

  const loginTitleEl = document.querySelector('[data-i18n="login_title"]');
  if (loginTitleEl) loginTitleEl.textContent = brand;

  // Logo: load from /api/trip/logo; fall back to the Kinerary mark when the trip has none
  const KINERARY_LOGO = '/brand/kinerary-icon.svg';
  const logoIds = ['topbar-logo', 'login-logo', 'sm-logo'];
  const setLogoSrc = (src) => {
    logoIds.forEach(id => { const el = document.getElementById(id); if (el) { el.src = src; el.style.display = ''; } });
    const gif = document.getElementById('topbar-logo-gif');
    if (gif) gif.style.display = 'none';
  };
  if (cfg.meta.logo) {
    fetch('/api/trip/logo', { method: 'HEAD' })
      .then(r => setLogoSrc(r.ok ? '/api/trip/logo' : KINERARY_LOGO))
      .catch(() => setLogoSrc(KINERARY_LOGO));
  } else {
    setLogoSrc(KINERARY_LOGO);
  }

  // Update home hero from meta
  const nPeople = cfg.participants?.length || 0;
  const totalDays = cfg.meta.totalDays || '';
  const depDate = cfg.meta.departure ? new Date(cfg.meta.departure) : null;
  const retDate = cfg.meta.returnDate ? new Date(cfg.meta.returnDate) : null;
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const metaStr = (depDate && retDate)
    ? `${months[depDate.getMonth()]} ${String(depDate.getDate()).padStart(2,'0')} — ${months[retDate.getMonth()]} ${String(retDate.getDate()).padStart(2,'0')} / ${depDate.getFullYear()}`
    : '';
  const phaseNamesHe = (cfg.phases || []).map(p => p.title?.he || p.tabLabel).join(' · ');
  const phaseNamesEn = (cfg.phases || []).map(p => p.title?.en || p.tabLabel).join(' · ');
  // Trip-wide hero photos (home tab + map tab) — distinct from per-phase hero
  // photos below. Pick something that represents the *trip as a whole*
  // (a mode of travel shared across stops, an overview/aerial shot), not
  // just a reused photo of whichever single destination.
  if (cfg.meta.homePhoto) HERO.home.photo = cfg.meta.homePhoto;
  if (cfg.meta.mapPhoto) HERO.mapview.photo = cfg.meta.mapPhoto;

  HERO.home = {
    ...HERO.home,
    title: brand,
    meta: metaStr,
    _i18n: {
      label: { he: `— ${title}`, en: `— ${title}` },
      sub: {
        he: nPeople ? `${nPeople} נפשות${totalDays ? ' · ' + totalDays + ' ימים' : ''}` : '',
        en: nPeople ? `${nPeople} people${totalDays ? ' · ' + totalDays + ' days' : ''}` : '',
      },
      blurb: { he: phaseNamesHe, en: phaseNamesEn },
      cta: { he: 'בחר שלב', en: 'Select phase' },
    },
  };

  // Trivia section visibility
  const triviaSection = document.getElementById('sm-trivia-section');
  if (triviaSection) triviaSection.style.display = cfg.trivia_available ? '' : 'none';
  const triviaLink = document.getElementById('sm-trivia-link');
  if (triviaLink && cfg.trivia_available) triviaLink.innerHTML = `🏆 ${brand} Quiz`;

  const footerEl = document.getElementById('site-footer');
  if (footerEl) {
    const sep = '<span class="sep">●</span>';
    footerEl.innerHTML = [
      brand,
      cfg.phases?.length ? `${cfg.phases.length} ${cfg.phases.length === 1 ? 'destination' : 'destinations'}` : '',
      nPeople ? `${nPeople} ${nPeople === 1 ? 'traveler' : 'travelers'}` : '',
    ].filter(Boolean).join(` ${sep} `);
  }
}

function renderHomePhases(cfg) {
  const el = document.getElementById('home-phases');
  if (!el || !cfg?.phases?.length) return;
  el.innerHTML = cfg.phases.map(p => {
    const display = p.dates?.display ||
      (p.dates?.start && p.dates?.end
        ? `${p.dates.start.slice(5).replace('-','/')} — ${p.dates.end.slice(5).replace('-','/')}`
        : '');
    const count = p.participants?.length;
    return `<div class="phase" data-tab="${p.id}" role="button" tabindex="0">
      <div class="ph-date">${display}</div>
      <div class="ph-place">${p.emoji || ''} ${_biSpan(p.title || { he: p.tabLabel, en: p.tabLabel })}</div>
      ${count ? `<div class="ph-people"><span class="lang-he">${count} נפשות</span><span class="lang-en">${count} people</span></div>` : ''}
    </div>`;
  }).join('');
}

// Delegated so it survives renderHomePhases() re-rendering the cards on
// language switch, rather than needing to re-wire listeners every time.
document.getElementById('home-phases')?.addEventListener('click', e => {
  const card = e.target.closest('[data-tab]');
  if (card) switchTab(card.dataset.tab);
});
document.getElementById('home-phases')?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('[data-tab]');
  if (card) { e.preventDefault(); switchTab(card.dataset.tab); }
});

// One hotel anchor per phase, from the same accommodation field
// renderPhaseHotelCard() already reads — not a second hand-authored source.
function accommodationAnchors(cfg) {
  return (cfg.phases || []).map(p => {
    const acc = p.accommodation;
    if (!acc) return null;
    const rawName = acc.name || acc.note;
    const name = typeof rawName === 'string' ? rawName : (rawName?.he || rawName?.en || '');
    if (!name) return null;
    return {
      type: 'hotel',
      phaseId: p.id,
      name,
      phaseLabel: `${p.emoji || ''} ${_biSpan(p.title || { he: p.tabLabel, en: p.tabLabel })}`,
      date_from: p.dates?.start || null,
      date_to: p.dates?.end || null,
      confirmation: acc.confirmation || null,
      conf_file: acc.pdf || null,
      location_url: acc.mapsUrl || acc.maps || (acc.address ? googleMapsUrl(acc.address) : null),
    };
  }).filter(Boolean);
}

// Anchor = an event that can't be moved once it exists. A cancelled booking
// (the Bookings tab's own convention: name starts with ❌) no longer is one —
// exclude it rather than show a dead reservation as if it were locked in.
// flight/hotel are otherwise unconditional (a booking of that type is
// inherently date-bound); an attraction is only an anchor once it has a
// fixed date — a loose idea with no date is still a wishlist entry, not
// something locked in.
// A later pass could send borderline attractions (dated but no
// confirmation/conf_file yet) through an LLM to read notes/PDF text and
// catch what this deterministic check gets wrong; not built here.
function isAnchorBooking(b) {
  if (b.name?.startsWith('❌')) return false;
  if (!ANCHOR_TYPES.includes(b.type)) return false;
  if (b.type === 'attraction') return !!b.date_from;
  return true;
}

function bookingAnchors(cfg, bookings) {
  return bookings.filter(isAnchorBooking).map(b => {
    const phase = (cfg.phases || []).find(p => p.id === b.phase);
    const phaseLabel = phase
      ? `${phase.emoji || ''} ${_biSpan(phase.title || { he: phase.tabLabel, en: phase.tabLabel })}`
      : esc((PHASE_LABELS[b.phase] || {})[currentLang] || b.phase);
    return { ...b, phaseLabel };
  });
}

function renderHomeOverview(cfg, anchors) {
  const el = document.getElementById('home-overview');
  if (!el || !cfg?.phases?.length) return;
  const tr = T[currentLang] || T['he'];
  const sorted = anchors.slice().sort((a, b) => (a.date_from || '').localeCompare(b.date_from || ''));
  const rows = sorted.map(a => {
    // date_from/date_to on a booking-derived anchor are accepted by
    // POST/PATCH /api/bookings with no format validation — just as
    // attacker-controlled as name.
    const dates = esc([a.date_from, a.date_to].filter(Boolean).join(' → ') || '–');
    const icon = TYPE_ICONS[a.type] || '📌';
    return `<tr>
      <td style="white-space:nowrap">${dates}</td>
      <td>${icon} ${esc(a.name)}</td>
      <td>${a.phaseLabel || '–'}</td>
      <td>${bookingRefBadges(a) || '–'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div class="tbl-wrap"><table>
    <tr>
      <th data-i18n="th_dates">${tr.th_dates || 'תאריכים'}</th>
      <th data-i18n="th_anchor">${tr.th_anchor || 'אירוע'}</th>
      <th data-i18n="th_dest">${tr.th_dest || 'יעד'}</th>
      <th data-i18n="th_ref">${tr.th_ref || 'הפניות'}</th>
    </tr>
    ${rows || `<tr><td colspan="4" style="text-align:center;color:var(--ink-2);padding:20px 0">–</td></tr>`}
  </table></div>`;
}

// True only when a hotel booking plausibly IS the phase's accommodation
// placeholder, not just another hotel booking that happens to share a phase
// (e.g. a one-night airport stopover shouldn't hide the main stay). A
// matching confirmation code is authoritative on its own; short of that,
// require the stay dates to overlap AND the names to loosely agree
// (case/whitespace-insensitive substring, so "Hotel Meridian" still matches
// a booking named "Hotel Meridian (confirmed)").
function sameStay(acc, booking) {
  if (acc.confirmation && booking.confirmation) return acc.confirmation === booking.confirmation;
  const accFrom = acc.date_from, accTo = acc.date_to || acc.date_from;
  const bkFrom = booking.date_from, bkTo = booking.date_to || booking.date_from;
  const overlaps = !!(accFrom && bkFrom && bkFrom <= accTo && bkTo >= accFrom);
  if (!overlaps) return false;
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(acc.name), b = norm(booking.name);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function loadHomeOverview(cfg) {
  if (!cfg?.phases?.length) return;
  const token = localStorage.getItem('trip-token');
  let bookings = [];
  try {
    const res = await fetch('/api/bookings', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) bookings = await res.json();
  } catch { /* renders hotel-only anchors below if bookings can't be reached */ }
  const bkAnchors = bookingAnchors(cfg, bookings);
  const bkHotels = bkAnchors.filter(b => b.type === 'hotel');
  // A phase whose hotel is already a real booking shouldn't also show the
  // accommodation placeholder — prefer the booking record (it carries the
  // actual confirmation/PDF/wallet) over trip.config.json's authored
  // stand-in — but only for the SAME stay, not any hotel booking on the phase.
  const accAnchors = accommodationAnchors(cfg)
    .filter(acc => !bkHotels.some(bk => bk.phase === acc.phaseId && sameStay(acc, bk)));
  renderHomeOverview(cfg, [...accAnchors, ...bkAnchors]);
}

function _bi(obj, lang) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[lang] || obj.he || '';
}

function _biSpan(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return `<span class="lang-he">${obj.he || ''}</span><span class="lang-en">${obj.en || ''}</span>`;
}

function renderStats(cfg) {
  const el = document.getElementById('stat-strip');
  if (!el || !cfg?.stats?.length) return;
  el.innerHTML = cfg.stats.map(s => `
    <div>
      <h2 class="ltr">${s.number}</h2>
      <p><span class="lang-he">${s.description?.he || ''}</span><span class="lang-en">${s.description?.en || ''}</span></p>
    </div>`).join('');
}

function renderAlerts(cfg) {
  const el = document.getElementById('home-alerts');
  if (!el || !cfg?.alerts) return;
  const { booked, pending } = cfg.alerts;
  let html = '';
  if (booked) html += `<div class="alert alert-s"><span class="lang-he">${booked.he || ''}</span><span class="lang-en">${booked.en || ''}</span></div>`;
  if (pending) html += `<div class="alert alert-w"><span class="lang-he">${pending.he || ''}</span><span class="lang-en">${pending.en || ''}</span></div>`;
  el.innerHTML = html;
}

function renderFamilies(cfg) {
  const el = document.getElementById('families-section');
  if (!el || !cfg?.families?.length) return;
  const byUsername = {};
  (cfg.participants || []).forEach(p => { byUsername[p.username] = p; });
  el.innerHTML = cfg.families.map(fam => {
    const heads = [], kids = [];
    (fam.members || []).forEach(u => {
      const p = byUsername[u];
      if (!p) return;
      (p.age >= 25 ? heads : kids).push(p);
    });
    const headLines = heads.map(p =>
      `<li><strong><span class="lang-he">${p.name}</span><span class="lang-en">${p.name_en}</span></strong>${p.age ? ` (${p.age})` : ''}</li>`).join('');
    const kidLine = kids.length ? `<li><span class="lang-he">${kids.map(p => `${p.name}${p.age ? ' ('+p.age+')' : ''}`).join(', ')}</span><span class="lang-en">${kids.map(p => `${p.name_en}${p.age ? ' ('+p.age+')' : ''}`).join(', ')}</span></li>` : '';
    const noteHtml = fam.note ? `<div class="fam-note">${_biSpan(fam.note)}</div>` : '';
    return `<div class="fam">
      <div class="fam-letter ltr">${fam.letter}</div>
      <div class="fam-content">
        <h4>${_biSpan(fam.name)}</h4>
        <div class="fam-count">${_biSpan(fam.description)}</div>
        <ul>${headLines}${kidLine}</ul>
        ${noteHtml}
      </div>
    </div>`;
  }).join('');
}

function renderTasks(cfg) {
  const el = document.getElementById('tasks-table-wrap');
  if (!el || !cfg?.tasks?.length) return;
  const rows = cfg.tasks.map(t => `
    <tr data-tid="${t.id}">
      <td>${_biSpan(t.text)}</td>
      <td>${_biSpan(t.owner)}</td>
      <td><span class="task-deadline" data-deadline="${t.deadline || ''}"></span></td>
      <td class="task-done-cell"></td>
    </tr>`).join('');
  el.innerHTML = `<table>
    <tr>
      <th data-i18n="th_task">משימה</th>
      <th data-i18n="th_owner">אחראי</th>
      <th data-i18n="th_deadline">דדליין</th>
      <th style="width:80px"></th>
    </tr>
    ${rows}
  </table>`;
}

function renderPhaseHotelCard(phase) {
  const el = document.getElementById(`hotel-${phase.id}`);
  if (!el || !phase.accommodation) return;
  const acc = phase.accommodation;

  const nameHe = _bi(acc.name, 'he');
  const nameEn = _bi(acc.name, 'en');
  const addr = acc.address || '';
  const conf = acc.confirmation;
  const pin = acc.pin;
  const cost = acc.cost;
  const guests = acc.guests;
  const rooms = acc.rooms;
  const phone = acc.phone;
  const mapsUrl = acc.mapsUrl || acc.maps || (addr ? googleMapsUrl(addr) : null);
  const wazeUrl = acc.waze;
  const weatherKey = acc.weatherKey;
  const pdfFile = acc.pdf;

  let metaHtml = '';
  if (acc.dates) metaHtml += `<span class="tag">📅 ${_biSpan(acc.dates)}</span>`;
  if (guests) metaHtml += `<span class="tag">👥 <span class="lang-he">${guests} אורחים</span><span class="lang-en">${guests} guests</span></span>`;
  if (rooms) metaHtml += `<span class="tag">🛏️ <span class="lang-he">${rooms} חדרים</span><span class="lang-en">${rooms} rooms</span></span>`;
  if (conf && pin) metaHtml += `<span class="tag g">✅ <span class="lang-he">אישור: </span><span class="lang-en">Conf: </span><strong>${conf}</strong> · PIN: <strong>${pin}</strong></span>`;
  else if (conf) metaHtml += `<span class="tag g">✅ <span class="lang-he">אישור: </span><span class="lang-en">Conf: </span><strong>${conf}</strong></span>`;
  if (cost) metaHtml += `<span class="tag">💰 $${cost.toLocaleString()}</span>`;
  (acc.notes || []).forEach(n => {
    const cls = n.style === 'warn' ? 'r' : (n.style === 'alert' ? 'r' : '');
    metaHtml += `<span class="tag${cls ? ' '+cls : ''}">${_biSpan(n.text)}</span>`;
  });

  const pdfHtml = pdfFile ? `<span class="conf-pdf-pair"><a class="conf-pdf" href="/confirmations/view/${pdfFile}" title="View">👁</a><a class="conf-pdf" href="/confirmations/${pdfFile}" download title="Download">⬇</a></span>` : '';
  const navHtml = (mapsUrl || wazeUrl || weatherKey) ? `<div class="loc-nav-row" style="margin-top:10px">${mapsUrl ? `<a class="btn" href="${mapsUrl}" target="_blank">🗺️ Google Maps</a>` : ''}${wazeUrl ? `<a class="btn" href="${wazeUrl}" target="_blank">🔵 Waze</a>` : ''}${weatherKey ? `<button class="btn" type="button" onclick="loadWx('${weatherKey}')">🌤️ תחזית</button>` : ''}</div>${weatherKey ? `<div id="wx-${weatherKey}" class="wx-panel" style="display:none"></div>` : ''}` : '';
  const descHtml = acc.description ? `<p>${_biSpan(acc.description)}</p>` : '';
  const icon = acc.type === 'private' ? '🏠' : '🏨';

  el.innerHTML = `<div class="hotel-card">
    <h4>${icon} <span class="lang-he">${nameHe}</span><span class="lang-en">${nameEn}</span></h4>
    ${addr ? `<p>${addr}${phone ? ` · <a class="inline" href="tel:${phone}">${phone}</a>` : ''}</p>` : ''}
    ${descHtml}
    <div class="hotel-meta">${metaHtml}${pdfHtml}</div>
    ${navHtml}
  </div>`;
}

function renderPhotoUploads(cfg) {
  const el = document.getElementById('photo-uploads');
  if (!el || !cfg?.phases?.length) return;
  const ID_ALIAS = { colorado: 'co', westcoast: 'wc' };
  const tr = T[currentLang] || T['he'];
  el.innerHTML = cfg.phases.map(p => {
    const pid = p.short_id || ID_ALIAS[p.id] || p.id;
    const phaseLabel = p.tabLabel || p.id;
    const dateRange = (p.dates?.start && p.dates?.end)
      ? `${p.dates.start.slice(5).replace('-','/')}–${p.dates.end.slice(5).replace('-','/')}`
      : '';
    return `<div class="mini">
      <h4>${p.emoji || ''} ${_biSpan(p.title || { he: phaseLabel, en: phaseLabel })}${dateRange ? ` (${dateRange})` : ''}</h4>
      <label class="photo-upload-area" data-phase="${pid}">
        <input type="file" multiple accept="image/*" onchange="uploadPhotos('${pid}',this)"/>
        <div class="icon ltr">+</div>
        <p data-i18n="upload_click">${tr.upload_click || 'לחץ לבחירת תמונות'}</p>
      </label>
      <div id="album-link-${pid}" class="album-share-link" data-album-phase="${pid}"></div>
    </div>`;
  }).join('');
}

// Filled in by loadCurrencyRates() (below) once /api/currency-rates
// resolves — null until then, so the country cards render immediately with
// whatever they already have and pick up live rates a moment later rather
// than blocking on them.
let CURRENCY_RATES = null;

async function loadCurrencyRates() {
  const token = localStorage.getItem('trip-token');
  if (!token) return;
  try {
    const r = await fetch('/api/currency-rates', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    CURRENCY_RATES = await r.json();
    renderInfo(window.TRIP_CONFIG);
  } catch { /* Info tab just keeps showing currency name/symbol without rates */ }
}

// "1 USD ≈ 150.2 JPY · 1 ILS ≈ 40.6 JPY" — the home-currency side is a cross
// rate (both sides already came from the same from=USD lookup), not a
// second API call.
function formatCurrencyRateLine(code) {
  const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const home = CURRENCY_RATES?.home;
  // A USD destination (e.g. a domestic US trip) never has its own entry in
  // rates — the server deliberately never asks the exchange-rate API to
  // convert USD to itself. "1 USD ≈ 1 USD" isn't worth a line either way;
  // only the home-currency side (if any) is — quoted the same way every
  // other line here is, 1 USD as the fixed side, never inverted.
  if (code === 'USD') {
    const perHome = home ? CURRENCY_RATES.rates?.[home] : null;
    if (typeof perHome !== 'number' || perHome <= 0) return '';
    return `1 USD ≈ ${fmt(perHome)} ${home}`;
  }
  if (!CURRENCY_RATES?.rates || typeof CURRENCY_RATES.rates[code] !== 'number') return '';
  const perUsd = CURRENCY_RATES.rates[code];
  const parts = [`1 USD ≈ ${fmt(perUsd)} ${code}`];
  const perHome = home && home !== code ? CURRENCY_RATES.rates[home] : null;
  if (typeof perHome === 'number' && perHome > 0) {
    parts.push(`1 ${home} ≈ ${fmt(perUsd / perHome)} ${code}`);
  }
  return parts.join(' · ');
}

function renderInfo(cfg) {
  const ti = cfg?.travel_info;
  if (!ti) return;

  const countriesEl = document.getElementById('info-countries');
  if (countriesEl) {
    const entries = Object.entries(ti.countries || {});
    const emergencyContacts = ti.emergency_contacts || [];
    countriesEl.innerHTML = entries.map(([name, c]) => {
      const e = c.emergency;
      const emergencyLine = e?.general
        ? `${e.general}${e.unified112 ? ' · 112' : ''}`
        : (e ? `👮 ${e.police || '—'} · 🚑 ${e.ambulance || '—'} · 🚒 ${e.fire || '—'}` : '—');
      const currencyLine = c.currency ? `${c.currency.symbol || ''} ${c.currency.name}`.trim() : '';
      const rateLine = c.currency?.code ? formatCurrencyRateLine(c.currency.code) : '';
      return `<div class="mini">
        <h4>${c.flag ? c.flag + ' ' : ''}${name}</h4>
        <p>📞 <strong class="ltr">${emergencyLine}</strong></p>
        <p>${[currencyLine, c.callingCode].filter(Boolean).join(' · ')}</p>
        ${rateLine ? `<p class="ltr" style="font-size:12px;color:var(--ink-2)">${rateLine}</p>` : ''}
      </div>`;
    }).join('') + emergencyContacts.map(c => `<div class="mini"><h4>${_biSpan(c.name)}</h4><p>📞 <a class="ltr" href="tel:${c.phone}">${c.phone}</a></p></div>`).join('');
  }
  const emrgBlock = document.getElementById('info-block-emrg');
  if (emrgBlock) emrgBlock.style.display = (Object.keys(ti.countries || {}).length || (ti.emergency_contacts || []).length) ? '' : 'none';

  const listBlock = (blockId, listId, items, render) => {
    const block = document.getElementById(blockId);
    const el = document.getElementById(listId);
    const has = (items || []).length > 0;
    if (block) block.style.display = has ? '' : 'none';
    if (el) el.innerHTML = has ? items.map(render).join('') : '';
  };

  listBlock('info-block-health', 'info-health', ti.health, item => `<li>${_biSpan(item)}</li>`);
  listBlock('info-block-hosp', 'info-hospitals', ti.hospitals,
    h => `<li><strong>${_biSpan(h.area)}:</strong> ${h.name}</li>`);
  listBlock('info-block-money', 'info-money', ti.money, item => `<li>${_biSpan(item)}</li>`);
  listBlock('info-block-comm', 'info-communication', ti.communication, item => `<li>${_biSpan(item)}</li>`);
  listBlock('info-block-age', 'info-age-notes', ti.age_notes,
    n => `<li><strong>${_biSpan(n.who)}</strong> — ${_biSpan(n.note)}</li>`);
}

// ── TELEGRAM LOGIN WIDGET ──────────────────────────────────────────────────────
// Pure DOM: shows/hides the widget block and injects Telegram's official
// widget script once per bot username. Fetching /api/health and posting the
// login itself live outside this render block, in initTelegramAuth() /
// onTelegramAuth() near initGoogleAuth().
function renderTelegramLogin(botUsername) {
  const wrap = document.getElementById('telegram-signin-wrap');
  const mount = document.getElementById('telegram-signin-btn');
  if (!wrap || !mount) return;
  if (!botUsername) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  if (mount.dataset.botUsername === botUsername) return; // already injected for this bot
  mount.innerHTML = '';
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login', botUsername);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-onauth', 'onTelegramAuth(user)');
  mount.appendChild(script);
  mount.dataset.botUsername = botUsername;
}

// Maps POST /api/auth/telegram-login's error codes to a localized message.
// telegram_account_not_linked is the one that will actually fire in practice
// until every participant's numeric Telegram ID is added to trip.config.json.
function telegramLoginErrorMessage(code, tr) {
  const messages = {
    telegram_not_configured: tr.err_telegram_not_configured,
    invalid_telegram_login: tr.err_telegram_invalid,
    not_group_member: tr.err_telegram_not_member,
    telegram_membership_check_failed: tr.err_telegram_check_failed,
    telegram_account_not_linked: tr.err_telegram_not_linked,
  };
  return messages[code] || tr.err_wrong;
}

/* ── PHASE PLAN ITEM HELPERS ─────────────────────────────────────────────── */

function _authHeaders() {
  const token = localStorage.getItem('trip-token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function savePlanItem(phaseId, payload) {
  const res = await fetch(`/api/phases/${phaseId}/plan`, { method: 'POST', headers: _authHeaders(), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text());
  const item = await res.json();
  PHASE_PLAN[phaseId] = [...(PHASE_PLAN[phaseId] || []), item];
  return item;
}

async function updatePlanItem(phaseId, id, payload) {
  const res = await fetch(`/api/phases/${phaseId}/plan/${id}`, { method: 'PATCH', headers: _authHeaders(), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text());
  const updated = await res.json();
  PHASE_PLAN[phaseId] = (PHASE_PLAN[phaseId] || []).map(x => x.id === id ? updated : x);
  return updated;
}

async function deletePlanItem(phaseId, id) {
  const res = await fetch(`/api/phases/${phaseId}/plan/${id}`, { method: 'DELETE', headers: _authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  PHASE_PLAN[phaseId] = (PHASE_PLAN[phaseId] || []).filter(x => x.id !== id);
}

// NOTE: a per-day weather badge was dropped here. It read WX_CACHE, which is
// only ever written by _loadPoiWeather() — reachable exclusively from the POI
// click handler whose backing data (POI_DATA) was intentionally removed. So the
// badge always rendered ''. Restoring it needs its own forecast fetch keyed on
// phase.accommodation.weatherKey, not a read of that cache.

// Rough-time tokens mirror ROUGH_TIMES in server.js. Kept as tokens rather than
// free text so they stay translatable and sortable.
const PLAN_ROUGH_TIMES = ['morning', 'noon', 'afternoon', 'evening'];

function _planTimeLabel(t, tr) {
  if (!t) return '';
  return PLAN_ROUGH_TIMES.includes(t) ? (tr[`plan_rough_${t}`] || t) : t;
}

// The enrichment strip: a collapsed line per item that opens to the links the
// model found. Reuses the existing loc-panel pattern rather than inventing a
// second collapsible. Renders nothing at all when there is nothing to show and
// nothing pending, so an un-enrichable item ("pack the suitcases") stays clean.
function _buildEnrichPanel(item, tr) {
  // Parsed first so a link the organizer named ("Podmore") keeps that name even
  // when it is also the item's location_url — otherwise the place with a name
  // is the one that renders as a generic "Google Maps".
  let authored = [];
  try {
    const p = typeof item.extra_links === 'string' ? JSON.parse(item.extra_links) : item.extra_links;
    if (Array.isArray(p)) authored = p.filter(l => l && safeUrl(l.url) && l.label);
  } catch { /* malformed json is simply no authored links */ }
  const namedFor = new Map(authored.map(l => [l.url, l.label]));

  const links = [
    ['🗺️', tr.plan_link_maps,    item.location_url],
    ['🔵', tr.plan_link_waze,    item.waze_url],
    ['🌐', tr.plan_link_website, item.website_url],
    ['🎟️', tr.plan_link_tickets, item.ticket_url],
  ].filter(([, , url]) => safeUrl(url))
   .map(([icon, label, url]) => [icon, namedFor.get(url) || label, url]);

  // Places the organizer linked by hand in the original schedule. An item may
  // name several, and each keeps its own name as the button label.
  // The enrichment buttons above already carry these URLs (now under their
  // authored names), so only the remaining places need their own button.
  const extra = authored.filter(l => !links.some(([, , u]) => u === l.url));

  const pending = item.enrichment_status === 'pending';
  if (!links.length && !extra.length && !pending) return '';

  if (!links.length && !extra.length) {
    return `<div class="plan-enrich plan-enrich-pending">${esc(tr.plan_enriching)}</div>`;
  }
  const row = links.map(([icon, label, url]) =>
    `<a class="btn plan-enrich-link" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${icon} ${esc(label)}</a>`
  ).join('') + extra.map(l =>
    `<a class="btn plan-enrich-link plan-place-link" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">📍 ${esc(l.label)}</a>`
  ).join('');
  return `<div class="loc-panel plan-enrich">
    <button class="loc-panel-hdr" type="button" data-plan-enrich-toggle>
      <span>📍 ${esc(tr.plan_enrich_hdr)}${pending ? ` · ${esc(tr.plan_enriching)}` : ''}</span>
      <span class="loc-panel-chevron">▼</span>
    </button>
    <div class="loc-panel-body">
      <div class="loc-nav-row">${row}</div>
      <div class="plan-enrich-note">${esc(tr.plan_enrich_note)}</div>
    </div>
  </div>`;
}

function _buildPlanItemRow(item, phaseId, tr) {
  // Ticket state, in the same green/red pill vocabulary the rest of the site
  // uses: green once a real booking backs it, red while money still has to
  // change hands. Nothing at all when the place needs no ticket, so the
  // schedule doesn't fill up with reassurances.
  const ticket = item.booking
    ? `<span class="tag g plan-tag" title="${esc(tr.plan_conf_badge)}">✅ ${esc(item.booking.name)}${
        item.booking.confirmation ? ` · ${esc(item.booking.confirmation)}` : ''}</span>`
    : item.needs_tickets
      ? `<span class="tag r plan-tag">⚠️ ${esc(item.advance_booking ? tr.plan_tickets_advance : tr.plan_tickets_needed)}</span>`
      : '';
  const conf = ticket;
  const review = item.status === 'needs_review'
    ? `<span class="plan-needs-review">${esc(tr.plan_needs_review)}</span>`
    : '';
  // Handlers are bound by delegation off these data-* attributes rather than a
  // string-built onclick — an apostrophe in a stored value used to break out of
  // the attribute and execute.
  const del = isOrganizer
    ? `<button class="plan-del-btn" data-plan-del="${esc(item.id)}" data-plan-phase="${esc(phaseId)}" title="${esc(tr.plan_delete_confirm)}">✕</button>`
    : '';
  // The maps link used to be a bare 📍 next to the text; it now lives in the
  // enrichment panel below alongside Waze/site/tickets, so it isn't repeated.
  const when = _planTimeLabel(item.time, tr);
  return `<li class="plan-item" data-id="${esc(item.id)}">
    ${when ? `<strong>${esc(when)}</strong> — ` : ''}${_biSpan({ he: esc(item.text_he), en: esc(item.text_en) })}${conf}${review}${del}
    ${_buildCorrection(item.correction, { he: item.text_he_prev, en: item.text_en_prev }, tr)}
    <span class="plan-err" hidden></span>
    ${_buildEnrichPanel(item, tr)}
  </li>`;
}

// A line the post-reorder review rewrote shows what it used to say, struck
// through, with the reason. Silently swapping words an organizer wrote is how
// a family stops trusting the schedule — the change has to be legible as a
// change, and attributable.
function _buildCorrection(correction, prev, tr) {
  if (!correction) return '';
  const was = _biSpan({ he: prev?.he ? esc(prev.he) : '', en: prev?.en ? esc(prev.en) : '' });
  if (!prev?.he && !prev?.en) return '';
  return `<div class="plan-correction">
    <s class="plan-correction-was">${was}</s>
    <span class="plan-correction-note">✏️ ${esc(correction.note || tr.plan_corrected)}</span>
  </div>`;
}

function _buildAddItemRow(phaseId, date, tr) {
  if (!isOrganizer) return '';
  return `<li class="plan-add-row">
    <select class="plan-rough-in" title="${esc(tr.plan_rough_hint)}">
      <option value="">${esc(tr.plan_rough_none)}</option>
      ${PLAN_ROUGH_TIMES.map(k => `<option value="${k}">${esc(tr['plan_rough_' + k])}</option>`).join('')}
    </select>
    <input class="plan-time-in" type="time" placeholder="${esc(tr.plan_time_ph)}" style="width:110px">
    <input class="plan-text-in" placeholder="${esc(tr.plan_text_ph)}" style="flex:1">
    <button class="btn plan-save-btn" data-plan-add="${esc(phaseId)}" data-plan-date="${esc(date || '')}">${esc(tr.plan_save)}</button>
    <span class="plan-err" hidden></span>
  </li>`;
}

// Rendered in two different branches below (with and without existing items);
// keeping it in one place so the two copies can't drift.
function _buildNewDateRow(phaseId, tr) {
  return `<div class="plan-new-date-row">
    <input class="plan-date-in" type="date" placeholder="YYYY-MM-DD">
    <select class="plan-rough-in" title="${esc(tr.plan_rough_hint)}">
      <option value="">${esc(tr.plan_rough_none)}</option>
      ${PLAN_ROUGH_TIMES.map(k => `<option value="${k}">${esc(tr['plan_rough_' + k])}</option>`).join('')}
    </select>
    <input class="plan-time-in" type="time" placeholder="${esc(tr.plan_time_ph)}" style="width:110px">
    <input class="plan-text-in" placeholder="${esc(tr.plan_text_ph)}" style="flex:1">
    <button class="btn" data-plan-add-new="${esc(phaseId)}">${esc(tr.plan_save)}</button>
    <button class="btn plan-enrich-all" data-plan-enrich-all="1" title="${esc(tr.plan_enrich_all_hint)}">${esc(tr.plan_enrich_all)}</button>
    <button class="btn plan-promote" data-plan-promote="1" title="${esc(tr.plan_promote_hint)}">${esc(tr.plan_promote)}</button>
    <span class="plan-err" hidden></span>
  </div>`;
}

// <input type="time"> already refuses bad input wherever it's supported, but a
// browser that falls back to a plain text box would post whatever was typed and
// get back a bare 400. Same shape the server enforces.
const PLAN_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Enrichment lands seconds after the save returns, so the row that was just
// added would otherwise sit link-less until the next page load. Re-fetch a few
// times, backing off, and stop as soon as nothing is pending. Bounded on
// purpose — Hermes may be unreachable, and the server keeps retrying anyway.
const PLAN_REFRESH_DELAYS = [4000, 8000, 15000, 30000];
const _planRefreshTimers = {};

function scheduleEnrichRefresh(phaseId, step = 0) {
  if (step >= PLAN_REFRESH_DELAYS.length) return;
  clearTimeout(_planRefreshTimers[phaseId]);
  _planRefreshTimers[phaseId] = setTimeout(async () => {
    try {
      const res = await fetch(`/api/phases/${encodeURIComponent(phaseId)}/plan`, { headers: _authHeaders() });
      if (!res.ok) return;
      PHASE_PLAN[phaseId] = await res.json();
      const phase = (window.TRIP_CONFIG?.phases || []).find(p => p.id === phaseId);
      if (phase) renderDays(phase);
      if ((PHASE_PLAN[phaseId] || []).some(i => i.enrichment_status === 'pending')) {
        scheduleEnrichRefresh(phaseId, step + 1);
      }
    } catch { /* transient; the next save or reload will pick it up */ }
  }, PLAN_REFRESH_DELAYS[step]);
}

// Copies the read-only config schedule into the editable plan layer, once.
// Confirmed first because it visibly duplicates the schedule on screen — the
// promoted copy on top, the original still below the separator.
window.handlePromoteConfigDays = async function(btn) {
  const tr = T[currentLang] || T.he;
  if (!confirm(tr.plan_promote_confirm)) return;
  try {
    btn.disabled = true;
    const res = await fetch('/api/phase-plan/promote-config-days', { method: 'POST', headers: _authHeaders() });
    if (!res.ok) throw new Error(`${res.status}`);
    const { created, skipped } = await res.json();
    btn.textContent = created ? `${tr.plan_promote} · ${created}` : tr.plan_promote_none;
    await loadPhasePlans();
    for (const p of (window.TRIP_CONFIG?.phases || [])) {
      renderDays(p);
      scheduleEnrichRefresh(p.id);
    }
    if (!created && skipped) console.info(`[plan] nothing promoted; ${skipped} already present`);
  } catch (e) {
    _planErr(btn, e);
  } finally {
    btn.disabled = false;
  }
};

window.handleEnrichAll = async function(btn) {
  const tr = T[currentLang] || T.he;
  try {
    btn.disabled = true;
    const res = await fetch('/api/phase-plan/enrich-pending', { method: 'POST', headers: _authHeaders() });
    if (!res.ok) throw new Error(`${res.status}`);
    const { in_flight, hermes_configured } = await res.json();
    // "queued 0" is the normal answer when items are already being worked on,
    // so report what the worker will actually process rather than what this
    // click changed — otherwise a working button looks dead.
    btn.textContent = !hermes_configured ? tr.plan_enrich_unavailable
      : in_flight > 0 ? `${tr.plan_enrich_working} (${in_flight})`
      : tr.plan_enrich_nothing;
    for (const p of (window.TRIP_CONFIG?.phases || [])) scheduleEnrichRefresh(p.id);
  } catch (e) {
    _planErr(btn, e);
  } finally {
    btn.disabled = false;
  }
};

// A failed save used to go to console.error only, so the organizer's typed text
// sat in the input looking exactly like a pending save. Show it on the row.
function _planErr(el, e) {
  const box = el?.closest('li, .plan-new-date-row')?.querySelector('.plan-err');
  if (box) { box.textContent = (e && e.message) || String(e); box.hidden = false; }
  console.error('plan item action failed', e);
}

window.handleDeletePlanItem = async function(phaseId, id, btn) {
  const tr = T[currentLang];
  if (!confirm(tr.plan_delete_confirm)) return;
  try {
    await deletePlanItem(phaseId, id);
    const phase = (window.TRIP_CONFIG?.phases || []).find(p => p.id === phaseId);
    if (phase) renderDays(phase);
  } catch(e) { _planErr(btn, e); }
};

// An explicit clock time and a rough slot are mutually exclusive; the rough
// choice wins so picking "afternoon" doesn't silently keep a stale 09:00.
function _planTimeFrom(row) {
  const rough = row.querySelector('.plan-rough-in')?.value || '';
  return rough || (row.querySelector('.plan-time-in')?.value || '').trim();
}

// The clock input only means anything under "exact time"; any rough slot
// disables and clears it, so the row can't show 09:00 next to "afternoon" and
// leave you guessing which one was saved.
function _syncPlanTimeInput(select) {
  const row = select.closest('li, .plan-new-date-row');
  const input = row?.querySelector('.plan-time-in');
  if (!input) return;
  const rough = !!select.value;
  input.disabled = rough;
  if (rough) input.value = '';
}

// Delegated: renderDays() replaces innerHTML, so a listener bound to the
// element itself would not survive a re-render.
document.addEventListener('change', (ev) => {
  const sel = ev.target.closest?.('.plan-rough-in');
  if (sel) _syncPlanTimeInput(sel);
});

window.handleAddPlanItem = async function(phaseId, date, btn) {
  const row = btn.closest('li');
  const time = _planTimeFrom(row);
  const text = row.querySelector('.plan-text-in').value.trim();
  if (!text) return;
  if (time && !PLAN_TIME_RE.test(time) && !PLAN_ROUGH_TIMES.includes(time)) {
    return _planErr(btn, new Error((T[currentLang] || T.he).plan_time_invalid));
  }
  try {
    btn.disabled = true;
    await savePlanItem(phaseId, { date: date || null, time: time || null, text_he: text, text_en: text });
    const phase = (window.TRIP_CONFIG?.phases || []).find(p => p.id === phaseId);
    if (phase) renderDays(phase);
    // The item saves as enrichment_status 'pending'; this pulls the links in
    // once the worker has them, without the organizer reloading.
    scheduleEnrichRefresh(phaseId);
  } catch(e) { btn.disabled = false; _planErr(btn, e); }
};

// One delegated listener for every plan control. renderDays() replaces
// innerHTML wholesale, so per-element listeners would be lost on each render.
document.addEventListener('click', (ev) => {
  const t = ev.target.closest?.(
    '[data-plan-del],[data-plan-add],[data-plan-add-new],[data-plan-enrich-toggle],' +
    '[data-plan-enrich-all],[data-plan-promote]');
  if (!t) return;
  if (t.dataset.planPromote !== undefined) return void handlePromoteConfigDays(t);
  if (t.dataset.planDel !== undefined) {
    handleDeletePlanItem(t.dataset.planPhase, Number(t.dataset.planDel), t);
  } else if (t.dataset.planAdd !== undefined) {
    handleAddPlanItem(t.dataset.planAdd, t.dataset.planDate || '', t);
  } else if (t.dataset.planAddNew !== undefined) {
    handleAddPlanItemNewDate(t.dataset.planAddNew, t);
  } else if (t.dataset.planEnrichToggle !== undefined) {
    // Same collapsible the location panels use; with no data-wxkey it just
    // opens and closes without trying to fetch a forecast.
    toggleLocPanel(t);
  } else {
    handleEnrichAll(t);
  }
});

function renderDays(phase) {
  const el = document.getElementById(`sched-${phase.id}`);
  if (!el) return;
  const tr = T[currentLang] || T['he'];
  const dbItems = PHASE_PLAN[phase.id] || [];
  let html = '';

  // ── DB plan items (organizer's current plan — higher precedence) ──
  if (dbItems.length) {
    // group by date; items with no date go into '' bucket
    const buckets = {};
    for (const item of dbItems) {
      const key = item.date || '';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(item);
    }
    // unscheduled first, then sorted dates
    const keys = [
      ...(buckets[''] ? [''] : []),
      ...Object.keys(buckets).filter(k => k).sort(),
    ];
    for (const key of keys) {
      // The date alone doesn't say what the day IS. Prefer the stored headline
      // (carried over from the config schedule, or written by enrichment) and
      // fall back to the formatted date only when there isn't one yet.
      const label = key
        ? (() => {
            const d = new Date(key + 'T12:00:00');
            const he = d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
            const en = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            const meta = PHASE_PLAN_DAYS[phase.id]?.[key];
            const hl = { he: meta?.label_he || '', en: meta?.label_en || meta?.label_he || '' };
            const pendingHl = meta?.enrichment_status === 'pending' && !hl.he && !hl.en;
            // esc(), like the item text below: _biSpan emits raw HTML so that
            // hand-authored config markup renders, but a stored headline is
            // model output and must never be trusted with that.
            const suffix = hl.he || hl.en
              ? _biSpan({ he: hl.he ? ` — ${esc(hl.he)}` : '', en: hl.en ? ` — ${esc(hl.en)}` : '' })
              : (pendingHl ? `<span class="plan-hl-pending"> · ${esc(tr.plan_enriching)}</span>` : '');
            // A headline the review rewrote carries the same struck-through
            // trail as an item, so a renamed day is never a silent rename.
            const corrected = _buildCorrection(
              meta?.correction, { he: meta?.label_he_prev, en: meta?.label_en_prev }, tr);
            return `<span class="lang-he">${esc(he)}</span><span class="lang-en">${esc(en)}</span>${suffix}${corrected}`;
          })()
        : _biSpan({ he: T.he.plan_unscheduled, en: T.en.plan_unscheduled });
      const itemsHtml = buckets[key].map(item => _buildPlanItemRow(item, phase.id, tr)).join('');
      const addRow = _buildAddItemRow(phase.id, key, tr);
      html += `<div class="day-block db-plan-block">
        <div class="day-label">${label}</div>
        <ul>${itemsHtml}${addRow}</ul>
      </div>`;
    }
    // organizer: show an "add to a new date" row
    if (isOrganizer) html += _buildNewDateRow(phase.id, tr);
  } else if (isOrganizer) {
    // no DB items yet — show a single add row so organizer can start the plan
    html += _buildNewDateRow(phase.id, tr);
  }

  // ── Config days (original schedule — lower precedence) ──
  // Once the plan layer has content it IS the schedule, and showing the static
  // copy underneath just reads as a duplicate. So it collapses, and is shown
  // only to the organizer — who needs it to compare against. With no plan items
  // it's the only schedule there is, so everyone still sees it, expanded.
  if (phase.days?.length) {
    const supersededByPlan = dbItems.length > 0;
    if (!supersededByPlan || isOrganizer) {
      const daysHtml = phase.days.map(day => {
        const items = (day.items || []).map(item =>
          `<li>${item.time ? `<strong>${item.time}</strong> — ` : ''}${_biSpan(item.text)}</li>`
        ).join('');
        return `<div class="day-block">
          <div class="day-label">${_biSpan(day.label)}</div>
          <ul>${items}</ul>
        </div>`;
      }).join('');

      html += supersededByPlan
        ? `<div class="loc-panel plan-orig-panel">
             <button class="loc-panel-hdr" type="button" data-plan-enrich-toggle>
               <span>${_biSpan({ he: T.he.plan_original_sched, en: T.en.plan_original_sched })}</span>
               <span class="loc-panel-chevron">▼</span>
             </button>
             <div class="loc-panel-body">${daysHtml}</div>
           </div>`
        : daysHtml;
    }
  }

  el.innerHTML = html;
}

window.handleAddPlanItemNewDate = async function(phaseId, btn) {
  const row = btn.closest('.plan-new-date-row');
  const date = row.querySelector('.plan-date-in').value.trim();
  const time = _planTimeFrom(row);
  const text = row.querySelector('.plan-text-in').value.trim();
  if (!text) return;
  if (time && !PLAN_TIME_RE.test(time) && !PLAN_ROUGH_TIMES.includes(time)) {
    return _planErr(btn, new Error((T[currentLang] || T.he).plan_time_invalid));
  }
  try {
    btn.disabled = true;
    await savePlanItem(phaseId, { date: date || null, time: time || null, text_he: text, text_en: text });
    const phase = (window.TRIP_CONFIG?.phases || []).find(p => p.id === phaseId);
    if (phase) renderDays(phase);
    // The item saves as enrichment_status 'pending'; this pulls the links in
    // once the worker has them, without the organizer reloading.
    scheduleEnrichRefresh(phaseId);
  } catch(e) { btn.disabled = false; _planErr(btn, e); }
};

/* RENDER_FUNS_END */
/* =========================================================
   INIT
   ========================================================= */
window.addEventListener('load', async () => {
  // A one-time enrollment link short-circuits everything else — no roster,
  // no picker, no auth check. Someone following this link has no account yet.
  if (enrollmentTokenFromUrl()) {
    showEnrollmentForm();
    applyLang(currentLang);
    return;
  }

  // Runs regardless of auth state — this is what populates the "pick
  // yourself" login screen for a visitor who isn't signed in yet.
  await loadLoginRoster();
  buildLoginPicker();

  const authenticated = await checkAuth();
  initGoogleAuth();
  initTelegramAuth();
  if (!authenticated) {
    applyLang(currentLang);
    return;
  }

  await loadTripConfig();
  await loadPhasePlans();
  buildGlobalsFromConfig(window.TRIP_CONFIG);

  loadUsersCache();
  loadRatings();
  loadTaskDone();
  // Load RSVPs for all phases that have activities
  (window.TRIP_CONFIG?.phases || []).forEach(p => {
    if (p.rsvp_activities?.length) loadRsvps(`rsvps-${p.id}`, RSVP_ACTIVITIES[p.id] || []);
  });
  if (document.querySelector('#photos.section.active')) loadPhotosGallery();
  loadLostFound();
  applyLang(currentLang);
  setHero('home');
  applyTweaks();
  initDragDrop();

  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    applyLang(currentLang === 'he' ? 'en' : 'he');
  });

  // Render packing lists
  renderPacking('pack-general', PACKING.general);
  (window.TRIP_CONFIG?.phases || []).forEach(p => {
    if (p.packing?.length) renderPacking(`pack-${p.id}`, PACKING[p.id] || []);
  });

  // Config-driven render: home tab sections
  const cfg = window.TRIP_CONFIG;
  renderStats(cfg);
  renderAlerts(cfg);
  renderHomePhases(cfg);
  loadHomeOverview(cfg);
  renderFamilies(cfg);
  renderTasks(cfg);
  renderTaskDeadlines(currentLang);
  renderInfo(cfg);
  loadCurrencyRates(); // fire-and-forget; re-renders the Info tab once live rates arrive
  // Config-driven render: phase hotel cards + day-by-day schedule
  (cfg?.phases || []).forEach(p => { renderPhaseHotelCard(p); renderDays(p); });
  // Config-driven render: photos tab upload areas
  renderPhotoUploads(cfg);

  checkImmichStatus();
});

// ── TRIVIA GAME NOTIFICATION ──────────────────────────────────────────────────
// Polls for an active trivia game and shows a banner so players can join
(function initTriviaNotification() {
  let banner = null;
  let pollTimer = null;
  let lastStatus = 'idle';

  function createBanner() {
    if (banner) return;
    const el = document.createElement('div');
    el.id = 'trivia-banner';
    el.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:9999',
      'background:linear-gradient(135deg,#7c3aed,#a855f7)',
      'color:#fff', 'padding:14px 20px',
      'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:12px',
      'box-shadow:0 -4px 20px rgba(124,58,237,.5)',
      'font-family:Heebo,sans-serif', 'font-size:1rem', 'font-weight:700',
      'animation:slideUpBanner .4s ease'
    ].join(';');
    const style = document.createElement('style');
    style.textContent = '@keyframes slideUpBanner{from{transform:translateY(100%)}to{transform:none}}';
    document.head.appendChild(style);

    const txt = document.createElement('span');
    txt.textContent = currentLang === 'he'
      ? '🎯 הטריוויה המשפחתית התחילה! הצטרפו עכשיו →'
      : '🏆 Family trivia is live! Join the game →';
    const btn = document.createElement('a');
    btn.href = '/trivia.html';
    btn.style.cssText = 'background:#fff;color:#7c3aed;padding:8px 18px;border-radius:20px;font-size:.9rem;font-weight:700;white-space:nowrap;text-decoration:none;';
    btn.textContent = currentLang === 'he' ? 'הצטרף/י' : 'Join!';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.7);font-size:1.2rem;cursor:pointer;padding:0 4px;';
    close.addEventListener('click', () => { removeBanner(); stopPolling(); });
    el.append(txt, btn, close);
    document.body.appendChild(el);
    banner = el;
  }

  function removeBanner() {
    if (banner) { banner.remove(); banner = null; }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollTrivia() {
    if (!currentUser) return;
    const token = localStorage.getItem('trip-token');
    if (!token) return;
    try {
      const r = await fetch('/api/trivia/state', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const state = await r.json();
      const active = state.status === 'lobby' || state.status === 'question' || state.status === 'reveal' || state.status === 'leaderboard';
      if (active && lastStatus !== state.status) {
        createBanner();
      }
      if (!active) removeBanner();
      lastStatus = state.status;
    } catch (_) {}
  }

  // Start polling 3s after auth to avoid race with page load
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (!currentUser) return;
      pollTrivia();
      pollTimer = setInterval(pollTrivia, 5000);
    }, 3000);
  });

  // Also start polling if user logs in after page load
  document.addEventListener('trivia-poll-start', () => {
    if (pollTimer) return;
    pollTrivia();
    pollTimer = setInterval(pollTrivia, 5000);
  });
})();

/* =========================================================
   BOOKING QUICK-VIEW MODAL
   ========================================================= */
// Dead feature as of this pass: no `tr[data-bk]` elements exist in index.html to trigger
// openBookingModal() below, so this only needs to stay non-crashing, not populated. If this
// modal gets revived, it should read from cfg.bookings (the config-driven system) instead of
// a hardcoded object — the real Bookings tab already does that; this predates it.
const BOOKING_DATA = {};

const BK_TYPE_ICON = { flight: '✈️', hotel: '🏨', car: '🚗', event: '⚽', house: '🏠' };

function confirmationViewUrl(file) {
  return `/confirmations/view/${encodeURIComponent(file)}`;
}

function isStandaloneAppMode() {
  return window.navigator.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches);
}

function confirmationViewAttrs() {
  return isStandaloneAppMode() ? '' : ' target="_blank" rel="noopener"';
}

function initConfirmationViewLinks() {
  // In iOS standalone (home-screen PWA), WebKit opens a blank window
  // synchronously on target="_blank" before JS preventDefault() can fire.
  // Fix: never leave target="_blank" on confirmation view links in standalone.
  const isStandalone = isStandaloneAppMode();

  document.querySelectorAll('a[href*="/confirmations/view/"]').forEach(a => {
    if (isStandalone) {
      a.target = '_self';
      a.removeAttribute('rel');
    } else {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  });

  if (!isStandalone) return;

  // In standalone mode, View = Download: navigate to /confirmations/ URL
  // (same path the Download button uses — iOS handles it correctly there).
  document.addEventListener('click', e => {
    const link = e.target.closest('a[href*="/confirmations/view/"]');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const file = decodeURIComponent(link.href.split('/confirmations/view/').pop());
    window.location.href = `/confirmations/${file}`;
  }, true);
}

function openBookingModal(bkId) {
  const data = BOOKING_DATA[bkId];
  if (!data) return;
  const lang = currentLang;
  const modal = document.getElementById('bk-modal');
  const title = document.getElementById('bk-modal-title');
  const body  = document.getElementById('bk-modal-body');
  if (!modal || !title || !body) return;

  title.textContent = data.title[lang] || data.title.he;

  body.innerHTML = data.items.map(item => {
    const icon = BK_TYPE_ICON[item.type] || '📋';
    const confHtml = item.conf ? `
      <div class="bkm-row">
        <span class="bkm-label">${lang === 'he' ? 'אישור' : 'Conf'}</span>
        <code class="bkm-conf">${item.conf}</code>
        <button class="bkm-copy" data-copy="${item.conf}" title="Copy">⧉</button>
        ${item.pin ? `<span class="bkm-label">PIN</span><code class="bkm-pin">${item.pin}</code>` : ''}
      </div>` : '';
    const metaHtml = (item.dates || item.cost || item.info) ? `
      <div class="bkm-row bkm-meta">
        ${item.dates ? `<span>${item.dates}</span>` : ''}
        ${item.info  ? `<span class="bkm-info">${item.info[lang] || item.info.he}</span>` : ''}
        ${item.cost  ? `<span class="bkm-cost">${item.cost}</span>` : ''}
      </div>` : '';
    const noteHtml = item.note ? `<div class="bkm-note">${item.note[lang] || item.note.he}</div>` : '';
    const pdfsHtml = item.pdfs && item.pdfs.length ? `
      <div class="bkm-pdfs">${item.pdfs.map(p => `
        <span class="bkm-pdf-pair">
          <span class="bkm-pdf-name">📄 ${p.label}</span>
          <a class="bkm-pdf-btn" href="${confirmationViewUrl(p.file)}"${confirmationViewAttrs()}>👁 View</a>
          <a class="bkm-pdf-btn bkm-pdf-dl" href="/confirmations/${p.file}" download="${p.file}">⬇ Download</a>
        </span>`).join('')}
      </div>` : '';
    return `<div class="bkm-item bkm-type-${item.type}">
      <div class="bkm-name">${icon} ${item.name}</div>
      ${confHtml}${metaHtml}${noteHtml}${pdfsHtml}
    </div>`;
  }).join('');

  document.getElementById('bk-modal-overlay')?.classList.add('open');
  modal.classList.add('open');

  body.querySelectorAll('.bkm-copy').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      navigator.clipboard?.writeText(btn.dataset.copy).catch(() => {});
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1500);
    };
  });
}

function closeBookingModal() {
  document.getElementById('bk-modal')?.classList.remove('open');
  document.getElementById('bk-modal-overlay')?.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  initConfirmationViewLinks();
  document.getElementById('bk-modal-close')?.addEventListener('click', closeBookingModal);
  document.getElementById('bk-modal-overlay')?.addEventListener('click', closeBookingModal);
  document.querySelectorAll('tr[data-bk]').forEach(tr => {
    tr.addEventListener('click', () => openBookingModal(tr.dataset.bk));
  });
});
