import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';

export const CUSTOM_CSS_WATCH_INTERVAL_MS = 400;
export const MAX_CUSTOM_CSS_BYTES = 4 * 1024 * 1024;
export const MAX_STYLE_IMPORTS = 10;
export const MAX_IMPORTED_CSS_BYTES = 512 * 1024;
export const STYLE_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Hosts whose stylesheets may be inlined into the custom stylesheet. Chromium
 * ignores @import inside an injected stylesheet, so the rule is fetched here and
 * spliced in; the resulting @font-face rules are then fetched by the renderer as
 * on any normal page. Keeping this to font services bounds what a local file can
 * make the main process request.
 */
export const ALLOWED_STYLE_IMPORT_HOSTS = Object.freeze([
  'fonts.googleapis.com',
  'fonts.bunny.net'
]);

/**
 * Google Fonts serves a different stylesheet per user agent. Electron's own
 * agent would be given older formats, so ask as a current Chrome to receive
 * woff2.
 */
export const STYLE_IMPORT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const IMPORT_PATTERN = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;?/gi;

/**
 * Byte ranges covered by CSS comments, including one left unterminated.
 *
 * Commenting a block out is how a stylesheet is disabled, so an @import inside
 * a comment is inert and must stay that way. Scanning raw text without this
 * would fetch it and splice real rules into the middle of the comment, and
 * because a fetched stylesheet contains its own comments the first `*​/` would
 * close the enclosing one early and bring the disabled rules back to life.
 */
export function cssCommentRanges(css) {
  const ranges = [];
  if (typeof css !== 'string') return ranges;
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf('/*', index);
    if (start === -1) break;
    const end = css.indexOf('*/', start + 2);
    if (end === -1) {
      ranges.push([start, css.length]);
      break;
    }
    ranges.push([start, end + 2]);
    index = end + 2;
  }
  return ranges;
}

function isCommented(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

export function collectStyleImports(css, { allowedHosts = ALLOWED_STYLE_IMPORT_HOSTS } = {}) {
  const allowed = [];
  const rejected = [];
  if (typeof css !== 'string') return { allowed, rejected };
  const comments = cssCommentRanges(css);

  for (const match of css.matchAll(IMPORT_PATTERN)) {
    if (isCommented(comments, match.index)) continue;
    const raw = match[0];
    const span = { start: match.index, end: match.index + raw.length };
    const url = (match[2] ?? match[4] ?? '').trim();
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      rejected.push({ raw, url, reason: 'not an absolute URL', ...span });
      continue;
    }
    if (parsed.protocol !== 'https:') {
      rejected.push({ raw, url, reason: 'only https imports are fetched', ...span });
    } else if (!allowedHosts.includes(parsed.hostname)) {
      rejected.push({ raw, url, reason: `host is not one of ${allowedHosts.join(', ')}`, ...span });
    } else if (allowed.length >= MAX_STYLE_IMPORTS) {
      rejected.push({ raw, url, reason: `more than ${MAX_STYLE_IMPORTS} imports`, ...span });
    } else {
      allowed.push({ raw, url: parsed.toString(), ...span });
    }
  }
  return { allowed, rejected };
}

