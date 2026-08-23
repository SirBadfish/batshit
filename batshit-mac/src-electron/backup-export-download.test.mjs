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
