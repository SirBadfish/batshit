/**
 * SA-072 P2 (DL-10): the iframe half of "Start with Pinokio", injected into every artifact with
 * the rest of `window.batshit` (it does nothing until a Pinokio app answers `app_offline`).
 *
 * - `window.batshit.complete()` on a Pinokio app artifact whose app is not running shows a small
 *   note at the top of the artifact with "Start with Pinokio" instead of an error, asks Batshit's
 *   own page to start the app (the page shows its confirm dialog; the iframe cannot start
 *   anything), and, once the app answers, runs the same call again and returns that result. If
 *   the user says "Not now", the artifact's own `onError` gets the original error.
 * - `window.batshit.pinokio.fetch(path, init)` does the same for panels that call the app's API
 *   through the proxy (`/api/artifacts/pinokio/<path>`).
 *
 * The script is plain ES5-ish text inside a template literal: no backticks, no `${`, and no
 * backslashes, so nothing is re-escaped on the way into the page.
 */
export function generatePinokioRuntimeApi(): string {
  return `
  // SA-072 P2: Start with Pinokio
  window.batshit.pinokio = (function() {
    var START_TIMEOUT_MS = 180000;
    var pending = {};
    var banner = null;

    window.addEventListener('message', function(event) {
      var data = event.data || {};
      if (event.source !== window.parent || data.type !== 'batshit:pinokio:start-result') return;
      if (data.artifactId !== window.batshit.artifactId) return;
      var resolve = pending[data.requestId];
      if (!resolve) return;
      delete pending[data.requestId];
      resolve(data);
    });

    function isOffline(evt) {
      return !!(evt && evt.metadata && evt.metadata.code === 'app_offline');
    }

    function requestStart() {
      var requestId = 'pinokio-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      return new Promise(function(resolve) {
        var timer = setTimeout(function() {
          delete pending[requestId];
          resolve({ ok: false, message: 'Batshit did not answer the start request.' });
        }, START_TIMEOUT_MS);
        pending[requestId] = function(data) { clearTimeout(timer); resolve(data); };
        window.parent.postMessage({ type: 'batshit:pinokio:start-request', artifactId: window.batshit.artifactId, requestId: requestId }, '*');
      });
    }

    function removeBanner() {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
    }

    function makeButton(label) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'batshit-builder-button';
      button.textContent = label;
      return button;
    }

    // Resolves true when the app is running (start it, or it finished starting), false for "Not now".
    function offerStart(meta) {
      removeBanner();
      var title = (meta && meta.title) || 'The app';
      var starting = meta && meta.state === 'starting';
      banner = document.createElement('div');
      banner.className = 'batshit-builder-status batshit-pinokio-offline';
      banner.setAttribute('data-kind', 'warning');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'display:grid;gap:8px;margin:0 0 12px;padding:10px 12px;border:1px solid var(--batshit-border-subtle);border-radius:var(--batshit-radius);font:500 13px/1.4 var(--batshit-font);color:var(--batshit-text);';
      var text = document.createElement('div');
      text.textContent = starting ? title + ' is still starting in Pinokio.' : title + ' is not running in Pinokio.';
      var actions = document.createElement('div');
      actions.className = 'batshit-builder-inline';
      actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
      var go = makeButton(starting ? 'Try Again' : 'Start with Pinokio');
      go.setAttribute('data-batshit-pinokio', 'start');
      var later = makeButton('Not now');
      later.setAttribute('data-batshit-pinokio', 'dismiss');
      actions.appendChild(go);
      actions.appendChild(later);
      banner.appendChild(text);
      banner.appendChild(actions);
      document.body.insertBefore(banner, document.body.firstChild);

      return new Promise(function(resolve) {
        later.addEventListener('click', function() { removeBanner(); resolve(false); });
        go.addEventListener('click', function() {
          if (starting) { text.textContent = 'Trying again…'; resolve(true); return; }
          go.disabled = true;
          later.disabled = true;
          text.textContent = 'Confirm the start in Batshit. Starting ' + title + ' can take a minute.';
          requestStart().then(function(result) {
            if (result && result.ok) {
              text.textContent = title + ' is running. Running again…';
              resolve(true);
              return;
            }
            text.textContent = (result && result.message) || (title + ' did not start.');
            go.disabled = false;
            later.disabled = false;
            if (result && result.state === 'starting') { starting = true; go.textContent = 'Try Again'; }
          });
        });
      });
    }

    function afterRun() {
      removeBanner();
    }

    function proxyFetch(path, init) {
      var clean = String(path || '').replace(/^[/]+/, '');
      var url = '/api/artifacts/pinokio/' + clean;
      return window.batshit._fetch(url, init).then(function(response) {
        if (response.status !== 503) return response;
        return response.clone().json().catch(function() { return null; }).then(function(payload) {
          if (!payload || payload.code !== 'app_offline') return response;
          return offerStart(payload.app || {}).then(function(started) {
            if (!started) { removeBanner(); return response; }
            return window.batshit._fetch(url, init).then(function(retried) { afterRun(); return retried; });
          });
        });
      });
    }

    return { isOffline: isOffline, offerStart: offerStart, afterRun: afterRun, fetch: proxyFetch };
  })();
`
}
