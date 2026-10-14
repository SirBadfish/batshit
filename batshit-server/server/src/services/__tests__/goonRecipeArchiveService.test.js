const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { zipSync, strToU8, Zip, ZipPassThrough } = require('fflate');
const { GOON_MANIFEST_MAX_BYTES, GOON_CUSTOM_MODEL_MAX_BYTES } = require('../goonPackageLimits.json');
const {
  inspectAndExtractRecipeArchive
} = require('../goonRecipeArchiveService');

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-recipe-archive-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function glbBytes(size = 32) {
  const bytes = new Uint8Array(size);
  bytes.set(strToU8('glTF'));
  return bytes;
}

async function writeArchive(entries) {
  const archivePath = path.join(root, 'source.bgoon');
  await fs.writeFile(archivePath, Buffer.from(zipSync(entries, { level: 0 })));
  return archivePath;
}

async function inspect(entries, overrides = {}) {
  return inspectAndExtractRecipeArchive({
    archivePath: await writeArchive(entries),
    outputDir: root,
    maxArchiveBytes: 1024 * 1024,
    maxModelBytes: 512 * 1024,
    maxManifestBytes: 64 * 1024,
    maxTotalUncompressedBytes: 576 * 1024,
    maxExpansionRatio: 100,
    ...overrides
  });
}

describe('Recipe archive extraction', () => {
  it('streams and hashes exactly avatar.json plus avatar.glb', async () => {
    const result = await inspect({
      'avatar.json': strToU8(JSON.stringify({ contract: 'batshit-custom-avatar/v2' })),
      'avatar.glb': glbBytes()
    });

    expect(result.entryCount).toBe(2);
    expect(result.members.map((member) => member.role)).toEqual(['manifest', 'model']);
    expect(result.members.map((member) => member.path)).toEqual(['avatar.json', 'avatar.glb']);
    expect(result.manifest.contract).toBe('batshit-custom-avatar/v2');
    await expect(fs.stat(result.members[0].tempPath)).resolves.toBeTruthy();
    await expect(fs.stat(result.members[1].tempPath)).resolves.toBeTruthy();
  });

  it.each([
    ['nested path', { 'nested/avatar.json': strToU8('{}'), 'avatar.glb': glbBytes() }],
    ['extra member', { 'avatar.json': strToU8('{}'), 'avatar.glb': glbBytes(), 'extra.txt': strToU8('x') }],
    ['case collision', { 'avatar.json': strToU8('{}'), 'AVATAR.JSON': strToU8('{}'), 'avatar.glb': glbBytes() }]
  ])('rejects %s before promotion', async (_label, entries) => {
    await expect(inspect(entries)).rejects.toThrow(/exactly the two root files|duplicate member/);
  });

  it('rejects invalid UTF-8 JSON and invalid GLB signatures', async () => {
    await expect(
      inspect({
        'avatar.json': new Uint8Array([0xff, 0xfe]),
        'avatar.glb': glbBytes()
      })
    ).rejects.toThrow(/strict UTF-8/);

    await expect(
      inspect({
        'avatar.json': strToU8('{}'),
        'avatar.glb': strToU8('nope')
      })
    ).rejects.toThrow(/valid GLB signature/);
  });

  it('enforces member and total expansion bounds from actual streamed bytes', async () => {
    await expect(
      inspect(
        {
          'avatar.json': strToU8('{}'),
          'avatar.glb': glbBytes(128)
        },
        { maxModelBytes: 64 }
      )
    ).rejects.toThrow(/avatar.glb exceeds the allowed extracted size/);
  });

  it.each([7522825, GOON_MANIFEST_MAX_BYTES])('accepts a %i-byte manifest through the bounded production extractor', async (size) => {
    expect(GOON_MANIFEST_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(GOON_CUSTOM_MODEL_MAX_BYTES).toBe(594 * 1024 * 1024);
    const manifestBytes = strToU8(JSON.stringify({ payload: 'x'.repeat(size - 14) }));
    expect(manifestBytes.byteLength).toBe(size);
    const result = await inspect({ 'avatar.json': manifestBytes, 'avatar.glb': glbBytes() }, {
      maxArchiveBytes: 600 * 1024 * 1024,
      maxModelBytes: GOON_CUSTOM_MODEL_MAX_BYTES,
      maxManifestBytes: GOON_MANIFEST_MAX_BYTES,
      maxTotalUncompressedBytes: 600 * 1024 * 1024,
      maxExpansionRatio: 20
    });
    expect(result.manifestText).toHaveLength(size);
    expect(result.members.find(member => member.role === 'manifest').bytes).toBe(size);
  });

  it.each([false, true])('rejects the manifest ceiling plus one byte before promotion (streaming descriptor: %s)', async (streaming) => {
    const entries = {
      'avatar.json': strToU8(JSON.stringify({ payload: 'x'.repeat(GOON_MANIFEST_MAX_BYTES - 13) })),
      'avatar.glb': glbBytes()
    };
    let archivePath;
    if (streaming) {
      // A streaming ZIP does not announce the final size in its local header;
      // the same ceiling must still stop the actual decompressed byte stream.
      const chunks = [];
      const zip = new Zip((error, data) => {
        if (error) throw error;
        chunks.push(Buffer.from(data));
      });
      for (const [name, bytes] of Object.entries(entries)) {
        const member = new ZipPassThrough(name);
        zip.add(member);
        member.push(bytes, true);
      }
      zip.end();
      archivePath = path.join(root, 'streaming.bgoon');
      await fs.writeFile(archivePath, Buffer.concat(chunks));
    } else archivePath = await writeArchive(entries);
    await expect(inspectAndExtractRecipeArchive({
      archivePath, outputDir: root,
      maxArchiveBytes: 600 * 1024 * 1024,
      maxModelBytes: GOON_CUSTOM_MODEL_MAX_BYTES,
      maxManifestBytes: GOON_MANIFEST_MAX_BYTES,
      maxTotalUncompressedBytes: 600 * 1024 * 1024,
      maxExpansionRatio: 20
    })).rejects.toThrow(/avatar.json exceeds the allowed extracted size/);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.extracting'))).toEqual([]);
  });

  it('retains total-byte and 20:1 expansion limits independently of valid individual member sizes', async () => {
    await expect(inspect({ 'avatar.json': strToU8('{}'), 'avatar.glb': glbBytes(128) }, {
      maxTotalUncompressedBytes: 128
    })).rejects.toThrow(/allowed total size/);
    const archivePath = path.join(root, 'compressed.bgoon');
    await fs.writeFile(archivePath, zipSync({
      'avatar.json': strToU8(JSON.stringify({ payload: 'x'.repeat(32000) })),
      'avatar.glb': glbBytes()
    }, { level: 9 }));
    await expect(inspectAndExtractRecipeArchive({
      archivePath, outputDir: root, maxArchiveBytes: 600 * 1024 * 1024,
      maxModelBytes: GOON_CUSTOM_MODEL_MAX_BYTES, maxManifestBytes: GOON_MANIFEST_MAX_BYTES,
      maxTotalUncompressedBytes: 600 * 1024 * 1024, maxExpansionRatio: 20
    })).rejects.toThrow(/allowed expansion ratio/);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.extracting'))).toEqual([]);
  });
});
