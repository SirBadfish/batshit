/**
 * Artifact API Generator
 *
 * Factory function that generates the window.batshit API script for artifact iframes.
 * This replaces the inline string literal that was previously in +server.ts.
 *
 * Benefits:
 * - Testable in isolation
 * - Feature flags for new capabilities
 * - Version header for forward compatibility
 * - Easier to maintain and extend
 *
 * @version 1.0.0
 * @since SA-011
 */

import { generateNdjsonConsumerScript } from '$lib/utils/ndjsonConsumer';
import { SHARE_TO_CHAT_API } from './shareToChat';

export interface ArtifactApiConfig {
  artifactId: string;
  artifactName?: string;
  webhookUrl?: string | null;
  sessionId?: string | null;
  runtimeToken?: string | null;
  storageSnapshot?: Record<string, unknown> | null;
  apiVersion?: string;
  features?: {
    files?: boolean;      // Image generation support (SA-010)
    audio?: boolean;      // Speech/TTS support (SA-011 Phase 3)
    streaming?: boolean;  // Object streaming support (SA-011 Phase 4)
  };
}

/**
 * Batshit theme CSS variables - injected into artifacts for theme consistency.
 * Templates should use these variables so future theme switching "just works".
 */
export const BATSHIT_THEME_CSS = `
<style id="batshit-theme-variables">
  @font-face {
    font-family: "Geist Sans";
    src: url("/artifact-assets/fonts/geist/Geist-Variable.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }

  @font-face {
    font-family: "Geist Mono";
    src: url("/artifact-assets/fonts/geist/GeistMono-Variable.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }

  :root {
    color-scheme: dark;

    /* Batshit launch-dark app palette */
    --batshit-bg: oklch(0.11 0.02 276);
    --batshit-surface: oklch(0.108 0.014 278);
    --batshit-surface-elevated: oklch(0.16 0.024 281);
    --batshit-surface-inset: color-mix(
      in oklab,
      var(--batshit-surface) 50%,
      oklch(0.28 0.02 282.95)
    );
    --batshit-text: oklch(0.87 0.008 289.95);
    --batshit-text-strong: oklch(0.94 0.006 289.95);
    --batshit-text-secondary: oklch(0.56 0.016 289.95);
    --batshit-muted: oklch(0.49 0.014 289.95);
    --batshit-faint: oklch(0.39 0.011 289.95);
    --batshit-accent: oklch(0.5 0.044 281);
    --batshit-accent-hover: oklch(0.56 0.05 281.84);
    --batshit-accent-foreground: oklch(0.96 0.006 289.95);
    --batshit-accent-soft: oklch(0.5 0.044 281 / 0.34);
    --batshit-accent-faint: oklch(0.5 0.044 281 / 0.16);
    --batshit-success: oklch(0.72 0.115 185);
    --batshit-danger: oklch(0.64 0.275 358);
    --batshit-warning: oklch(0.75 0.13 85);
    --batshit-info: oklch(0.637 0.237 250);
    --batshit-border: oklch(0.62 0.024 282 / 0.2);
    --batshit-border-strong: oklch(0.68 0.026 282 / 0.28);
    --batshit-border-subtle: oklch(0.62 0.024 282 / 0.12);
    --batshit-field: oklch(0.54 0.044 281 / 0.22);
    --batshit-field-hover: oklch(0.56 0.044 281 / 0.3);
    --batshit-field-border: oklch(0.74 0.03 282 / 0.3);
    --batshit-field-border-hover: oklch(0.78 0.034 282 / 0.46);
    --batshit-field-focus-ring: oklch(0.56 0.05 281 / 0.34);
    --batshit-select-arrow: oklch(0.78 0.028 289.95);
    --batshit-control-surface: color-mix(
      in oklab,
      var(--batshit-surface-elevated) 72%,
      var(--batshit-primary) 28%
    );

    /* Semantic aliases */
    --batshit-primary: var(--batshit-accent);
    --batshit-primary-hover: var(--batshit-accent-hover);
    --batshit-primary-foreground: var(--batshit-accent-foreground);

    /* Spacing */
    --batshit-radius-sm: 4px;
    --batshit-radius: 8px;
    --batshit-radius-lg: 12px;

    /* Typography */
    --batshit-font: "Geist Sans", system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --batshit-font-mono: "Geist Mono", ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, monospace;
  }

  html body :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="image"]):not([type="color"]), textarea, select):not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    box-sizing: border-box !important;
    width: 100%;
    min-height: 40px !important;
    border: 1px solid var(--batshit-field-border) !important;
    border-radius: var(--batshit-radius) !important;
    background-color: var(--batshit-field) !important;
    color: var(--batshit-text) !important;
    padding: 10px 12px !important;
    font: 450 13px/1.4 var(--batshit-font) !important;
    letter-spacing: 0 !important;
    outline: none !important;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  html body textarea:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    min-height: 96px !important;
    resize: vertical;
  }

  html body select:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    -webkit-appearance: none !important;
    appearance: none !important;
    padding-right: 38px !important;
    color-scheme: dark;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--batshit-select-arrow) 50%),
      linear-gradient(135deg, var(--batshit-select-arrow) 50%, transparent 50%) !important;
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50% !important;
    background-size: 5px 5px, 5px 5px !important;
    background-repeat: no-repeat !important;
  }

  html body select[multiple]:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    min-height: 96px !important;
    padding-right: 12px !important;
    background-image: none !important;
  }

  html body select:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) option,
  html body select:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) optgroup {
    min-height: 32px;
    padding: 8px 12px;
    background-color: oklch(0.14 0.018 281);
    color: var(--batshit-text);
  }

  html body select:not(.batshit-unstyled):not([data-batshit-unstyled="true"]) option:checked {
    background-color: color-mix(in oklab, var(--batshit-primary) 45%, oklch(0.14 0.018 281));
    color: var(--batshit-text-strong);
  }

  html body :is(input, textarea):not(.batshit-unstyled):not([data-batshit-unstyled="true"])::placeholder {
    color: var(--batshit-faint);
  }

  html body :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="image"]):not([type="color"]), textarea, select):not(.batshit-unstyled):not([data-batshit-unstyled="true"]):hover {
    border-color: var(--batshit-field-border-hover) !important;
    background-color: var(--batshit-field-hover) !important;
  }

  html body :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="image"]):not([type="color"]), textarea, select):not(.batshit-unstyled):not([data-batshit-unstyled="true"]):focus {
    border-color: var(--batshit-accent-hover) !important;
    background-color: var(--batshit-field-hover) !important;
    box-shadow: 0 0 0 2px var(--batshit-field-focus-ring) !important;
  }

  html body :is(input:disabled, textarea:disabled, select:disabled):not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    cursor: not-allowed;
    opacity: 0.62;
  }

  html body :is(button, input[type="button"], input[type="submit"], input[type="reset"]):not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    min-height: 36px !important;
    border: 1px solid color-mix(in oklab, var(--batshit-primary) 30%, var(--batshit-border)) !important;
    border-radius: var(--batshit-radius) !important;
    background-color: color-mix(in oklab, var(--batshit-surface-elevated) 86%, var(--batshit-primary) 14%) !important;
    color: var(--batshit-text-strong) !important;
    padding: 0 14px !important;
    font: 650 13px/1 var(--batshit-font) !important;
    letter-spacing: 0 !important;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease,
      color 120ms ease;
  }

  html body :is(button, input[type="button"], input[type="submit"], input[type="reset"]):not(.batshit-unstyled):not([data-batshit-unstyled="true"]):hover {
    border-color: var(--batshit-primary-hover) !important;
    background-color: color-mix(in oklab, var(--batshit-primary) 24%, var(--batshit-surface-elevated)) !important;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--batshit-primary) 18%, transparent) !important;
  }

  html body :is(button, input[type="button"], input[type="submit"], input[type="reset"]):not(.batshit-unstyled):not([data-batshit-unstyled="true"]):focus-visible {
    outline: none !important;
    box-shadow: 0 0 0 2px var(--batshit-field-focus-ring) !important;
  }

  html body :is(button:disabled, input[type="button"]:disabled, input[type="submit"]:disabled, input[type="reset"]:disabled):not(.batshit-unstyled):not([data-batshit-unstyled="true"]) {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
`;

/**
 * Generate the complete window.batshit API script for an artifact.
 *
 * @param config - Configuration for the artifact API
 * @returns Complete script tag with the API code
 */
