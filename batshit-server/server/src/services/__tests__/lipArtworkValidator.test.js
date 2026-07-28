const path = require('path');
const sharp = require('sharp');
const zlib = require('zlib');
const {
  clearLipArtworkContractCacheForTests,
  prepareLipArtworkUpload
} = require('../lipArtworkValidator');

const ROOT = path.resolve(__dirname, '../../../../..');
const CONTRACT = require(path.join(
  ROOT,
  'batshit-app/static/goons/lip-artwork/v2/lip-artwork-v2.json'
));
const ASSET_ROOT = path.join(ROOT, 'batshit-app/static/goons/lip-artwork/v2');

function input(buffer, overrides = {}) {
  return {
    buffer,
    definitionSha256: CONTRACT.definitionSha256,
    templateId: CONTRACT.template.id,
    templateVersion: CONTRACT.template.version,
    guideSha256: CONTRACT.template.guide.sha256,
    maskSha256: CONTRACT.template.safePaintMask.sha256,
    baseLipReferenceMaskSha256: CONTRACT.template.baseLipReferenceMask.sha256,
    width: CONTRACT.template.dimensions[0],
    height: CONTRACT.template.dimensions[1],
    provenance: {
      sourceKind: 'user-authored',
      author: 'Fixture Artist',
      license: 'User-owned',
      rightsConfirmed: true
    },
    ...overrides
  };
}

async function maskBytes(record) {
  return sharp(path.join(ASSET_ROOT, record.path.replace('goons/lip-artwork/v2/', '')))
    .greyscale()
    .raw()
    .toBuffer();
}

async function artwork(options = {}) {
  const [width, height] = CONTRACT.template.dimensions;
  const reference = await maskBytes(CONTRACT.template.baseLipReferenceMask);
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < reference.length; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = 180;
    rgba[offset + 1] = 70;
    rgba[offset + 2] = 95;
    if (options.fullCanvas) {
      rgba[offset + 3] = 255;
    } else if (options.empty) {
      rgba[offset + 3] = 0;
    } else {
      rgba[offset + 3] =
        reference[pixel] && pixel % width < width / 2 ? 255 : 0;
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([size, typeBytes, data, checksum]);
}

function sixteenBitRgbArtwork() {
  const [width, height] = CONTRACT.template.dimensions;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = 2;
  const scanline = Buffer.alloc(1 + width * 6);
  for (let offset = 1; offset < scanline.length; offset += 6) {
    scanline.writeUInt16BE(0xffff, offset);
    scanline.writeUInt16BE(0xffff, offset + 2);
    scanline.writeUInt16BE(0xffff, offset + 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(scanline)))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

describe('lipArtworkValidator', () => {
  beforeEach(() => {
    clearLipArtworkContractCacheForTests();
  });

  it('accepts deliberately partial base-reference coverage', async () => {
    const prepared = await prepareLipArtworkUpload(input(await artwork()));
    expect(prepared.artwork).toMatchObject({
      definitionSha256: CONTRACT.definitionSha256,
      template: {
        id: CONTRACT.template.id,
        baseLipReferenceMaskSha256: CONTRACT.template.baseLipReferenceMask.sha256
      },
      mimeType: 'image/png'
    });
    expect(prepared.preparation.paintedPixels).toBeGreaterThan(0);
    expect(prepared.preparation).not.toHaveProperty('requiredCoverage');
    expect(prepared.buffer.length).toBeGreaterThan(100);
  });

  it('clips to the safe mask while preserving visible artwork', async () => {
    const prepared = await prepareLipArtworkUpload(input(await artwork({ fullCanvas: true })));
    expect(prepared.preparation.clippedAlphaPixels).toBeGreaterThan(0);
    expect(prepared.preparation.paintedPixels).toBeGreaterThan(0);
  });

  it('accepts an older package identity when the safety boundary is unchanged', async () => {
    const prepared = await prepareLipArtworkUpload(
      input(await artwork(), {
        definitionSha256: 'a'.repeat(64),
        templateId: 'batshit-base-f-lips-v4',
        templateVersion: '4.0.0',
        guideSha256: 'b'.repeat(64),
        baseLipReferenceMaskSha256: 'c'.repeat(64)
      })
    );
    expect(prepared.artwork).toMatchObject({
      definitionSha256: 'a'.repeat(64),
      template: {
        id: 'batshit-base-f-lips-v4',
        version: '4.0.0',
        guideSha256: 'b'.repeat(64),
        maskSha256: CONTRACT.template.safePaintMask.sha256,
        baseLipReferenceMaskSha256: 'c'.repeat(64)
      }
    });
  });

  it('accepts an ordinary 2048x2048 RGB PNG and canonicalizes it to RGBA', async () => {
    const [width, height] = CONTRACT.template.dimensions;
    const buffer = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).png().toBuffer();
    const prepared = await prepareLipArtworkUpload(input(buffer));
    expect(prepared.artwork).toMatchObject({ width, height, mimeType: 'image/png' });
    expect((await sharp(prepared.buffer).metadata()).channels).toBe(4);
  });

  it('accepts a 16-bit PNG and canonicalizes it to 8-bit RGBA', async () => {
    const buffer = sixteenBitRgbArtwork();
    expect((await sharp(buffer).metadata()).depth).toBe('ushort');
    const prepared = await prepareLipArtworkUpload(input(buffer));
    const metadata = await sharp(prepared.buffer).metadata();
    expect(metadata).toMatchObject({ depth: 'uchar', channels: 4 });
  });

  it('rejects empty artwork and unsupported safety boundaries', async () => {
    await expect(
      prepareLipArtworkUpload(input(await artwork({ empty: true })))
    ).rejects.toThrow(/alpha is empty/);
    await expect(
      prepareLipArtworkUpload(
        input(await artwork(), { maskSha256: 'a'.repeat(64) })
      )
    ).rejects.toThrow(/unsupported Lip Artwork safety boundary/);
  });
});