export async function fetchStyleImport(
  url,
  { fetchImpl = fetch, timeoutMs = STYLE_IMPORT_TIMEOUT_MS, maxBytes = MAX_IMPORTED_CSS_BYTES } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': STYLE_IMPORT_USER_AGENT, Accept: 'text/css,*/*;q=0.1' }
    });
    if (!response.ok) throw new Error(`responded ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`stylesheet is larger than ${maxBytes} bytes`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replace each allowed @import with the stylesheet it points at.
 *
 * Chromium ignores @import inside a stylesheet inserted through insertCSS, so a
 * Google Fonts one-liner would apply its font-family and then silently fall back
 * to a system face. Splicing the imported rules in leaves plain @font-face rules
 * that the renderer fetches normally. A failed or disallowed import is reported
 * and leaves a comment in place of the rule, never a silent partial stylesheet.
 */
export async function inlineStyleImports(
  css,
  { fetchCss = fetchStyleImport, allowedHosts = ALLOWED_STYLE_IMPORT_HOSTS, cache = new Map(), onError = () => {} } = {}
) {
  if (typeof css !== 'string' || !css.includes('@import')) return css;
  const { allowed, rejected } = collectStyleImports(css, { allowedHosts });
  if (!allowed.length && !rejected.length) return css;

  const replacements = [];
  for (const item of rejected) {
    onError(new Error(`Custom CSS import was not fetched (${item.reason}): ${item.url || item.raw}`));
    replacements.push({ ...item, text: `/* Batshit: import not fetched (${item.reason}) */` });
  }

  for (const item of allowed) {
    if (!cache.has(item.url)) {
      try {
        cache.set(item.url, await fetchCss(item.url));
      } catch (error) {
        onError(new Error(`Custom CSS import failed for ${item.url}: ${error.message}`));
        cache.set(item.url, null);
      }
    }
    const imported = cache.get(item.url);
    replacements.push({
      ...item,
      text: imported ?? `/* Batshit: import failed for ${item.url} */`
    });
  }

  // Splice by position, from the end, so earlier offsets stay valid and an
  // identical @import sitting inside a comment is never touched.
  replacements.sort((a, b) => b.start - a.start);
  let result = css;
  for (const item of replacements) {
    result = result.slice(0, item.start) + item.text + result.slice(item.end);
  }
  return result;
}

/**
 * Read the local custom stylesheet, or null when the user has not created one.
 * A missing file is the normal state and is never an error; an unreadable or
 * oversized file is surfaced rather than silently ignored.
 */
export function readCustomCss(
  cssPath,
  { fileExists = existsSync, readText = readFileSync, statFile = statSync } = {}
) {
  if (typeof cssPath !== 'string' || !cssPath) return null;
  if (!fileExists(cssPath)) return null;
  const stats = statFile(cssPath);
  if (!stats.isFile()) {
    throw new Error(`Custom CSS path ${cssPath} is not a regular file.`);
  }
  if (stats.size > MAX_CUSTOM_CSS_BYTES) {
    throw new Error(
      `Custom CSS at ${cssPath} is ${stats.size} bytes, over the ${MAX_CUSTOM_CSS_BYTES} byte limit.`
    );
  }
  const text = readText(cssPath, 'utf8');
  return typeof text === 'string' ? text : null;
}

/**
 * Context menu shown only when developer tools are enabled for this install.
 * Returns plain descriptors so the template stays testable without Electron;
 * the caller binds each id to a real action.
 */
export function buildDeveloperContextMenuTemplate({ canInspect = false, hasCustomCss = false } = {}) {
  const template = [];
  if (canInspect) template.push({ id: 'inspect', label: 'Inspect Element' });
  if (canInspect) template.push({ type: 'separator' });
  template.push({ id: 'reload', label: 'Reload' });
  if (hasCustomCss) template.push({ id: 'reapply-css', label: 'Reapply Custom CSS' });
  return template;
}

/**
 * Keeps one webContents in sync with the local custom stylesheet.
 *
 * The stylesheet is re-read on every document load and whenever the file
 * changes on disk, so editing and saving is enough; a reload is never
 * required. Electron drops inserted CSS on navigation, so the previous key is
 * abandoned at that point rather than removed.
 */
export class CustomStyleOverrides {
  constructor({
    webContents,
    cssPath,
    readCss = readCustomCss,
    watch = watchFile,
    unwatch = unwatchFile,
    interval = CUSTOM_CSS_WATCH_INTERVAL_MS,
    inlineImports = inlineStyleImports,
    onError = () => {}
  }) {
    this.webContents = webContents;
    this.cssPath = cssPath;
    this.readCss = readCss;
    this.watch = watch;
    this.unwatch = unwatch;
    this.interval = interval;
    this.onError = onError;
    this.inlineImports = inlineImports;
    this.importCache = new Map();
    this.insertedKey = null;
    this.watching = false;
  }

  hasCustomCss() {
    try {
      return typeof this.readCss(this.cssPath) === 'string';
    } catch {
      return false;
    }
  }

  /** Electron discards inserted CSS across navigations; forget the stale key. */
  handleNavigated() {
    this.insertedKey = null;
  }

  async apply() {
    if (!this.webContents || this.webContents.isDestroyed?.()) return false;
    let css;
    try {
      css = this.readCss(this.cssPath);
    } catch (error) {
      this.onError(error);
      return false;
    }
    if (this.insertedKey) {
      try {
        await this.webContents.removeInsertedCSS(this.insertedKey);
      } catch {
        // The key is already gone after a reload; inserting fresh CSS is still correct.
      }
      this.insertedKey = null;
    }
    if (css === null || css.trim() === '') return false;
    try {
      css = await this.inlineImports(css, {
        cache: this.importCache,
        onError: this.onError
      });
    } catch (error) {
      this.onError(error);
    }
    try {
      // Author origin, appended after the app's own stylesheets: ordinary cascade
      // rules apply, so anything written here transfers into app.css unchanged.
      // A user-origin sheet would need !important on every rule to take effect.
      this.insertedKey = await this.webContents.insertCSS(css);
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  start() {
    if (this.watching || !this.cssPath) return;
    this.watching = true;
    this.watch(this.cssPath, { interval: this.interval }, () => {
      void this.apply();
    });
  }

  stop() {
    if (!this.watching) return;
    this.watching = false;
    this.unwatch(this.cssPath);
  }
}