export function generateArtifactApiScript(config: ArtifactApiConfig): string {
  const {
    artifactId,
    artifactName = 'Artifact',
    webhookUrl = null,
    sessionId = null,
    runtimeToken = null,
    storageSnapshot = null,
    apiVersion = '1.0.0',
    features = { files: true, audio: true, streaming: true }
  } = config;

  // Get the NDJSON consumer script
  const ndjsonConsumer = generateNdjsonConsumerScript();

  // Escape values for safe injection
  const escapedArtifactId = escapeForJs(artifactId);
  const escapedArtifactName = escapeForJs(artifactName);
  const escapedWebhookUrl = webhookUrl ? `'${escapeForJs(webhookUrl)}'` : 'null';
  const escapedSessionId = sessionId ? `'${escapeForJs(sessionId)}'` : 'null';
  const escapedRuntimeToken = runtimeToken ? `'${escapeForJs(runtimeToken)}'` : 'null';
  const escapedStorageSnapshot = escapeJsonForScript(storageSnapshot || {});

  return `
<script>
(function() {
  // Batshit Artifact API v${apiVersion} (SA-011)
  // Features: files=${features.files}, audio=${features.audio}, streaming=${features.streaming}

  ${ndjsonConsumer}

  window.batshit = window.batshit || {};
  window.batshit.artifactId = '${escapedArtifactId}';
  window.batshit.artifactName = '${escapedArtifactName}';
  window.batshit.artifactWebhook = ${escapedWebhookUrl};
  window.batshit.sessionId = ${escapedSessionId};
  window.batshit.apiVersion = '${apiVersion}';
  window.batshit.runtimeToken = ${escapedRuntimeToken};
  window.batshit._storageCache = ${escapedStorageSnapshot};

  const batshitNativeFetch = window.fetch.bind(window);
  const batshitRuntimeApiPaths = [
    '/api/artifacts/clip-sources',
    '/api/artifacts/complete',
    '/api/artifacts/env',
    '/api/artifacts/run-event',
    '/api/artifacts/share',
    '/api/artifacts/storage',
    '/api/artifacts/comfyui/'
  ];

  function batshitUrlForFetch(input) {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        return new URL(String(input), window.location.href);
      }
      if (input && typeof input.url === 'string') {
        return new URL(input.url, window.location.href);
      }
    } catch (_) {}
    return null;
  }

	  function shouldAttachBatshitRuntimeAuth(input) {
	    if (!window.batshit.runtimeToken) return false;
	    const target = batshitUrlForFetch(input);
	    if (!target) return false;
	    const pageOrigin = new URL(window.location.href).origin;
    if (target.origin !== pageOrigin) return false;
    return batshitRuntimeApiPaths.some(function(path) {
	      return path.endsWith('/') ? target.pathname.startsWith(path) : target.pathname === path;
	    });
	  }

	  function isBatshitProtectedMediaUrl(input) {
	    const target = batshitUrlForFetch(input);
	    if (!target) return false;
	    const pageOrigin = new URL(window.location.href).origin;
	    return target.origin === pageOrigin && target.pathname === '/api/artifacts/comfyui/view';
	  }

	  window.batshit._fetch = function(input, init) {
	    const options = Object.assign({}, init || {});
	    const headers = new Headers(options.headers || {});
	    if (window.batshit.runtimeToken) {
      headers.set('Authorization', 'Bearer ' + window.batshit.runtimeToken);
      options.credentials = 'omit';
    } else if (!options.credentials) {
      options.credentials = 'include';
    }
    options.headers = headers;
    return batshitNativeFetch(input, options);
  };

  window.fetch = function(input, init) {
    if (shouldAttachBatshitRuntimeAuth(input)) {
      return window.batshit._fetch(input, init);
	    }
	    return batshitNativeFetch(input, init);
	  };

	  window.batshit.resolveMediaUrl = async function(input, init) {
	    if (!isBatshitProtectedMediaUrl(input)) {
	      return String(input);
	    }

	    const response = await window.batshit._fetch(input, init);
	    if (!response.ok) {
	      throw new Error('Failed to load artifact media: ' + response.status + ' ' + response.statusText);
	    }

	    const blob = await response.blob();
	    if (window.URL && typeof window.URL.createObjectURL === 'function') {
	      return window.URL.createObjectURL(blob);
	    }

	    return await new Promise(function(resolve, reject) {
	      const reader = new FileReader();
	      reader.onload = function() { resolve(String(reader.result || '')); };
	      reader.onerror = function() { reject(reader.error || new Error('Failed to read artifact media')); };
	      reader.readAsDataURL(blob);
	    });
	  };

	  const batshitProtectedMediaSelector = 'img[src], video[src], source[src]';

	  async function resolveProtectedMediaElement(element) {
	    if (!element || typeof element.getAttribute !== 'function') return;
	    const source = element.getAttribute('src');
	    if (!source || !isBatshitProtectedMediaUrl(source)) return;
	    if (element.dataset.batshitMediaState === 'resolving' && element.dataset.batshitMediaSource === source) return;

	    element.dataset.batshitMediaState = 'resolving';
	    element.dataset.batshitMediaSource = source;

	    try {
	      const displayUrl = await window.batshit.resolveMediaUrl(source);
	      if (element.getAttribute('src') !== source) {
	        if (displayUrl.startsWith('blob:') && window.URL && typeof window.URL.revokeObjectURL === 'function') {
	          window.URL.revokeObjectURL(displayUrl);
	        }
	        return;
	      }

	      const previousDisplayUrl = element.dataset.batshitMediaDisplayUrl;
	      element.setAttribute('src', displayUrl);
	      element.dataset.batshitMediaDisplayUrl = displayUrl;
	      element.dataset.batshitMediaState = 'resolved';
	      if (
	        previousDisplayUrl &&
	        previousDisplayUrl.startsWith('blob:') &&
	        window.URL &&
	        typeof window.URL.revokeObjectURL === 'function'
	      ) {
	        window.URL.revokeObjectURL(previousDisplayUrl);
	      }
	      if (element.tagName === 'SOURCE' && element.parentElement && typeof element.parentElement.load === 'function') {
	        element.parentElement.load();
	      } else if (typeof element.load === 'function') {
	        element.load();
	      }
	    } catch (error) {
	      element.dataset.batshitMediaState = 'error';
	      console.warn('[batshit artifact] Failed to resolve protected media URL', error);
	    }
	  }

	  function scanProtectedMedia(root) {
	    if (!root || typeof root.querySelectorAll !== 'function') return;
	    if (root.matches && root.matches(batshitProtectedMediaSelector)) {
	      resolveProtectedMediaElement(root);
	    }
	    root.querySelectorAll(batshitProtectedMediaSelector).forEach(resolveProtectedMediaElement);
	  }

	  function startProtectedMediaObserver() {
	    if (window.batshit._protectedMediaObserverStarted) return;
	    const observerRoot = document.documentElement || document;
	    if (!observerRoot || typeof MutationObserver === 'undefined') return;
	    window.batshit._protectedMediaObserverStarted = true;
	    scanProtectedMedia(document);
	    const observer = new MutationObserver(function(mutations) {
	      for (const mutation of mutations) {
	        if (mutation.type === 'attributes') {
	          resolveProtectedMediaElement(mutation.target);
	          continue;
	        }
	        mutation.addedNodes.forEach(function(node) {
	          if (node.nodeType === 1) scanProtectedMedia(node);
	        });
	      }
	    });
	    observer.observe(observerRoot, {
	      childList: true,
	      subtree: true,
	      attributes: true,
	      attributeFilter: ['src']
	    });
	    window.batshit._protectedMediaObserver = observer;
	  }

	  startProtectedMediaObserver();

	  window.batshit._persistStorage = async function(operation, key, value) {
    if (!window.batshit.runtimeToken) return null;
    const res = await window.batshit._fetch('/api/artifacts/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artifactId: window.batshit.artifactId,
        operation,
        key,
        value
      })
    });
    if (!res.ok) {
      throw new Error('Failed to persist artifact storage');
    }
    return await res.json();
  };

  // SA-042: Fabric Field Registry — tracks all fabricId-enabled primitives
  window.batshit._fabricFields = [];
  window.batshit._fabricSetters = {};

  /**
   * Call the artifact completion endpoint
   */
  async function callCompletion(prompt, options = {}) {
    if (!prompt) throw new Error('Prompt is required');

    const body = {
      artifactId: window.batshit.artifactId,
      prompt,
      context: options.context || null,
      mode: options.mode || 'complete',
      webhookUrl: options.webhookUrl || null,
      sessionId: options.sessionId || window.batshit.sessionId || null,
      model: options.model || null,
      // SA-011 Phase 1: Image generation parameters
      n: options.n || undefined,
      size: options.size || undefined,
      aspectRatio: options.aspectRatio || undefined,
      // SA-011 Phase 2: Reference image parameters
      images: options.images || undefined,
      providerOptions: options.providerOptions || undefined,
      // SA-011 Phase 4: Structured object streaming parameters
      schema: options.schema || undefined,
      schemaName: options.schemaName || undefined,
      schemaDescription: options.schemaDescription || undefined
    };

    if (window.batshit.artifactWebhook && !body.webhookUrl) {
      body.webhookUrl = window.batshit.artifactWebhook;
    }

    const controller = options.signal ? null : new AbortController();
    const res = await window.batshit._fetch('/api/artifacts/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal || controller?.signal,
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      let detail = 'Rate limit hit';
      try {
        const parsed = await res.json();
        detail = parsed.error || detail;
      } catch (_) {}
      throw new Error(detail);
    }

    if (!res.ok) {
      const message = res.status === 401 ? 'Not signed in' : 'Completion failed';
      throw new Error(message);
    }

    const activeRun = { runId: null };
    function reportClientRunEvent(eventType, message, details) {
      if (!activeRun.runId) return;
      window.batshit._fetch('/api/artifacts/run-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactId: window.batshit.artifactId,
          runId: activeRun.runId,
          eventType,
          message,
          details
        })
      }).catch(function() {});
    }

    function callRunHook(name, callback, args) {
      if (typeof callback !== 'function') return undefined;
      try {
        return callback.apply(null, args);
      } catch (hookError) {
        reportClientRunEvent('callback_error', hookError && hookError.message ? hookError.message : 'Artifact callback failed', {
          hook: name,
          eventType: args && args[args.length - 1] && args[args.length - 1].type
        });
        throw hookError;
      }
    }

    let result;
    try {
      result = await consumeNdjson(res, {
        onStart: function(evt) {
          activeRun.runId = evt && evt.metadata && evt.metadata.runId ? evt.metadata.runId : activeRun.runId;
          return callRunHook('onStart', options.onStart, [evt]);
        },
        onChunk: function(text, evt) { return callRunHook('onChunk', options.onChunk, [text, evt]); },
        onThinking: function(text, evt) { return callRunHook('onThinking', options.onThinking, [text, evt]); },
        onFile: function(base64, mediaType, evt) { return callRunHook('onFile', options.onFile, [base64, mediaType, evt]); },
        onAudio: function(audioData, mediaType, evt) { return callRunHook('onAudio', options.onAudio, [audioData, mediaType, evt]); },
        onObjectPartial: function(object, evt) { return callRunHook('onPartial', options.onPartial, [object, evt]); },
        onObjectFinal: function(object, evt) { return callRunHook('onObject', options.onObject, [object, evt]); },
        onToolCall: function(call, evt) { return callRunHook('onToolCall', options.onToolCall, [call, evt]); },
        onToolResult: function(resultPayload, evt) { return callRunHook('onToolResult', options.onToolResult, [resultPayload, evt]); },
        onEnd: function(evt) { return callRunHook('onEnd', options.onEnd, [evt]); },
        onError: function(error, evt) { return callRunHook('onError', options.onError, [error, evt]); },
        onEvent: function(evt) { return callRunHook('onEvent', options.onEvent, [evt]); }
      });
    } catch (consumeError) {
      reportClientRunEvent('consumer_error', consumeError && consumeError.message ? consumeError.message : 'Artifact stream consumer failed', null);
      throw consumeError;
    }

    return {
      text: result.text,
      events: result.events,
      metadata: result.metadata,
      files: result.files,
      audio: result.audio,
      object: result.object  // SA-011 Phase 4: Final structured object
    };
  }

  // Core completion methods
  window.batshit.complete = callCompletion;
  window.batshit.enhance = (prompt, context) => callCompletion(prompt, { mode: 'enhance', context });
  window.batshit.fix = (prompt, context) => callCompletion(prompt, { mode: 'fix', context });
  window.batshit.explain = (prompt, context) => callCompletion(prompt, { mode: 'explain', context });

  ${features.files ? generateImageApi() : ''}
  ${features.audio ? generateSpeechApi() : ''}
  ${features.streaming ? generateObjectStreamApi() : ''}
  ${generateBuilderKitApi()}

  // Metadata helper
  window.batshit.getMetadata = function() {
    return {
      id: window.batshit.artifactId,
      name: window.batshit.artifactName,
      type: 'artifact',
      version: window.batshit.apiVersion,
      features: ${JSON.stringify(features)}
    };
  };

  // Secure API key retrieval (SA-044)
  window.batshit.env = async function(keyName) {
    if (!keyName || typeof keyName !== 'string') throw new Error('Key name is required');
    const res = await window.batshit._fetch('/api/artifacts/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId: window.batshit.artifactId, keyName })
    });
    if (res.status === 404) return null;
    if (res.status === 403) throw new Error('Key not accessible from artifacts');
    if (res.status === 429) throw new Error('Rate limit exceeded');
    if (!res.ok) throw new Error('Failed to retrieve key');
    const data = await res.json();
    return data.value || null;
  };

  // Clip Vault image sources for image/artifact workflows.
  window.batshit.listClipSources = async function() {
    const params = new URLSearchParams({ artifactId: window.batshit.artifactId });
    const res = await window.batshit._fetch('/api/artifacts/clip-sources?' + params.toString());
    if (res.status === 401) throw new Error('Artifact runtime auth is required');
    if (!res.ok) throw new Error('Failed to load Clip Vault image sources');
    const data = await res.json();
    return Array.isArray(data.sources) ? data.sources : [];
  };

  window.batshit.resolveClipSource = async function(clipId, options = {}) {
    if (!clipId || typeof clipId !== 'string') throw new Error('Clip ID is required');
    const res = await window.batshit._fetch('/api/artifacts/clip-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artifactId: window.batshit.artifactId,
        clipId,
        prefer: options.prefer || 'auto'
      })
    });
    if (res.status === 401) throw new Error('Artifact runtime auth is required');
    if (res.status === 404) throw new Error('Clip source not found');
    if (res.status === 413) throw new Error('Clip source is too large without a public or tunnel URL');
    if (!res.ok) {
      let message = 'Failed to resolve Clip Vault source';
      try {
        const data = await res.json();
        message = data.message || data.error || message;
      } catch (_) {}
      throw new Error(message);
    }
    const data = await res.json();
    if (!data.source || typeof data.source !== 'object') {
      throw new Error('Clip source response was invalid');
    }
    return data.source;
  };

  // Event bus
  window.batshit.events = {
    listeners: {},
    on: function(event, callback) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(callback);
    },
    emit: function(event, data) {
      if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    },
    off: function(event, callback) {
      if (!this.listeners[event]) return;
      const index = this.listeners[event].indexOf(callback);
      if (index > -1) this.listeners[event].splice(index, 1);
    }
  };

  // Namespaced storage
  window.batshit.storage = {
    get: function(key) {
      return Object.prototype.hasOwnProperty.call(window.batshit._storageCache, key)
        ? window.batshit._storageCache[key]
        : null;
    },
    set: function(key, value) {
      window.batshit._storageCache[key] = value;
      window.batshit._persistStorage('set', key, value).catch(function(err) {
        console.warn('Failed to persist artifact storage:', err);
      });
    },
    remove: function(key) {
      delete window.batshit._storageCache[key];
      window.batshit._persistStorage('remove', key).catch(function(err) {
        console.warn('Failed to remove artifact storage:', err);
      });
    },
    clear: function() {
      window.batshit._storageCache = {};
      window.batshit._persistStorage('clear').catch(function(err) {
        console.warn('Failed to clear artifact storage:', err);
      });
    }
  };

  // Signal ready state
  window.batshit.ready = true;
  window.parent.postMessage({
    type: 'batshit:artifact:ready',
    version: '${apiVersion}',
    artifactId: window.batshit.artifactId,
    features: ${JSON.stringify(features)},
    fabricFields: typeof window.batshit.getFabricFields === 'function' ? window.batshit.getFabricFields() : []
  }, '*');

})();

${SHARE_TO_CHAT_API}
<\/script>
`;
}

