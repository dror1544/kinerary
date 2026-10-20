(function () {
  'use strict';
  const match = location.pathname.match(/^(\/t\/[^/]+)(?:\/|$)/);
  const base = match ? match[1] : '';
  window.KITINERARY_RUNTIME_BASE = base;
  window.runtimePath = function runtimePath(value) {
    if (!base || typeof value !== 'string' || !value.startsWith('/') || value.startsWith(base + '/')) return value;
    return base + value;
  };
  if (!base) return;

  // Every trip behind the gateway shares one origin, hence one localStorage.
  // The session keys are scoped to this trip so that one trip's marker (or
  // cached user) is not read by accident (this is not an isolation boundary: the
  // trips share one origin, so a page's script can still reach the others' keys); everything else is left as it is.
  // Done on Storage.prototype because Classic, Modern and their helpers all read
  // these keys directly, and this file loads before any of them.
  const scopedKeys = ['trip-token', 'tripToken', 'token', 'trip-user'];
  if (typeof Storage !== 'undefined' && Storage.prototype && !Storage.prototype.__kineraryTripScoped) {
    const scope = key => (scopedKeys.includes(key) ? base + ':' + key : key);
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const native = Storage.prototype[method];
      Storage.prototype[method] = function (key, ...rest) {
        return native.call(this, this === window.localStorage ? scope(key) : key, ...rest);
      };
    }
    Object.defineProperty(Storage.prototype, '__kineraryTripScoped', { value: true });
  }

  // This is only a UI session marker. The actual runtime JWT remains inside
  // the gateway's authenticated encrypted HttpOnly cookie and is injected upstream there.
  localStorage.setItem('trip-token', 'runtime-gateway-session');

  const nativeFetch = window.fetch.bind(window);
  window.runtimeLogout = async function () {
    const response = await nativeFetch(base + '/__logout', {
      method: 'POST', headers: { 'X-Kinerary-Logout': '1' },
    });
    if (!response.ok) throw new Error('Sign out failed');
    const { portalUrl } = await response.json();
    ['trip-token', 'tripToken', 'token', 'trip-user'].forEach(key => localStorage.removeItem(key));
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'kinerary:runtime-logout' }, portalUrl);
      location.replace(base + '/__signed_out');
    } else {
      location.assign(portalUrl);
    }
  };

  window.fetch = function (input, init) {
    if (typeof input === 'string') input = window.runtimePath(input);
    else if (input instanceof URL && input.origin === location.origin) input = new URL(window.runtimePath(input.pathname) + input.search + input.hash, input.origin);
    return nativeFetch(input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeOpen.call(this, method, window.runtimePath(url), ...rest);
  };

  const NativeEventSource = window.EventSource;
  window.EventSource = function (url, options) { return new NativeEventSource(window.runtimePath(url), options); };
  window.EventSource.prototype = NativeEventSource.prototype;

  function rewrite(root) {
    const elements = root.querySelectorAll ? root.querySelectorAll('[src],[href],[action]') : [];
    for (const element of elements) {
      for (const attribute of ['src', 'href', 'action']) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith('/')) element.setAttribute(attribute, window.runtimePath(value));
      }
    }
  }
  rewrite(document);
  new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      rewrite(node);
      for (const attribute of ['src', 'href', 'action']) {
        const value = node.getAttribute?.(attribute);
        if (value?.startsWith('/')) node.setAttribute(attribute, window.runtimePath(value));
      }
    }
  }))).observe(document.documentElement, { childList: true, subtree: true });
})();
