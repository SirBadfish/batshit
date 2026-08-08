const path = require('path');
const sharp = require('sharp');
const {
  clearNailArtworkContractCacheForTests,
  prepareNailArtworkUpload
} = require('../nailArtworkValidator');

const ROOT = path.resolve(__dirname, '../../../../..');
const CONTRACT = require(path.join(
  ROOT,
  'batshit-app/static/goons/nail-surface/v1/nail-surface-v1.json'
));
const ASSET_ROOT = path.join(ROOT, 'batshit-app/static/goons/nail-surface/v1');

function input(family, buffer, overrides = {}) {
  const template = CONTRACT.templates[family];
  return {
    buffer,
    family,
    definitionSha256: CONTRACT.definitionSha256,
    templateId: template.id,
    templateVersion: template.version,
    guideSha256: template.guide.sha256,
    slotMaskSha256: template.slotMask.sha256,
    baseArtworkSha256: template.baseArtwork.sha256,
    width: template.dimensions[0],
    height: template.dimensions[1],
    provenance: {
      sourceKind: 'user-authored',
      author: 'Fixture Artist',
      license: 'User-owned',
      rightsConfirmed: true
    },
    ...overrides
  };
}

async function maskBytes(family) {
  const record = CONTRACT.templates[family].slotMask;
  return sharp(path.join(ASSET_ROOT, record.path.replace('goons/nail-surface/v1/', '')))
    .greyscale()
    .raw()
    .toBuffer();
}

async function artwork(family, options = {}) {
  const [width, height] = CONTRACT.templates[family].dimensions;
  const mask = await maskBytes(family);
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = 240;
    rgba[offset + 1] = 90;
    rgba[offset + 2] = 160;
    rgba[offset + 3] = options.empty ? 0 : options.fullCanvas ? 255 : mask[pixel];
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe('nailArtworkValidator', () => {
  beforeEach(() => {
    clearNailArtworkContractCacheForTests();
  });

  it.each(['fingers', 'toes'])('accepts and proves canonical %s artwork', async (family) => {
    const prepared = await prepareNailArtworkUpload(input(family, await artwork(family)));
    expect(prepared.artwork).toMatchObject({
      schemaVersion: 'nail-artwork/v1',
      family,
      definitionSha256: CONTRACT.definitionSha256,
      template: {
        id: CONTRACT.templates[family].id,
        slotMaskSha256: CONTRACT.templates[family].slotMask.sha256
      },
      mimeType: 'image/png'
    });
    expect(prepared.preparation.paintedPixels).toBeGreaterThan(0);
    expect(prepared.buffer.length).toBeGreaterThan(100);
  });

  it('clips full-canvas alpha to the ten trusted slots', async () => {
    const prepared = await prepareNailArtworkUpload(
      input('fingers', await artwork('fingers', { fullCanvas: true }))
    );
    expect(prepared.preparation.clippedAlphaPixels).toBeGreaterThan(0);
    expect(prepared.preparation.paintedPixels).toBeGreaterThan(0);
  });

  it('canonicalizes an ordinary RGB PNG to RGBA', async () => {
    const [width, height] = CONTRACT.templates.toes.dimensions;
    const buffer = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).png().toBuffer();
    const prepared = await prepareNailArtworkUpload(input('toes', buffer));
    expect(await sharp(prepared.buffer).metadata()).toMatchObject({
      width,
      height,
      depth: 'uchar',
      channels: 4
    });
  });

  it('rejects empty artwork and stale template identity', async () => {
    await expect(
      prepareNailArtworkUpload(input('fingers', await artwork('fingers', { empty: true })))
    ).rejects.toThrow(/alpha is empty inside the nail slots/);
    await expect(
      prepareNailArtworkUpload(
        input('fingers', await artwork('fingers'), {
          definitionSha256: 'a'.repeat(64)
        })
      )
    ).rejects.toThrow(/unsupported Nail Artwork template identity/);
  });
});
