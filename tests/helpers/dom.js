import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { Window } from 'happy-dom';

const HERE   = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', '..', 'site', 'app.js');

let _renderCode = null;

function getRenderCode() {
  if (_renderCode) return _renderCode;
  const src = readFileSync(APP_JS, 'utf8');
  const m = src.match(/\/\* RENDER_FUNS_BEGIN \*\/([\s\S]*?)\/\* RENDER_FUNS_END \*\//);
  if (!m) throw new Error('RENDER_FUNS_BEGIN / RENDER_FUNS_END markers not found in app.js');
  _renderCode = m[1];
  return _renderCode;
}

/**
 * Create a fresh DOM environment with the render functions available.
 * Returns { document, ctx } where ctx exposes the render functions by name.
 *
 * @param {string} html  - innerHTML to seed into document.body
 * @param {object} cfg   - window.TRIP_CONFIG value
 * @param {string} lang  - 'he' | 'en'
 */
export function createRenderContext(html = '', cfg = {}, lang = 'he') {
  const win = new Window({ url: 'http://localhost/' });
  const doc = win.document;
  doc.body.innerHTML = html;

  const ctx = vm.createContext({
    window:      win,
    document:    doc,
    TRIP_CONFIG: cfg,
    currentLang: lang,
    T: {
      he: { upload_click: 'לחץ לבחירת תמונות', bk_err_server: 'שגיאה', bk_no_bookings: 'אין' },
      en: { upload_click: 'Click to upload',    bk_err_server: 'Error',  bk_no_bookings: 'None' },
    },
    console,
  });

  vm.runInContext(getRenderCode(), ctx, { filename: 'app.js (render fns)' });
  return { document: doc, ctx };
}

/** Build the standard render-target HTML used across most tests. */
export const RENDER_TARGETS_HTML = `
  <div id="stat-strip"></div>
  <div id="home-alerts"></div>
  <div id="families-section"></div>
  <div id="tasks-table-wrap"></div>
  <div id="hotel-ny"></div>
  <div id="hotel-colorado"></div>
  <div id="photo-uploads"></div>
`;