/**
 * Generate the image generation API methods.
 * Supports both:
 * 1. Multimodal models that return files via streamText()
 * 2. Dedicated image models via generateImage()
 *
 * Phase 2 adds reference image support for editing, style transfer, and character consistency.
 */
function generateImageApi(): string {
  return `
  // SA-011 Phase 1 & 2: Image generation API
  // Supports multimodal LLMs and dedicated image models with reference image support
  //
  window.batshit.generateImage = async function(prompt, options = {}) {
    if (!prompt) throw new Error('Prompt is required');

    const {
      model,           // Exact current model ID selected by the user/catalog
      n = 1,           // Number of images
      size,            // Image size for models that support explicit dimensions
      aspectRatio,     // Aspect ratio for models that support ratio controls
      // SA-011 Phase 2: Reference image options
      styleRef,        // Style reference: { url, weight } or [{ url, weight }]
      characterRef,    // Character reference: { images: [url, ...] }
      imageRef,        // Image reference: [{ url, weight }]
      onProgress,      // Optional progress callback
      ...restOptions
    } = options;

    // Build providerOptions based on what's provided
    let providerOptions = restOptions.providerOptions || null;
    if (model && (styleRef || characterRef || imageRef)) {
      providerOptions = providerOptions || {};
      // Determine provider from model name
      const isLuma = model.includes('photon');
      if (isLuma) {
        providerOptions.luma = providerOptions.luma || {};
        if (styleRef) {
          providerOptions.luma.style_ref = Array.isArray(styleRef) ? styleRef : [styleRef];
        }
        if (characterRef) {
          providerOptions.luma.character_ref = { identity0: characterRef };
        }
        if (imageRef) {
          providerOptions.luma.image_ref = Array.isArray(imageRef) ? imageRef : [imageRef];
        }
      }
    }

    const result = await callCompletion(prompt, {
      ...restOptions,
      model: model || restOptions.model,
      mode: 'generate',
      n,
      size,
      aspectRatio,
      providerOptions,
      onStart: (evt) => {
        if (onProgress) onProgress({ status: 'started', ...evt });
        if (restOptions.onStart) restOptions.onStart(evt);
      },
      onFile: (file) => {
        if (onProgress) onProgress({ status: 'image_received', file });
        if (restOptions.onFile) restOptions.onFile(file);
      }
    });

    // Return first image if available, otherwise null
    const images = result.files?.filter(f => f.mediaType?.startsWith('image/')) || [];
    return {
      image: images[0]?.base64 || null,
      images: images,
      text: result.text,
      metadata: result.metadata
    };
  };

  // SA-011 Phase 2: Edit/modify an existing image with natural language
  // Supports provider-specific editing options when the selected model exposes them.
  window.batshit.editImage = async function(options = {}) {
    const { prompt, image, model, weight = 0.8, ...rest } = options;
    if (!prompt) throw new Error('Prompt is required');
    if (!image) throw new Error('Image is required (URL or base64 data URL)');

    // Build provider-specific options based on model
    let providerOptions = rest.providerOptions || null;
    let images = rest.images || null;

    const isLuma = model && model.includes('photon');
    const isFal = model && (model.includes('fal-ai') || model.includes('flux'));

    if (isLuma) {
      providerOptions = {
        luma: {
          modify_image_ref: { url: image, weight }
        }
      };
    } else if (isFal) {
      providerOptions = {
        fal: { image_url: image }
      };
    } else {
      // For other models (like Gemini), pass as images array
      images = [{ url: image, data: image }];
    }

    const result = await callCompletion(prompt, {
      ...rest,
      model,
      mode: 'edit',
      images,
      providerOptions
    });

    const resultImages = result.files?.filter(f => f.mediaType?.startsWith('image/')) || [];
    return {
      image: resultImages[0]?.base64 || null,
      images: resultImages,
      text: result.text,
      metadata: result.metadata
    };
  };
`;
}

