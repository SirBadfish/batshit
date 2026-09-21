import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CustomStyleOverrides,
  MAX_CUSTOM_CSS_BYTES,
  buildDeveloperContextMenuTemplate,
  collectStyleImports,
  cssCommentRanges,
  fetchStyleImport,
  inlineStyleImports,
  readCustomCss
} from './local-style-overrides.mjs';

function fakeWebContents() {
  const calls = { inserted: [], removed: [] };
  let nextKey = 0;
  return {
    calls,
    isDestroyed: () => false,
    async insertCSS(css, options) {
      calls.inserted.push({ css, options });
      nextKey += 1;
      return `key-${nextKey}`;
    },
    async removeInsertedCSS(key) {
      calls.removed.push(key);
    }
  };
}

const CSS_PATH = '/data/custom.css';

function deps(css, { size = null } = {}) {
  return {
    fileExists: (path) => path === CSS_PATH && css !== null,
    readText: () => css,
    statFile: () => ({ isFile: () => true, size: size ?? Buffer.byteLength(css ?? '', 'utf8') })
  };
}

test('a missing custom stylesheet is the normal state, not an error', () => {
  assert.equal(readCustomCss(CSS_PATH, deps(null)), null);
  assert.equal(readCustomCss('', deps('body {}')), null);
  assert.equal(readCustomCss(CSS_PATH, deps('body { color: red; }')), 'body { color: red; }');
});

test('an unusable custom stylesheet is surfaced instead of silently skipped', () => {
  assert.throws(
    () => readCustomCss(CSS_PATH, { ...deps('x'), statFile: () => ({ isFile: () => false, size: 1 }) }),
    /not a regular file/
  );
  assert.throws(
    () => readCustomCss(CSS_PATH, deps('x', { size: MAX_CUSTOM_CSS_BYTES + 1 })),
    /over the .* byte limit/
  );
});

test('the developer context menu offers inspect and reload only where they apply', () => {
  const full = buildDeveloperContextMenuTemplate({ canInspect: true, hasCustomCss: true });
  assert.deepEqual(
    full.map((item) => item.id ?? item.type),
    ['inspect', 'separator', 'reload', 'reapply-css']
  );

  const noCss = buildDeveloperContextMenuTemplate({ canInspect: true, hasCustomCss: false });
  assert.deepEqual(noCss.map((item) => item.id ?? item.type), ['inspect', 'separator', 'reload']);

  const noInspect = buildDeveloperContextMenuTemplate({ canInspect: false, hasCustomCss: false });
  assert.deepEqual(noInspect.map((item) => item.id ?? item.type), ['reload']);
});

test('custom CSS is appended after the app stylesheets and replaced in place on the next apply', async () => {
  const webContents = fakeWebContents();
  let css = 'body { color: red; }';
  const overrides = new CustomStyleOverrides({
    webContents,
    cssPath: CSS_PATH,
    readCss: () => css,
    watch: () => {},
    unwatch: () => {}
  });

  assert.equal(await overrides.apply(), true);
  assert.equal(webContents.calls.inserted[0].css, 'body { color: red; }');
  assert.equal(
    webContents.calls.inserted[0].options,
    undefined,
    'author origin keeps the cascade ordinary so rules port into app.css unchanged'
  );
  assert.deepEqual(webContents.calls.removed, []);

  css = 'body { color: blue; }';
  assert.equal(await overrides.apply(), true);
  assert.deepEqual(webContents.calls.removed, ['key-1'], 'the previous stylesheet must be removed first');
  assert.equal(webContents.calls.inserted[1].css, 'body { color: blue; }');
});

test('a reload abandons the stale key instead of removing it from the new document', async () => {
  const webContents = fakeWebContents();
  const overrides = new CustomStyleOverrides({
    webContents,
    cssPath: CSS_PATH,
    readCss: () => 'body { color: red; }',
    watch: () => {},
    unwatch: () => {}
  });

  await overrides.apply();
  overrides.handleNavigated();
  await overrides.apply();
  assert.deepEqual(webContents.calls.removed, [], 'no removal should target the previous document');
  assert.equal(webContents.calls.inserted.length, 2);
});

