import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBackupExportFilename,
  describeBackupExportFailure,
  streamBackupExportToFile,
  writeBackupResponseToFile
} from './backup-export-download.mjs';

test('backup export filename uses the same timestamp shape as the app route', () => {
  assert.equal(
    createBackupExportFilename(new Date('2026-08-23T18:16:25.123Z')),
    'batshit-backup-2026-08-23T181625Z.zip'
  );
  assert.throws(() => createBackupExportFilename(new Date('invalid')), /valid date/);
});

test('backup response streams to an atomic replacement without leftover temp files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-'));
  const targetPath = join(directory, 'batshit-backup.zip');
  try {
    await writeFile(targetPath, 'old backup');
    const expected = new Uint8Array(8 * 1024 * 1024 + 17);
    expected.fill(0x5a);
    const response = new Response(expected, {
      headers: { 'Content-Type': 'application/zip' }
    });

    await writeBackupResponseToFile(response, targetPath);

    assert.deepEqual(new Uint8Array(await readFile(targetPath)), expected);
    assert.deepEqual(await readdir(directory), ['batshit-backup.zip']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed backup streams preserve the existing target and remove partial files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-failure-'));
  const targetPath = join(directory, 'batshit-backup.zip');
  try {
    await writeFile(targetPath, 'existing backup');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error('stream interrupted'));
      }
    });
    const response = new Response(body, {
      headers: { 'Content-Type': 'application/zip' }
    });

    await assert.rejects(() => writeBackupResponseToFile(response, targetPath), /stream interrupted/);

    assert.equal(await readFile(targetPath, 'utf8'), 'existing backup');
    assert.deepEqual(await readdir(directory), ['batshit-backup.zip']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup export failures prefer the route error and reject unexpected success types', async () => {
  const failure = new Response(JSON.stringify({ error: 'Backup inventory failed.' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(await describeBackupExportFailure(failure), 'Backup inventory failed.');

  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-type-'));
  try {
    await assert.rejects(
      () => writeBackupResponseToFile(new Response('not a zip'), join(directory, 'backup.zip')),
      /unexpected file type/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// BL-1406: standalone body cancellation and the Electron request's transport abort are separate.
function trackedZipResponse(contentType = 'application/zip', cancel = () => {}) {
  const cancels = [];
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([0x50, 0x4b]));
    },
    cancel(reason) {
      cancels.push(reason);
      return cancel(reason);
    }
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { 'Content-Type': contentType } }), cancels };
}

test('a refused 200 body is cancelled and the existing backup is left alone (BL-1406)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-refused-'));
  const targetPath = join(directory, 'batshit-backup.zip');
  try {
    await writeFile(targetPath, 'existing backup');
    const refusals = [
      { name: 'unexpected type', contentType: 'text/html', target: targetPath, error: /unexpected file type/ },
      { name: 'relative destination', contentType: 'application/zip', target: 'batshit-backup.zip', error: /destination is invalid/ },
      { name: 'NUL in destination', contentType: 'application/zip', target: `${targetPath}\0x`, error: /destination is invalid/ },
      { name: 'over-long destination', contentType: 'application/zip', target: join(directory, 'a'.repeat(4097)), error: /destination is invalid/ },
      { name: 'empty destination', contentType: 'application/zip', target: '', error: /destination is invalid/ }
    ];
    for (const refusal of refusals) {
      const { response, cancels } = trackedZipResponse(refusal.contentType);
      await assert.rejects(() => writeBackupResponseToFile(response, refusal.target), refusal.error, refusal.name);
      assert.equal(cancels.length, 1, `${refusal.name}: the body is cancelled once`);
      assert.equal(response.bodyUsed, true, `${refusal.name}: nothing else can read the body`);
    }
    assert.equal(await readFile(targetPath, 'utf8'), 'existing backup');
    assert.deepEqual(await readdir(directory), ['batshit-backup.zip']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failing or endless cancel never replaces the refusal (BL-1406)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-cancel-fails-'));
  const targetPath = join(directory, 'batshit-backup.zip');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await writeFile(targetPath, 'existing backup');
    // The body's own cancel rejects.
    const rejecting = trackedZipResponse('text/html', () => Promise.reject(new Error('cancel rejected')));
    await assert.rejects(() => writeBackupResponseToFile(rejecting.response, targetPath), /unexpected file type/);
    assert.equal(rejecting.cancels.length, 1);
    // The body's own cancel never settles: the refusal still comes back.
    const endless = trackedZipResponse('application/zip', () => new Promise(() => {}));
    await assert.rejects(() => writeBackupResponseToFile(endless.response, 'relative.zip'), /destination is invalid/);
    assert.equal(endless.cancels.length, 1);
    // A body whose cancel throws at once (not a web stream).
    const throwing = {
      ok: true,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      body: { cancel() { throw new Error('cancel threw'); } }
    };
    await assert.rejects(() => writeBackupResponseToFile(throwing, targetPath), /unexpected file type/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(await readFile(targetPath, 'utf8'), 'existing backup');
    assert.deepEqual(await readdir(directory), ['batshit-backup.zip']);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a write that fails after piping began cancels the body through the pipeline (unchanged)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-write-fails-'));
  try {
    const { response, cancels } = trackedZipResponse();
    await assert.rejects(
      () => writeBackupResponseToFile(response, join(directory, 'no-such-folder', 'backup.zip')),
      (error) => error.code === 'ENOENT'
    );
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]?.code, 'ENOENT');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session refusals abort transport even when body cancellation fails or never settles (BL-1406)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-abort-refusal-'));
  const targetPath = join(directory, 'backup.zip');
  const signals = [];
  try {
    await writeFile(targetPath, 'existing backup');
    const refusals = [
      { contentType: 'text/plain', target: targetPath, error: /unexpected file type/, cancel: () => Promise.reject(new Error('body cancel failed')) },
      { contentType: 'application/zip', target: 'relative.zip', error: /destination is invalid/, cancel: () => new Promise(() => {}) }
    ];
    for (const refusal of refusals) {
      const { response, cancels } = trackedZipResponse(refusal.contentType, refusal.cancel);
      let transportAborts = 0;
      const electronSession = {
        async fetch(_url, options) {
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.signal.aborted, false);
          signals.push(options.signal);
          options.signal.addEventListener('abort', () => { transportAborts += 1; });
          return response;
        }
      };
      await assert.rejects(() => streamBackupExportToFile({ electronSession,
        exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export', includeSecrets: false,
        targetPath: refusal.target }), refusal.error);
      assert.equal(cancels.length, 1, 'standalone response body cancellation is preserved');
      assert.equal(transportAborts, 1, 'the actual request signal aborts once, independently of body.cancel');
      assert.equal(signals.at(-1).aborted, true);
    }
    assert.notEqual(signals[0], signals[1], 'each export owns its own cancellation');
    assert.equal(await readFile(targetPath, 'utf8'), 'existing backup');
    assert.deepEqual(await readdir(directory), ['backup.zip']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a piped session response failure aborts transport and retains the original error (BL-1406)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-abort-pipeline-'));
  const targetPath = join(directory, 'backup.zip');
  const primary = new Error('owned response stream failed');
  let signal;
  let transportAborts = 0;
  try {
    await writeFile(targetPath, 'existing backup');
    await assert.rejects(() => streamBackupExportToFile({
      electronSession: {
        async fetch(_url, options) {
          signal = options.signal;
          signal.addEventListener('abort', () => { transportAborts += 1; });
          return new Response(new ReadableStream({ start(controller) { controller.error(primary); } }), {
            headers: { 'Content-Type': 'application/zip' }
          });
        }
      }, exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export', includeSecrets: false, targetPath
    }), (error) => error === primary);
    assert.equal(signal.aborted, true);
    assert.equal(transportAborts, 1);
    assert.equal(await readFile(targetPath, 'utf8'), 'existing backup');
    assert.deepEqual(await readdir(directory), ['backup.zip']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a session fetch rejection aborts its request and retains the original error (BL-1406)', async () => {
  const primary = new Error('owned session fetch failed');
  let signal;
  let transportAborts = 0;
  await assert.rejects(() => streamBackupExportToFile({
    electronSession: {
      async fetch(_url, options) {
        signal = options.signal;
        signal.addEventListener('abort', () => { transportAborts += 1; });
        throw primary;
      }
    }, exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export', includeSecrets: false,
    targetPath: 'unused-relative.zip'
  }), (error) => error === primary);
  assert.equal(signal.aborted, true);
  assert.equal(transportAborts, 1);
});

test('backup export uses the authenticated Electron session and exact secret confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-session-'));
  const targetPath = join(directory, 'backup.zip');
  const calls = [];
  const electronSession = {
    async fetch(url, options) {
      calls.push({ url, options });
      return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
        headers: { 'Content-Type': 'application/zip' }
      });
    }
  };
  try {
    await streamBackupExportToFile({
      electronSession,
      exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export',
      includeSecrets: true,
      targetPath
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:5620/api/admin/backup/export');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'include');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.signal.aborted, false, 'successful atomic writes do not abort transport');
    assert.equal(calls[0].options.headers.Origin, 'http://127.0.0.1:5620');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      includeSecrets: true,
      confirmIncludeSecrets: true
    });
    assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup export hands back the folders the backup could not carry (BL-373/BL-369)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-not-carried-'));
  const notCarried = encodeURIComponent(JSON.stringify({ count: 1, items: [{ root: 'skills', label: 'Gone', reason: 'missing' }] }));
  const exportWith = (headers) => streamBackupExportToFile({
    electronSession: {
      async fetch() {
        return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
          headers: { 'Content-Type': 'application/zip', ...headers }
        });
      }
    },
    exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export',
    includeSecrets: false,
    targetPath: join(directory, `backup-${Math.random().toString(36).slice(2)}.zip`)
  });
  try {
    assert.deepEqual(await exportWith({ 'X-Batshit-Backup-Not-Carried': notCarried }), { notCarried });
    assert.deepEqual(await exportWith({}), { notCarried: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// BL-378 Phase 1b: a partial request goes to the route whole, the Save dialog suggests the route's
// PARTIAL name, and the summary header comes back as text for the app's strict parser.
test('a partial backup request carries its rows and hands back the summary header as sent', async () => {
  assert.equal(
    createBackupExportFilename(new Date('2026-08-23T18:16:25.123Z'), { partial: true }),
    'batshit-backup-PARTIAL-2026-08-23T181625Z.zip'
  );
  const directory = await mkdtemp(join(tmpdir(), 'batshit-backup-export-partial-'));
  const partial = {
    acknowledged: [{ key: 'upload:images:a.png', relativePath: 'images/a.png', fingerprint: 'a'.repeat(64) }],
    confirmAllMissing: true
  };
  const summary = '{"completeness":"partial","missingFiles":1,"missingRecords":1,"foundAgainFiles":0,"goneRecords":0,"otherRecords":0}';
  const bodies = [];
  const signals = [];
  const exportWith = (headers, options = { partial }) => streamBackupExportToFile({
    electronSession: {
      async fetch(_url, init) {
        bodies.push(JSON.parse(init.body));
        signals.push(init.signal);
        return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
          headers: { 'Content-Type': 'application/zip', ...headers }
        });
      }
    },
    exportUrl: 'http://127.0.0.1:5620/api/admin/backup/export',
    includeSecrets: false,
    ...options,
    targetPath: join(directory, `backup-${Math.random().toString(36).slice(2)}.zip`)
  });
  try {
    assert.deepEqual(await exportWith({ 'X-Batshit-Backup-Missing-Uploads': summary }), { notCarried: null, missingUploads: summary });
    assert.deepEqual(bodies[0], { includeSecrets: false, confirmIncludeSecrets: false, partial });
    // No header: the app hears "unavailable", never a made-up summary.
    assert.deepEqual(await exportWith({}), { notCarried: null, missingUploads: null });
    // A plain export is unchanged: no partial in the body and no summary in the answer.
    assert.deepEqual(await exportWith({ 'X-Batshit-Backup-Missing-Uploads': summary }, {}), { notCarried: null });
    assert.deepEqual(bodies[2], { includeSecrets: false, confirmIncludeSecrets: false });
    await assert.rejects(exportWith({}, { partial: [partial] }), /partial must be an object/);
    assert.equal(bodies.length, 3);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal && signal.aborted === false));
    assert.equal(new Set(signals).size, 3, 'successful exports use independent signals and remain un-aborted');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