/**
 * Generate the speech/TTS API methods.
 * Uses generateSpeech from Vercel AI SDK.
 */
function generateSpeechApi(): string {
  return `
  // SA-011: Speech/TTS API (Phase 3)
  // Uses generateSpeech for text-to-speech
  window.batshit.speak = async function(text, options = {}) {
    const result = await callCompletion(text, {
      ...options,
      mode: 'speech'
    });

    const audioFile = result.audio?.[0];
    return {
      audioData: audioFile?.audioData || null,
      audioUrl: audioFile?.audioData ? \`data:\${audioFile.mediaType};base64,\${audioFile.audioData}\` : null,
      mediaType: audioFile?.mediaType || 'audio/mp3',
      text: result.text,
      metadata: result.metadata
    };
  };
`;
}

/**
 * Generate the structured object streaming API methods.
 * Uses server-side structured output streaming (streamText + Output.object).
 */
function generateObjectStreamApi(): string {
  return `
  // SA-011 Phase 4: Structured Object Streaming API
  // Streams structured JSON objects with real-time partial updates
  //
  // Example usage:
  //   const result = await window.batshit.streamObject({
  //     prompt: 'Generate a product catalog with 5 items',
  //     schema: {
  //       type: 'object',
  //       properties: {
  //         items: {
  //           type: 'array',
  //           items: {
  //             type: 'object',
  //             properties: {
  //               name: { type: 'string' },
  //               price: { type: 'number' },
  //               description: { type: 'string' }
  //             }
  //           }
  //         }
  //       }
  //     },
  //     onPartial: (partialObject) => {
  //       // Called with each partial update - render progressively!
  //       renderCatalog(partialObject);
  //     }
  //   });
  //
  window.batshit.streamObject = async function(options = {}) {
    const { prompt, schema, schemaName, schemaDescription, onPartial, model, ...rest } = options;

    if (!prompt) throw new Error('prompt is required');
    if (!schema) throw new Error('schema (JSON Schema) is required');

    const result = await callCompletion(prompt, {
      ...rest,
      model,
      mode: 'object',
      schema,
      schemaName,
      schemaDescription,
      onPartial  // Will be called for each object_partial event
    });

    return {
      object: result.object,
      text: result.text,
      metadata: result.metadata
    };
  };
`;
}

/**
 * Generate builder-kit primitives for artifact runtime composition.
 * Includes form/output/action families with shared defaults and quality guards.
 */