test('an empty or unreadable stylesheet clears styling and reports the real failure', async () => {
  const webContents = fakeWebContents();
  const overrides = new CustomStyleOverrides({
    webContents,
    cssPath: CSS_PATH,
    readCss: () => '   ',
    watch: () => {},
    unwatch: () => {}
  });
  assert.equal(await overrides.apply(), false);
  assert.deepEqual(webContents.calls.inserted, []);

  const errors = [];
  const failing = new CustomStyleOverrides({
    webContents: fakeWebContents(),
    cssPath: CSS_PATH,
    readCss: () => {
      throw new Error('disk on fire');
    },
    watch: () => {},
    unwatch: () => {},
    onError: (error) => errors.push(error.message)
  });
  assert.equal(await failing.apply(), false);
  assert.deepEqual(errors, ['disk on fire']);
  assert.equal(failing.hasCustomCss(), false);
});

test('the stylesheet watcher is started once and released with the window', () => {
  const watched = [];
  const unwatched = [];
  const overrides = new CustomStyleOverrides({
    webContents: fakeWebContents(),
    cssPath: CSS_PATH,
    readCss: () => null,
    watch: (path) => watched.push(path),
    unwatch: (path) => unwatched.push(path)
  });

  overrides.start();
  overrides.start();
  assert.deepEqual(watched, [CSS_PATH], 'watching twice would double every re-apply');

  overrides.stop();
  overrides.stop();
  assert.deepEqual(unwatched, [CSS_PATH]);
});

test('only https font-service imports are collected; everything else is rejected with a reason', () => {
  const css = [
    "@import url('https://fonts.googleapis.com/css2?family=Lobster&display=swap');",
    '@import url(https://fonts.bunny.net/css?family=inter);',
    '@import "https://fonts.googleapis.com/css2?family=Inter";',
    "@import url('http://fonts.googleapis.com/css2?family=Insecure');",
    "@import url('https://evil.example.com/tracker.css');",
    "@import url('theme.css');"
  ].join('\n');

  const { allowed, rejected } = collectStyleImports(css);
  assert.deepEqual(
    allowed.map((item) => new URL(item.url).hostname),
    ['fonts.googleapis.com', 'fonts.bunny.net', 'fonts.googleapis.com']
  );
  assert.deepEqual(
    rejected.map((item) => item.reason),
    ['only https imports are fetched', 'host is not one of fonts.googleapis.com, fonts.bunny.net', 'not an absolute URL']
  );
});

test('an allowed import is replaced by the stylesheet it points at, and fetched once', async () => {
  const fetched = [];
  const css = "@import url('https://fonts.googleapis.com/css2?family=Lobster');\nbody { font-family: Lobster; }";
  const cache = new Map();
  const options = {
    cache,
    fetchCss: async (url) => {
      fetched.push(url);
      return '@font-face { font-family: Lobster; src: url(https://fonts.gstatic.com/l.woff2); }';
    }
  };

  const first = await inlineStyleImports(css, options);
  assert.match(first, /@font-face \{ font-family: Lobster/);
  assert.doesNotMatch(first, /@import/, 'the @import Chromium ignores must be gone');
  assert.match(first, /body \{ font-family: Lobster; \}/, 'the rest of the stylesheet survives');

  await inlineStyleImports(css, options);
  assert.equal(fetched.length, 1, 'a repeated save must not refetch the same stylesheet');
});

test('a failed or disallowed import leaves a visible comment and reports the reason', async () => {
  const errors = [];
  const css = [
    "@import url('https://fonts.googleapis.com/css2?family=Broken');",
    "@import url('https://evil.example.com/tracker.css');",
    'body { color: red; }'
  ].join('\n');

  const result = await inlineStyleImports(css, {
    fetchCss: async () => {
      throw new Error('responded 404');
    },
    onError: (error) => errors.push(error.message)
  });

  assert.match(result, /import failed for https:\/\/fonts\.googleapis\.com/);
  assert.match(result, /import not fetched \(host is not one of/);
  assert.match(result, /body \{ color: red; \}/, 'a broken import must not discard the rest');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /host is not one of/);
  assert.match(errors[1], /responded 404/);
});

test('stylesheet fetching is bounded by status, size, and a current-Chrome user agent', async () => {
  let seenHeaders = null;
  await assert.rejects(
    () => fetchStyleImport('https://fonts.googleapis.com/x', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /responded 503/
  );
  await assert.rejects(
    () =>
      fetchStyleImport('https://fonts.googleapis.com/x', {
        maxBytes: 8,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(64) })
      }),
    /larger than 8 bytes/
  );
  const body = await fetchStyleImport('https://fonts.googleapis.com/x', {
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return { ok: true, status: 200, text: async () => '@font-face {}' };
    }
  });
  assert.equal(body, '@font-face {}');
  assert.match(seenHeaders['User-Agent'], /Chrome\/\d+/, 'Google Fonts serves woff2 only to a modern agent');
});

