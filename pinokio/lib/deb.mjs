// Read named files out of a Debian package (.deb) without dpkg, root, or any system tool, so
// the launcher can unpack Redis's official packages on any Linux. A .deb is an `ar` archive
// holding data.tar.{zst,gz}; the tar is read in memory and only the requested regular files
// are returned. Anything unexpected is an error, never a partial result.
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;
const TAR_BLOCK = 512;

export function readArMembers(buffer) {
  if (buffer.subarray(0, AR_MAGIC.length).toString('latin1') !== AR_MAGIC) {
    throw new Error('Not a Debian package: the ar archive header is missing.');
  }
  const members = new Map();
  let offset = AR_MAGIC.length;
  while (offset + AR_HEADER_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + AR_HEADER_SIZE).toString('latin1');
    if (header.slice(58, 60) !== '`\n') {
      throw new Error(`Damaged Debian package: bad ar member header at byte ${offset}.`);
    }
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Damaged Debian package: bad size for ar member ${name}.`);
    }
    const start = offset + AR_HEADER_SIZE;
    if (start + size > buffer.length) {
      throw new Error(`Damaged Debian package: ar member ${name} is truncated.`);
    }
    members.set(name, buffer.subarray(start, start + size));
    offset = start + size + (size % 2);
  }
  return members;
}

export function debDataTar(buffer) {
  const members = readArMembers(buffer);
  if (members.has('data.tar.zst')) return zstdDecompressSync(members.get('data.tar.zst'));
  if (members.has('data.tar.gz')) return gunzipSync(members.get('data.tar.gz'));
  if (members.has('data.tar')) return members.get('data.tar');
  const names = [...members.keys()].join(', ');
  throw new Error(`Unsupported Debian package payload (members: ${names}); expected data.tar.zst or data.tar.gz.`);
}

function tarString(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function tarOctal(block, start, length) {
  const text = tarString(block, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function normalizeTarPath(name) {
  return name.replace(/^\.\//, '').replace(/^\/+/, '');
}

// Returns Map(path -> { mode, data }) for the requested paths (package paths without the
// leading "./", for example "usr/bin/redis-server"). Every requested path must be a regular
// file in the archive.
export function readTarFiles(tar, wantedPaths) {
  const wanted = new Set(wantedPaths.map(normalizeTarPath));
  const found = new Map();
  let offset = 0;
  let longName = null;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const baseName = tarString(header, 0, 100);
    const name = normalizeTarPath(longName ?? (prefix ? `${prefix}/${baseName}` : baseName));
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`Damaged package payload: ${name} is truncated.`);
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === 'L') {
      longName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    longName = null;
    if (!wanted.has(name)) continue;
    if (type !== '0' && type !== '\0') {
      throw new Error(`${name} in the package is not a regular file (tar type ${JSON.stringify(type)}).`);
    }
    found.set(name, { mode: tarOctal(header, 100, 8) & 0o777, data: Buffer.from(tar.subarray(dataStart, dataEnd)) });
  }
  const missing = [...wanted].filter((path) => !found.has(path));
  if (missing.length > 0) throw new Error(`The package does not contain: ${missing.join(', ')}`);
  return found;
}

export function readDebFiles(buffer, wantedPaths) {
  return readTarFiles(debDataTar(buffer), wantedPaths);
}