function generateBuilderKitApi(): string {
  return `
  // Lane B P2: Artifact Builder Kit Runtime Primitives
  window.batshit.builder = window.batshit.builder || {};
  (function(builder) {
    const STYLE_ID = 'batshit-builder-kit-styles';
    const FIELD_CLASS = 'batshit-builder-field';
    const SURFACE_CLASS = 'batshit-builder-surface';

    function toArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asString(value, fallback = '') {
      return typeof value === 'string' ? value : fallback;
    }

    function sanitizeFilename(value) {
      const raw = asString(value, '').trim().toLowerCase();
      const safe = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
      return safe || 'artifact-output';
    }

    function trimString(value) {
      return asString(value).trim();
    }

    function asBoolean(value, fallback = false) {
      return typeof value === 'boolean' ? value : fallback;
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.batshit-builder-root{display:grid;gap:14px;padding:15px;border:1px solid color-mix(in oklab,var(--batshit-primary) 22%,var(--batshit-border));border-radius:var(--batshit-radius-lg);background:linear-gradient(180deg,color-mix(in oklab,var(--batshit-surface-elevated) 86%,var(--batshit-primary) 14%),color-mix(in oklab,var(--batshit-surface) 92%,var(--batshit-primary) 8%));box-shadow:0 10px 26px oklch(0 0 0 / .2);max-width:100%;overflow:hidden;}',
        '.batshit-builder-surface{border-color:var(--batshit-border-subtle);background:color-mix(in oklab,var(--batshit-surface) 86%,var(--batshit-primary) 14%);}',
        '.batshit-builder-field{display:grid;gap:7px;max-width:100%;}',
        '.batshit-builder-label{font:600 12px/1.25 var(--batshit-font);color:var(--batshit-text-strong);letter-spacing:0;}',
        '.batshit-builder-hint{font:400 11px/1.35 var(--batshit-font);color:var(--batshit-muted);}',
        '.batshit-builder-input,.batshit-builder-textarea,.batshit-builder-select,.batshit-builder-number,.batshit-builder-slider{width:100%;max-width:100%;box-sizing:border-box;border:1px solid var(--batshit-field-border);border-radius:var(--batshit-radius);background-color:var(--batshit-field);color:var(--batshit-text);padding:10px 12px;font:450 13px/1.4 var(--batshit-font);letter-spacing:0;outline:none;accent-color:var(--batshit-primary);transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease;}',
        '.batshit-builder-input,.batshit-builder-select,.batshit-builder-number{min-height:40px;}',
        '.batshit-builder-select{-webkit-appearance:none;appearance:none;padding-right:38px;color-scheme:dark;background-image:linear-gradient(45deg,transparent 50%,var(--batshit-select-arrow) 50%),linear-gradient(135deg,var(--batshit-select-arrow) 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;}',
        '.batshit-builder-select[multiple]{min-height:96px;padding-right:12px;background-image:none;}',
        '.batshit-builder-select option,.batshit-builder-select optgroup{min-height:32px;padding:8px 12px;background:oklch(0.14 0.018 281);color:var(--batshit-text);}',
        '.batshit-builder-select option:checked{background:color-mix(in oklab,var(--batshit-primary) 45%,oklch(0.14 0.018 281));color:var(--batshit-text-strong);}',
        '.batshit-builder-input:hover,.batshit-builder-textarea:hover,.batshit-builder-select:hover,.batshit-builder-number:hover,.batshit-builder-slider:hover{border-color:var(--batshit-field-border-hover);background:var(--batshit-field-hover);}',
        '.batshit-builder-input:focus,.batshit-builder-textarea:focus,.batshit-builder-select:focus,.batshit-builder-number:focus,.batshit-builder-slider:focus{border-color:var(--batshit-primary-hover);box-shadow:0 0 0 2px var(--batshit-field-focus-ring);background:var(--batshit-field-hover);}',
        '.batshit-builder-textarea{min-height:96px;resize:vertical;}',
        '.batshit-builder-checkbox-row{display:flex;align-items:center;gap:8px;font:500 12px/1.3 var(--batshit-font);color:var(--batshit-text);}',
        '.batshit-builder-checkbox-row input{accent-color:var(--batshit-primary);}',
        '.batshit-builder-radio-group{display:grid;gap:8px;padding:8px;border:1px dashed var(--batshit-border-subtle);border-radius:var(--batshit-radius);}',
        '.batshit-builder-radio-group input{accent-color:var(--batshit-primary);}',
        '.batshit-builder-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.batshit-builder-button{min-height:34px;border:1px solid color-mix(in oklab,var(--batshit-primary) 30%,var(--batshit-border));background:color-mix(in oklab,var(--batshit-surface-elevated) 86%,var(--batshit-primary) 14%);color:var(--batshit-text-strong);border-radius:var(--batshit-radius);padding:0 13px;font:650 12px/1 var(--batshit-font);cursor:pointer;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease,color .12s ease;}',
        '.batshit-builder-button:hover{border-color:var(--batshit-primary-hover);background:color-mix(in oklab,var(--batshit-primary) 24%,var(--batshit-surface-elevated));box-shadow:0 0 0 1px color-mix(in oklab,var(--batshit-primary) 18%, transparent);}',
        '.batshit-builder-button:disabled{opacity:.6;cursor:not-allowed;transform:none;}',
        '.batshit-builder-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0 0;}',
        '.batshit-builder-action-button--share,.batshit-builder-action-button--save,.batshit-builder-action-button--download{border-color:color-mix(in oklab,var(--batshit-primary) 34%, var(--batshit-border));background:color-mix(in oklab,var(--batshit-surface-elevated) 90%,var(--batshit-primary) 10%);}',
        '.batshit-builder-drop-zone{display:grid;place-items:center;text-align:center;padding:18px;border:1px dashed var(--batshit-field-border);border-radius:var(--batshit-radius);background:var(--batshit-field);color:var(--batshit-muted);transition:border-color .15s ease, background-color .15s ease;min-height:90px;}',
        '.batshit-builder-drop-zone.is-drag-over{border-color:var(--batshit-primary-hover);background:var(--batshit-accent-faint);color:var(--batshit-text);}',
        '.batshit-builder-output{max-width:100%;overflow:auto;border:1px solid var(--batshit-border-subtle);border-radius:var(--batshit-radius);background:var(--batshit-field);padding:10px;color:var(--batshit-text);font:500 13px/1.45 var(--batshit-font);}',
        '.batshit-builder-output pre{margin:0;white-space:pre-wrap;word-break:break-word;font:500 12px/1.45 var(--batshit-font-mono);}',
        '.batshit-builder-status{display:grid;gap:4px;padding:10px;border-radius:var(--batshit-radius);border:1px solid var(--batshit-border-subtle);}',
        '.batshit-builder-status[data-kind=\"success\"]{border-color:color-mix(in oklab,var(--batshit-success) 40%, var(--batshit-border));background:color-mix(in oklab,var(--batshit-success) 12%, transparent);}',
        '.batshit-builder-status[data-kind=\"warning\"]{border-color:color-mix(in oklab,var(--batshit-warning) 45%, var(--batshit-border));background:color-mix(in oklab,var(--batshit-warning) 12%, transparent);}',
        '.batshit-builder-status[data-kind=\"error\"]{border-color:color-mix(in oklab,var(--batshit-danger) 45%, var(--batshit-border));background:color-mix(in oklab,var(--batshit-danger) 12%, transparent);}',
        '.batshit-builder-table{width:100%;border-collapse:collapse;font:500 12px/1.35 var(--batshit-font);}',
        '.batshit-builder-table th,.batshit-builder-table td{padding:7px 8px;border-bottom:1px solid var(--batshit-border-subtle);text-align:left;vertical-align:top;word-break:break-word;}'
      ].join('\\n');
      document.head.appendChild(style);
    }

    function asBuilderComponent(shell, extras = {}) {
      if (!shell) return shell;
      try {
        Object.defineProperty(shell, 'shell', {
          value: shell,
          configurable: true
        });
      } catch (_) {
        shell.shell = shell;
      }
      if (extras && typeof extras === 'object') {
        Object.keys(extras).forEach((key) => {
          shell[key] = extras[key];
        });
      }
      return shell;
    }

    function emitChange(callback, value, event) {
      if (typeof callback === 'function') callback(value, event);
    }

    function createFieldShell(options = {}) {
      ensureStyles();
      const root = document.createElement('div');
      root.className = FIELD_CLASS;
      const labelText = trimString(options.label);
      if (labelText) {
        const label = document.createElement('label');
        label.className = 'batshit-builder-label';
        label.textContent = labelText;
        root.appendChild(label);
      }
      const hintText = trimString(options.hint);
      return {
        root,
        addHint() {
          if (!hintText) return;
          const hint = document.createElement('div');
          hint.className = 'batshit-builder-hint';
          hint.textContent = hintText;
          root.appendChild(hint);
        }
      };
    }

    function createRoot(options = {}) {
      ensureStyles();
      const root = document.createElement('div');
      root.className = 'batshit-builder-root';
      if (options.id) root.id = asString(options.id);
      if (options.className) root.className += ' ' + asString(options.className);
      return asBuilderComponent(root);
    }

    function createInputBase(type, options = {}) {
      const shell = createFieldShell(options);
      const input = document.createElement('input');
      input.type = type;
      input.className = type === 'range' ? 'batshit-builder-slider' : type === 'number' ? 'batshit-builder-number' : 'batshit-builder-input';
      const value = options.value ?? options.defaultValue ?? '';
      if (type === 'checkbox') {
        input.checked = asBoolean(value, false);
      } else if (value !== null && value !== undefined) {
        input.value = String(value);
      }
      if (options.placeholder) input.placeholder = asString(options.placeholder);
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      if (options.step !== undefined) input.step = String(options.step);
      if (options.disabled === true) input.disabled = true;
      if (options.name) input.name = asString(options.name);
      if (options.id) input.id = asString(options.id);
      if (options.fabricId) {
        input.dataset.fabricId = asString(options.fabricId);
        registerFabricField(options.fabricId, type === 'range' ? 'slider' : type, trimString(options.label), {
          min: options.min, max: options.max, step: options.step
        });
        registerFabricSetter(options.fabricId, function(val) {
          if (type === 'checkbox') { input.checked = asBoolean(val, false); }
          else { input.value = String(val); }
          emitChange(options.onChange, type === 'checkbox' ? input.checked : input.value, null);
        });
      }
      input.addEventListener('input', (event) => {
        const next = type === 'checkbox' ? input.checked : input.value;
        emitChange(options.onChange, next, event);
      });
      shell.root.appendChild(input);
      shell.addHint();
      return asBuilderComponent(shell.root, { input });
    }

    function normalizeOptions(options = {}) {
      return toArray(options.options).map((item) => {
        if (typeof item === 'string') return { label: item, value: item };
        const value = item && item.value !== undefined ? item.value : '';
        return {
          label: item && item.label !== undefined ? String(item.label) : String(value),
          value: String(value)
        };
      });
    }

    // SA-042: Fabric field registration helpers (registry lives on window.batshit)
    function registerFabricField(fabricId, type, label, options) {
      if (!fabricId || typeof fabricId !== 'string') return;
      var id = fabricId.trim();
      if (!id) return;
      window.batshit._fabricFields.push({
        fabricId: id,
        type: type,
        label: label || id,
        required: false,
        options: options && options.fieldOptions ? options.fieldOptions : null,
        min: options && options.min != null ? options.min : null,
        max: options && options.max != null ? options.max : null
      });
    }

    function registerFabricSetter(fabricId, setter) {
      if (!fabricId || typeof fabricId !== 'string') return;
      window.batshit._fabricSetters[fabricId.trim()] = setter;
    }

    // SA-042: Listen for batshit:set-fields messages from parent (agent field injection)
    window.addEventListener('message', function(event) {
      if (!event.data || event.data.type !== 'batshit:set-fields') return;
      var fields = event.data.fields;
      if (!fields || typeof fields !== 'object') return;
      var keys = Object.keys(fields);
      for (var i = 0; i < keys.length; i++) {
        var setter = window.batshit._fabricSetters[keys[i]];
        if (typeof setter === 'function') setter(fields[keys[i]]);
      }
    });

    // SA-042: Public API to read registered fabric fields
    window.batshit.getFabricFields = function() {
      return window.batshit._fabricFields.slice();
    };

    builder.createRoot = createRoot;
    builder.mount = function(target, child) {
      if (!target || !child) return null;
      const node = child && child.shell ? child.shell : child;
      if (!(node instanceof Node)) {
        throw new Error('builder.mount expected a DOM node or Builder Kit component.');
      }
      target.appendChild(node);
      return node;
    };

    builder.form = {
      text(options = {}) {
        return createInputBase('text', options);
      },
      textarea(options = {}) {
        const shell = createFieldShell(options);
        const textarea = document.createElement('textarea');
        textarea.className = 'batshit-builder-textarea';
        textarea.value = asString(options.value ?? options.defaultValue ?? '');
        if (options.placeholder) textarea.placeholder = asString(options.placeholder);
        if (options.disabled === true) textarea.disabled = true;
        textarea.addEventListener('input', (event) => emitChange(options.onChange, textarea.value, event));
        if (options.fabricId) {
          textarea.dataset.fabricId = asString(options.fabricId);
          registerFabricField(options.fabricId, 'textarea', trimString(options.label));
          registerFabricSetter(options.fabricId, function(val) {
            textarea.value = asString(val);
            emitChange(options.onChange, textarea.value, null);
          });
        }
        shell.root.appendChild(textarea);
        shell.addHint();
        return asBuilderComponent(shell.root, { input: textarea });
      },
      select(options = {}) {
        const shell = createFieldShell(options);
        const select = document.createElement('select');
        select.className = 'batshit-builder-select';
        const rows = normalizeOptions(options);
        for (const row of rows) {
          const option = document.createElement('option');
          option.value = row.value;
          option.textContent = row.label;
          select.appendChild(option);
        }
        const initial = options.value ?? options.defaultValue;
        if (initial !== undefined && initial !== null) select.value = String(initial);
        select.addEventListener('change', (event) => emitChange(options.onChange, select.value, event));
        if (options.fabricId) {
          select.dataset.fabricId = asString(options.fabricId);
          var optionValues = normalizeOptions(options).map(function(r) { return r.value; });
          registerFabricField(options.fabricId, 'select', trimString(options.label), { fieldOptions: optionValues });
          registerFabricSetter(options.fabricId, function(val) {
            select.value = String(val);
            emitChange(options.onChange, select.value, null);
          });
        }
        shell.root.appendChild(select);
        shell.addHint();
        return asBuilderComponent(shell.root, { input: select });
      },
      multiselect(options = {}) {
        const shell = createFieldShell(options);
        const select = document.createElement('select');
        select.className = 'batshit-builder-select';
        select.multiple = true;
        const rows = normalizeOptions(options);
        for (const row of rows) {
          const option = document.createElement('option');
          option.value = row.value;
          option.textContent = row.label;
          select.appendChild(option);
        }
        const selectedValues = new Set(toArray(options.value ?? options.defaultValue).map((entry) => String(entry)));
        Array.from(select.options).forEach((option) => {
          option.selected = selectedValues.has(option.value);
        });
        select.addEventListener('change', (event) => {
          const values = Array.from(select.selectedOptions).map((option) => option.value);
          emitChange(options.onChange, values, event);
        });
        if (options.fabricId) {
          select.dataset.fabricId = asString(options.fabricId);
          var optionValues = normalizeOptions(options).map(function(r) { return r.value; });
          registerFabricField(options.fabricId, 'multiselect', trimString(options.label), { fieldOptions: optionValues });
          registerFabricSetter(options.fabricId, function(val) {
            var vals = toArray(val).map(function(v) { return String(v); });
            var valSet = new Set(vals);
            Array.from(select.options).forEach(function(opt) { opt.selected = valSet.has(opt.value); });
            var selected = Array.from(select.selectedOptions).map(function(opt) { return opt.value; });
            emitChange(options.onChange, selected, null);
          });
        }
        shell.root.appendChild(select);
        shell.addHint();
        return asBuilderComponent(shell.root, { input: select });
      },
      checkbox(options = {}) {
        const shell = createFieldShell(options);
        const row = document.createElement('label');
        row.className = 'batshit-builder-checkbox-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = asBoolean(options.value ?? options.defaultValue, false);
        input.addEventListener('change', (event) => emitChange(options.onChange, input.checked, event));
        if (options.fabricId) {
          input.dataset.fabricId = asString(options.fabricId);
          registerFabricField(options.fabricId, 'checkbox', trimString(options.label || options.text));
          registerFabricSetter(options.fabricId, function(val) {
            input.checked = asBoolean(val, false);
            emitChange(options.onChange, input.checked, null);
          });
        }
        row.appendChild(input);
        const text = document.createElement('span');
        text.textContent = asString(options.text || options.label || 'Enabled');
        row.appendChild(text);
        shell.root.appendChild(row);
        shell.addHint();
        return asBuilderComponent(shell.root, { input });
      },
      toggle(options = {}) {
        return this.checkbox(options);
      },
      radio(options = {}) {
        const shell = createFieldShell(options);
        const group = document.createElement('div');
        group.className = 'batshit-builder-radio-group';
        const name = asString(options.name || options.id || ('radio-' + Math.random().toString(36).slice(2)));
        const selected = options.value ?? options.defaultValue;
        const rows = normalizeOptions(options);
        for (const row of rows) {
          const label = document.createElement('label');
          label.className = 'batshit-builder-inline';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = name;
          input.value = row.value;
          input.checked = String(selected ?? '') === row.value;
          input.addEventListener('change', (event) => {
            if (input.checked) emitChange(options.onChange, input.value, event);
          });
          const text = document.createElement('span');
          text.textContent = row.label;
          label.appendChild(input);
          label.appendChild(text);
          group.appendChild(label);
        }
        if (options.fabricId) {
          group.dataset.fabricId = asString(options.fabricId);
          var optionValues = normalizeOptions(options).map(function(r) { return r.value; });
          registerFabricField(options.fabricId, 'radio', trimString(options.label), { fieldOptions: optionValues });
          registerFabricSetter(options.fabricId, function(val) {
            var radios = group.querySelectorAll('input[type=radio]');
            for (var i = 0; i < radios.length; i++) {
              radios[i].checked = radios[i].value === String(val);
              if (radios[i].checked) emitChange(options.onChange, radios[i].value, null);
            }
          });
        }
        shell.root.appendChild(group);
        shell.addHint();
        return asBuilderComponent(shell.root, { input: group });
      },
      slider(options = {}) {
        return createInputBase('range', options);
      },
      number(options = {}) {
        return createInputBase('number', options);
      },
      promptPair(options = {}) {
        const shell = createFieldShell(options);
        const root = document.createElement('div');
        root.className = 'batshit-builder-root';
        root.style.padding = '10px';
        const primary = this.textarea({
          label: asString(options.promptLabel || 'Prompt'),
          value: asString(options.prompt || options.value || '')
        });
        const secondary = this.textarea({
          label: asString(options.negativeLabel || 'Negative Prompt'),
          value: asString(options.negativePrompt || '')
        });
        const emitPair = (event) =>
          emitChange(options.onChange, { prompt: primary.input.value, negativePrompt: secondary.input.value }, event);
        primary.input.addEventListener('input', emitPair);
        secondary.input.addEventListener('input', emitPair);
        if (options.fabricId) {
          root.dataset.fabricId = asString(options.fabricId);
          registerFabricField(options.fabricId, 'promptPair', trimString(options.label));
          registerFabricSetter(options.fabricId, function(val) {
            if (typeof val === 'object' && val !== null) {
              if (val.prompt !== undefined) primary.input.value = asString(val.prompt);
              if (val.negativePrompt !== undefined) secondary.input.value = asString(val.negativePrompt);
            } else {
              primary.input.value = asString(val);
            }
            emitChange(options.onChange, { prompt: primary.input.value, negativePrompt: secondary.input.value }, null);
          });
        }
        root.appendChild(primary.shell);
        root.appendChild(secondary.shell);
        shell.root.appendChild(root);
        shell.addHint();
        return asBuilderComponent(shell.root, { input: { prompt: primary.input, negativePrompt: secondary.input } });
      },
      uploadButton(options = {}) {
        const shell = createFieldShell(options);
        const row = document.createElement('div');
        row.className = 'batshit-builder-inline';
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = asBoolean(options.multiple, false);
        input.style.display = 'none';
        if (options.accept) input.accept = asString(options.accept);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'batshit-builder-button';
        button.textContent = asString(options.buttonText || 'Upload File');
        button.addEventListener('click', () => input.click());
        input.addEventListener('change', (event) => emitChange(options.onChange, toArray(input.files), event));
        row.appendChild(button);
        row.appendChild(input);
        shell.root.appendChild(row);
        shell.addHint();
        return asBuilderComponent(shell.root, { input });
      },
      dropFile(options = {}) {
        const shell = createFieldShell(options);
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = asBoolean(options.multiple, false);
        input.style.display = 'none';
        if (options.accept) input.accept = asString(options.accept);

        const dropZone = document.createElement('div');
        dropZone.className = 'batshit-builder-drop-zone';
        dropZone.textContent = asString(options.text || 'Drop files here, or click to choose');
        dropZone.tabIndex = 0;
        dropZone.addEventListener('click', () => input.click());
        dropZone.addEventListener('dragover', (event) => {
          event.preventDefault();
          dropZone.classList.add('is-drag-over');
        });
        dropZone.addEventListener('dragleave', () => {
          dropZone.classList.remove('is-drag-over');
        });
        dropZone.addEventListener('drop', (event) => {
          event.preventDefault();
          dropZone.classList.remove('is-drag-over');
          const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
          emitChange(options.onChange, files, event);
        });
        input.addEventListener('change', (event) => emitChange(options.onChange, toArray(input.files), event));

        shell.root.appendChild(dropZone);
        if (options.showUploadButton === true) {
          const buttonRow = this.uploadButton({
            buttonText: options.buttonText || 'Choose file',
            accept: options.accept,
            multiple: options.multiple,
            onChange: options.onChange
          });
          shell.root.appendChild(buttonRow.shell);
        } else {
          shell.root.appendChild(input);
        }
        shell.addHint();
        return asBuilderComponent(shell.root, { input, dropZone });
      }
    };

    builder.output = {
      text(content, options = {}) {
        ensureStyles();
        const node = document.createElement('div');
        node.className = SURFACE_CLASS + ' batshit-builder-output';
        node.textContent = asString(content);
        if (options.className) node.className += ' ' + asString(options.className);
        return asBuilderComponent(node);
      },
      markdown(content, options = {}) {
        ensureStyles();
        const node = document.createElement('div');
        node.className = SURFACE_CLASS + ' batshit-builder-output';
        const escaped = asString(content)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
          .replace(/\\n/g, '<br>');
        node.innerHTML = escaped;
        if (options.className) node.className += ' ' + asString(options.className);
        return asBuilderComponent(node);
      },
      media(src, options = {}) {
        ensureStyles();
        const type = asString(options.type || 'image');
        const wrapper = document.createElement('div');
        wrapper.className = SURFACE_CLASS + ' batshit-builder-output';
        let element;
        if (type === 'video') {
          element = document.createElement('video');
          element.controls = true;
        } else if (type === 'audio') {
          element = document.createElement('audio');
          element.controls = true;
        } else {
          element = document.createElement('img');
          element.alt = asString(options.alt || 'artifact output');
        }
        element.src = asString(src);
        element.style.maxWidth = '100%';
        wrapper.appendChild(element);
        return asBuilderComponent(wrapper);
      },
      table(rows, options = {}) {
        ensureStyles();
        const wrapper = document.createElement('div');
        wrapper.className = SURFACE_CLASS + ' batshit-builder-output';
        const table = document.createElement('table');
        table.className = 'batshit-builder-table';
        const columns = toArray(options.columns).map((entry) => String(entry));
        const normalizedRows = toArray(rows).map((row) => row && typeof row === 'object' ? row : {});
        const keys = columns.length > 0 ? columns : Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        keys.forEach((key) => {
          const th = document.createElement('th');
          th.textContent = key;
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        normalizedRows.forEach((row) => {
          const tr = document.createElement('tr');
          keys.forEach((key) => {
            const td = document.createElement('td');
            const value = row[key];
            td.textContent = value === null || value === undefined ? '' : String(value);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        return asBuilderComponent(wrapper);
      },
      statusCard(options = {}) {
        ensureStyles();
        const card = document.createElement('div');
        card.className = SURFACE_CLASS + ' batshit-builder-status';
        card.dataset.kind = asString(options.kind || 'info');
        const title = document.createElement('div');
        title.className = 'batshit-builder-label';
        title.textContent = asString(options.title || 'Status');
        const body = document.createElement('div');
        body.className = 'batshit-builder-hint';
        body.textContent = asString(options.message || '');
        card.appendChild(title);
        card.appendChild(body);
        return asBuilderComponent(card);
      },
      resultCard(result, options = {}) {
        ensureStyles();
        const card = document.createElement('div');
        card.className = SURFACE_CLASS + ' batshit-builder-output';
        const title = document.createElement('div');
        title.className = 'batshit-builder-label';
        title.textContent = asString(options.title || 'Result');
        const pre = document.createElement('pre');
        pre.textContent = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2);
        card.appendChild(title);
        card.appendChild(pre);
        return asBuilderComponent(card);
      }
    };

    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    function normalizeSharePayload(payload, defaultTitle) {
      if (payload === undefined || payload === null) return null;
      if (typeof payload === 'string') {
        const text = payload.trim();
        if (!text) return null;
        return { title: defaultTitle, data: text };
      }

      const record = asObject(payload);
      if (!record) {
        return {
          title: defaultTitle,
          data: JSON.stringify(payload)
        };
      }

      if (
        typeof record.title === 'string' ||
        record.data !== undefined ||
        record.image !== undefined ||
        record.url !== undefined ||
        record.content !== undefined
      ) {
        if (typeof record.title !== 'string' || !record.title.trim()) {
          record.title = defaultTitle;
        }
        return record;
      }

      return {
        title: defaultTitle,
        data: JSON.stringify(record, null, 2)
      };
    }

    function extensionFromMimeType(mimeType) {
      const normalized = asString(mimeType).toLowerCase();
      if (!normalized) return 'txt';
      if (normalized.includes('json')) return 'json';
      if (normalized.includes('markdown')) return 'md';
      if (normalized.includes('png')) return 'png';
      if (normalized.includes('webp')) return 'webp';
      if (normalized.includes('gif')) return 'gif';
      if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
      if (normalized.includes('svg')) return 'svg';
      if (normalized.includes('pdf')) return 'pdf';
      if (normalized.includes('html')) return 'html';
      if (normalized.includes('csv')) return 'csv';
      if (normalized.includes('plain')) return 'txt';
      return 'txt';
    }

    function parseDataUrlMimeType(dataUrl) {
      if (typeof dataUrl !== 'string') return null;
      const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
      return match && match[1] ? match[1].toLowerCase() : null;
    }

    async function payloadToBlob(payload, fallbackMimeType) {
      if (payload instanceof Blob) {
        return {
          blob: payload,
          mimeType: payload.type || fallbackMimeType || 'application/octet-stream'
        };
      }

      if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('data:')) {
          const response = await fetch(trimmed);
          const blob = await response.blob();
          return {
            blob,
            mimeType: blob.type || parseDataUrlMimeType(trimmed) || fallbackMimeType || 'application/octet-stream'
          };
        }
        return {
          blob: new Blob([trimmed], { type: fallbackMimeType || 'text/plain' }),
          mimeType: fallbackMimeType || 'text/plain'
        };
      }

      const record = asObject(payload);
      if (record) {
        const possibleDataUrl = [record.dataUrl, record.image, record.url, record.data].find(
          (value) => typeof value === 'string' && value.trim().startsWith('data:')
        );
        if (possibleDataUrl) {
          const response = await fetch(possibleDataUrl);
          const blob = await response.blob();
          return {
            blob,
            mimeType:
              blob.type ||
              parseDataUrlMimeType(possibleDataUrl) ||
              fallbackMimeType ||
              'application/octet-stream'
          };
        }

        if (typeof record.text === 'string') {
          return {
            blob: new Blob([record.text], { type: fallbackMimeType || 'text/plain' }),
            mimeType: fallbackMimeType || 'text/plain'
          };
        }
      }

      return {
        blob: new Blob([JSON.stringify(payload ?? null, null, 2)], {
          type: fallbackMimeType || 'application/json'
        }),
        mimeType: fallbackMimeType || 'application/json'
      };
    }

    function resolveActionPayload(options, actionName) {
      if (!options || typeof options !== 'object') return null;

      const resolverName =
        actionName === 'download'
          ? 'getDownloadPayload'
          : actionName === 'save'
            ? 'getSavePayload'
            : 'getSharePayload';

      const resolver = options[resolverName];
      if (typeof resolver === 'function') {
        const result = resolver({ action: actionName });
        if (result !== undefined) return result;
      }

      if (typeof options.getPayload === 'function') {
        const fallbackResult = options.getPayload({ action: actionName });
        if (fallbackResult !== undefined) return fallbackResult;
      }

      if (actionName === 'download' && options.downloadPayload !== undefined) {
        return options.downloadPayload;
      }
      if (actionName === 'save' && options.savePayload !== undefined) {
        return options.savePayload;
      }
      if (actionName === 'share' && options.sharePayload !== undefined) {
        return options.sharePayload;
      }

      if (options.payload !== undefined) return options.payload;

      const storageKey = trimString(options.storageKey || 'lastResult');
      if (
        storageKey &&
        window.batshit.storage &&
        typeof window.batshit.storage.get === 'function'
      ) {
        const stored = window.batshit.storage.get(storageKey);
        if (stored !== undefined && stored !== null && stored !== '') {
          return stored;
        }
      }

      return null;
    }

    builder.action = {
      async run(options = {}) {
        const prompt = typeof options === 'string' ? options : options.prompt;
        if (!prompt || typeof prompt !== 'string') {
          throw new Error('builder.action.run requires a prompt string.');
        }
        const request = typeof options === 'object' ? { ...options } : {};
        delete request.prompt;
        return await window.batshit.complete(prompt, request);
      },
      async shareToChat(content, options = {}) {
        if (typeof window.batshit.shareToChat !== 'function') {
          throw new Error('shareToChat API is unavailable in this runtime.');
        }
        return await window.batshit.shareToChat(content, options);
      },
      async saveToClipVault(content, options = {}) {
        if (typeof window.batshit.saveToClipVault === 'function') {
          return await window.batshit.saveToClipVault(content, options);
        }
        if (typeof window.batshit.shareToChat !== 'function') {
          throw new Error('saveToClipVault API is unavailable in this runtime.');
        }
        return await window.batshit.shareToChat(content, {
          ...options,
          includeInChat: false
        });
      },
      async download(content, options = {}) {
        const fallbackMimeType = trimString(options.mimeType || '');
        const normalized = await payloadToBlob(content, fallbackMimeType || undefined);
        if (!normalized || !(normalized.blob instanceof Blob)) {
          throw new Error('builder.action.download requires content to download.');
        }

        const ext = extensionFromMimeType(normalized.mimeType);
        const baseName = sanitizeFilename(
          trimString(options.filenameBase || window.batshit.artifactName || 'artifact-output')
        );
        const filename = trimString(options.filename || '') || (baseName + '.' + ext);

        if (window.parent && window.parent !== window) {
          const requestId =
            'artifact-download-' +
            Date.now().toString(36) +
            '-' +
            Math.random().toString(36).slice(2);
          const parentResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              window.removeEventListener('message', onMessage);
              reject(new Error('Artifact download request timed out.'));
            }, 300000);
            function onMessage(event) {
              if (!event.data || event.data.type !== 'batshit:artifact:download-result') return;
              if (event.data.requestId !== requestId) return;
              window.removeEventListener('message', onMessage);
              clearTimeout(timeout);
              if (event.data.success) {
                resolve(event.data);
              } else {
                reject(new Error(event.data.error || 'Artifact download failed.'));
              }
            }
            window.addEventListener('message', onMessage);
            window.parent.postMessage(
              {
                type: 'batshit:artifact:download',
                artifactId: window.batshit.artifactId,
                requestId,
                filename,
                mimeType: normalized.mimeType,
                blob: normalized.blob
              },
              '*'
            );
          });
          return {
            success: true,
            filename,
            mimeType: normalized.mimeType,
            canceled: Boolean(parentResult && parentResult.canceled)
          };
        }

        const href = URL.createObjectURL(normalized.blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(href), 0);
        return {
          success: true,
          filename,
          mimeType: normalized.mimeType,
          size: normalized.blob.size
        };
      },
      standardControls(options = {}) {
        ensureStyles();
        const shell = document.createElement('div');
        shell.className = SURFACE_CLASS + ' batshit-builder-actions';

        const includeShare = options.share !== false;
        const includeSave = options.save !== false;
        const includeDownload = options.download !== false;
        const statusCallback = typeof options.onStatus === 'function' ? options.onStatus : null;
        const defaultTitle = trimString(options.title || window.batshit.artifactName || 'Artifact Result');

        function notify(message, kind) {
          if (statusCallback) {
            statusCallback(message, kind || 'info');
            return;
          }
          if (typeof window.batshit.showToast === 'function') {
            window.batshit.showToast(message, kind || 'info');
          }
        }

        function createButton(label, modifierClass) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className =
            'batshit-builder-button batshit-builder-action-button ' + modifierClass;
          button.textContent = label;
          shell.appendChild(button);
          return button;
        }

        async function withBusy(button, busyLabel, work) {
          const originalLabel = button.textContent || '';
          button.disabled = true;
          button.textContent = busyLabel;
          try {
            return await work();
          } finally {
            button.disabled = false;
            button.textContent = originalLabel;
          }
        }

        const buttons = {
          shareToChat: null,
          saveToClipVault: null,
          download: null
        };

        const getShareOptions = (includeInChat) => {
          const base = asObject(options.shareOptions) ? { ...options.shareOptions } : {};
          if (!base.type) base.type = 'data';
          if (!base.initiator) base.initiator = trimString(options.initiator || 'user');
          base.includeInChat = includeInChat;
          return base;
        };

        if (includeShare) {
          const shareButton = createButton('Share to Chat', 'batshit-builder-action-button--share');
          buttons.shareToChat = shareButton;
          shareButton.onclick = () =>
            withBusy(shareButton, 'Sharing...', async () => {
              const payload = resolveActionPayload(options, 'share');
              const content = normalizeSharePayload(payload, defaultTitle);
              if (!content) {
                throw new Error('Nothing to share yet.');
              }
              await builder.action.shareToChat(content, getShareOptions(true));
              notify('Shared to chat', 'success');
            }).catch((err) => {
              notify(err?.message || 'Share failed', 'error');
            });
        }

        if (includeSave) {
          const saveButton = createButton('Save to Clip Vault', 'batshit-builder-action-button--save');
          buttons.saveToClipVault = saveButton;
          saveButton.onclick = () =>
            withBusy(saveButton, 'Saving...', async () => {
              const payload = resolveActionPayload(options, 'save');
              const content = normalizeSharePayload(payload, defaultTitle);
              if (!content) {
                throw new Error('Nothing to save yet.');
              }
              await builder.action.saveToClipVault(content, getShareOptions(false));
              notify('Saved to Clip Vault', 'success');
            }).catch((err) => {
              notify(err?.message || 'Save failed', 'error');
            });
        }

        if (includeDownload) {
          const downloadButton = createButton('Download', 'batshit-builder-action-button--download');
          buttons.download = downloadButton;
          downloadButton.onclick = () =>
            withBusy(downloadButton, 'Preparing...', async () => {
              const payload = resolveActionPayload(options, 'download');
              if (payload === undefined || payload === null || payload === '') {
                throw new Error('Nothing to download yet.');
              }
              const downloadOptions = asObject(options.downloadOptions) ? { ...options.downloadOptions } : {};
              if (!downloadOptions.filenameBase && !downloadOptions.filename) {
                downloadOptions.filenameBase = trimString(
                  options.downloadFileBase || window.batshit.artifactName || 'artifact-output'
                );
              }
              const downloadResult = await builder.action.download(payload, downloadOptions);
              if (downloadResult && downloadResult.canceled) {
                notify('Download canceled', 'info');
              } else {
                notify('Download ready', 'success');
              }
            }).catch((err) => {
              notify(err?.message || 'Download failed', 'error');
            });
        }

        return asBuilderComponent(shell, { buttons });
      },
      reset(options = {}) {
        const fields = toArray(options.fields);
        fields.forEach((field) => {
          if (!field) return;
          if (typeof field.setValue === 'function') {
            field.setValue(field.defaultValue ?? '');
            return;
          }
          const target = field.input || field;
          if (!target) return;
          if ('value' in target) target.value = '';
          if ('checked' in target) target.checked = false;
        });
        const root = options.root;
        if (root && typeof root.querySelectorAll === 'function') {
          root.querySelectorAll('input,textarea,select').forEach((element) => {
            if (element instanceof HTMLInputElement) {
              if (element.type === 'checkbox' || element.type === 'radio') {
                element.checked = false;
              } else {
                element.value = '';
              }
            } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
              element.value = '';
            }
          });
        }
        return { success: true };
      },
      async publishStatus() {
        const response = await window.batshit._fetch('/api/artifacts/' + encodeURIComponent(window.batshit.artifactId));
        if (!response.ok) {
          throw new Error('Failed to load artifact publish status.');
        }
        const artifact = await response.json();
        const compatibility = artifact && typeof artifact === 'object' ? artifact.zone_compatibility : null;
        const zone = artifact && typeof artifact === 'object' ? artifact.zone : null;
        const compatibleZones = Array.isArray(compatibility?.compatibleZones)
          ? compatibility.compatibleZones
          : Array.isArray(compatibility?.compatible_zones)
            ? compatibility.compatible_zones
            : ['header', 'panel', 'trigger'];
        const fitReport = compatibility && typeof compatibility === 'object' ? compatibility.fitReport || compatibility.fit_report || {} : {};
        let publishReady = true;
        let reason = null;
        if (!zone) {
          publishReady = false;
          reason = 'Publish requires a zone selection.';
        } else if (!compatibleZones.includes(zone)) {
          publishReady = false;
          reason = "Current zone is outside this artifact's compatibility list.";
        } else if (fitReport && fitReport[zone] && fitReport[zone].status === 'blocked') {
          publishReady = false;
          reason = fitReport[zone].note || 'Current zone is blocked by fit rules.';
        }
        return {
          artifactId: window.batshit.artifactId,
          mode: artifact?.mode || null,
          zone,
          zoneCompatibility: compatibility || null,
          publishReady,
          reason,
          recommendedZones: compatibleZones
        };
      }
    };
  })(window.batshit.builder);
`;
}

