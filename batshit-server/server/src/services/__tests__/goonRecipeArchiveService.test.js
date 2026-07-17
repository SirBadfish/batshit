const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
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
});
