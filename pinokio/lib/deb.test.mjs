import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, zstdCompressSync } from 'node:zlib';

import { readArMembers, readDebFiles } from './deb.mjs';

function tarEntry(name, data, type = '0', mode = 0o755) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarOf(entries) {
  return Buffer.concat([...entries.map((entry) => tarEntry(...entry)), Buffer.alloc(1024)]);
}

function arOf(members) {
  const parts = [Buffer.from('!<arch>\n', 'latin1')];
  for (const [name, data] of members) {
    const header = `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(header, 'latin1'), data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

const server = Buffer.from('#!redis-server binary');
const module = Buffer.from('odd-length module!');
const tar = tarOf([
  ['./usr/', Buffer.alloc(0), '5'],
  ['./usr/bin/redis-server', server],
  ['./usr/lib/redis/modules/rejson.so', module],
  ['./usr/bin/redis-check-rdb', Buffer.alloc(0), '2']
]);

for (const [member, payload] of [
  ['data.tar.zst', zstdCompressSync(tar)],
  ['data.tar.gz', gzipSync(tar)]
]) {
  test(`reads named files from a ${member} package`, () => {
    const deb = arOf([['debian-binary', Buffer.from('2.0\n')], ['control.tar.gz', gzipSync(Buffer.alloc(1024))], [member, payload]]);
    const files = readDebFiles(deb, ['usr/bin/redis-server', './usr/lib/redis/modules/rejson.so']);
    assert.deepEqual(files.get('usr/bin/redis-server').data, server);
    assert.deepEqual(files.get('usr/lib/redis/modules/rejson.so').data, module);
    assert.equal(files.get('usr/bin/redis-server').mode, 0o755);
  });
}

test('a missing file is an error that names it, not a partial result', () => {
  const deb = arOf([['data.tar.zst', zstdCompressSync(tar)]]);
  assert.throws(() => readDebFiles(deb, ['usr/bin/redis-server', 'usr/bin/redis-cli']), /does not contain: usr\/bin\/redis-cli/);
});

test('a link is refused where a real file is expected', () => {
  const deb = arOf([['data.tar.zst', zstdCompressSync(tar)]]);
  assert.throws(() => readDebFiles(deb, ['usr/bin/redis-check-rdb']), /not a regular file/);
});

test('an xz payload and a non-package file are clear errors', () => {
  assert.throws(() => readDebFiles(arOf([['data.tar.xz', Buffer.from('x')]]), ['a']), /expected data\.tar\.zst or data\.tar\.gz/);
  assert.throws(() => readArMembers(Buffer.from('PK\x03\x04 not an ar archive')), /ar archive header is missing/);
});

test('a truncated package is an error', () => {
  const deb = arOf([['data.tar.zst', zstdCompressSync(tar)]]);
  assert.throws(() => readArMembers(deb.subarray(0, deb.length - 10)), /truncated/);
});