/**
 * Escape a string for safe injection into JavaScript code.
 */
function escapeForJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Inject the Batshit API into artifact HTML content.
 *
 * @param html - Original artifact HTML content
 * @param config - API configuration
 * @returns Enhanced HTML with injected API
 */
export function injectArtifactApi(html: string, config: ArtifactApiConfig): string {
  const apiScript = generateArtifactApiScript(config);

  // Normalize JSON-escaped closing tags: AI models often output <\/script> (valid in
  // JSON/JS strings but NOT valid HTML). The backslash prevents the HTML parser from
  // recognizing the closing tag, so the script block never ends and code never executes.
  // Also handle <\/style> for the same reason.
  let normalized = html.replace(/<\\\/script>/gi, '</script>');
  normalized = normalized.replace(/<\\\/style>/gi, '</style>');

  // Inject CSS variables into <head> and API script before </head> or </body>
  if (normalized.includes('</head>')) {
    // Best case: inject CSS at start of head, API script at end
    let result = normalized.replace('</head>', apiScript + '</head>');
    // If there's a <head> tag, inject CSS right after it
    if (result.includes('<head>')) {
      result = result.replace('<head>', '<head>' + BATSHIT_THEME_CSS);
    } else {
      // Fallback: prepend CSS before the script
      result = result.replace(apiScript, BATSHIT_THEME_CSS + apiScript);
    }
    return result;
  } else if (normalized.includes('</body>')) {
    return normalized.replace('</body>', BATSHIT_THEME_CSS + apiScript + '</body>');
  }

  return BATSHIT_THEME_CSS + normalized + apiScript;
}