test('applying custom CSS resolves its imports before inserting the stylesheet', async () => {
  const webContents = fakeWebContents();
  const overrides = new CustomStyleOverrides({
    webContents,
    cssPath: CSS_PATH,
    readCss: () => "@import url('https://fonts.googleapis.com/css2?family=Lobster');\nbody{}",
    inlineImports: async (css) => css.replace(/@import[^;]+;/, '@font-face{}'),
    watch: () => {},
    unwatch: () => {}
  });

  assert.equal(await overrides.apply(), true);
  assert.equal(webContents.calls.inserted[0].css, '@font-face{}\nbody{}');
});

test('commenting a block out disables it, even when it contains an @import', async () => {
  // Josh's workflow: comment rules out to switch them off, uncomment to resume.
  // A fetched stylesheet carries its own comments, so splicing one into a
  // commented region would close that comment early and revive the rules.
  const css = [
    '/* ==========================',
    "   @import url('https://fonts.googleapis.com/css2?family=Lobster&display=swap');",
    '   :root { --bs-font-sans: "Lobster", sans-serif; }',
    '   ========================== */',
    '',
    'body { color: red; }'
  ].join('\n');

  assert.deepEqual(collectStyleImports(css).allowed, [], 'a commented import must not be fetched');

  let fetched = false;
  const result = await inlineStyleImports(css, {
    fetchCss: async () => {
      fetched = true;
      return '/* cyrillic */\n@font-face { font-family: Lobster; }';
    }
  });
  assert.equal(fetched, false);
  assert.equal(result, css, 'a stylesheet with only commented imports must be untouched');
  assert.doesNotMatch(
    result.split('*/')[0],
    /@font-face/,
    'nothing may be spliced inside the header comment'
  );
});

test('a live import is resolved while an identical commented copy is left alone', async () => {
  const url = 'https://fonts.googleapis.com/css2?family=Lobster';
  const css = [
    `/* example: @import url('${url}'); */`,
    `@import url('${url}');`,
    'body { color: red; }'
  ].join('\n');

  const result = await inlineStyleImports(css, { fetchCss: async () => '@font-face { font-family: Lobster; }' });
  const [commentLine, ...rest] = result.split('\n');
  assert.match(commentLine, /example: @import/, 'the commented copy must survive verbatim');
  assert.match(rest.join('\n'), /@font-face \{ font-family: Lobster; \}/);
  assert.match(result, /body \{ color: red; \}/);
});

test('comment ranges cover nested-looking and unterminated comments', () => {
  assert.deepEqual(cssCommentRanges('a/* x */b'), [[1, 8]]);
  assert.deepEqual(cssCommentRanges('/* a */ b /* c */'), [[0, 7], [10, 17]]);
  assert.deepEqual(
    cssCommentRanges('body{} /* never closed'),
    [[7, 22]],
    'an unterminated comment disables everything after it'
  );
});
