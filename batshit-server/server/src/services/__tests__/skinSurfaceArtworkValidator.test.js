const sharp = require('sharp');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  clearSkinSurfaceArtworkContractCacheForTests,
  prepareSkinSurfaceArtworkUpload
} = require('../skinSurfaceArtworkValidator');

const DEFINITION_SHA256 =
  'd1a609899ed6c67463c67f141adb3f3e5277e83921501d23907bb88762af8c52';

function input(buffer, map = 'baseColor', overrides = {}) {
  return {
    buffer,
    map,
    definitionSha256: DEFINITION_SHA256,
    provenance: JSON.stringify({
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    }),
    ...overrides
  };
}

describe('skinSurfaceArtworkValidator', () => {
  let previousAssetRoot;
  const temporaryRoots = [];

  beforeEach(() => {
    previousAssetRoot = process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT;
    delete process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT;
    clearSkinSurfaceArtworkContractCacheForTests();
  });

  afterEach(async () => {
    if (previousAssetRoot === undefined) {
      delete process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT;
    } else {
      process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT = previousAssetRoot;
    }
    clearSkinSurfaceArtworkContractCacheForTests();
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
      )
    );
  });

  it('canonicalizes exact Base Color into sRGB RGBA8', async () => {
    const source = await sharp({
      create: {
        width: 4096,
        height: 4096,
        channels: 3,
        background: { r: 120, g: 90, b: 75 }
      }
    })
      .png()
      .toBuffer();
    const prepared = await prepareSkinSurfaceArtworkUpload(input(source));
    expect(prepared.artwork).toMatchObject({
      schemaVersion: 'skin-surface-artwork/v1',
      map: 'baseColor',
      definitionSha256: DEFINITION_SHA256,
      canvas: {
        width: 4096,
        height: 4096,
        colorSpace: 'srgb',
        flipY: false,
        encoding: 'rgba8'
      },
      mimeType: 'image/png'
    });
    expect(await sharp(prepared.buffer).metadata()).toMatchObject({
      format: 'png',
      width: 4096,
      height: 4096,
      channels: 4,
      depth: 'uchar'
    });
  }, 30000);

  it('renormalizes an OpenGL Normal and stores RGB8 with no alpha', async () => {
    const source = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 4,
        background: { r: 128, g: 128, b: 255, alpha: 0.5 }
      }
    })
      .png()
      .toBuffer();
    const prepared = await prepareSkinSurfaceArtworkUpload(input(source, 'normal'));
    expect(prepared.artwork.canvas).toEqual({
      width: 2048,
      height: 2048,
      colorSpace: 'linear',
      flipY: false,
      encoding: 'rgb8-normal-opengl'
    });
    expect(await sharp(prepared.buffer).metadata()).toMatchObject({
      width: 2048,
      height: 2048,
      channels: 3,
      depth: 'uchar'
    });
    const pixel = await sharp(prepared.buffer).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([128, 128, 255]);
  }, 30000);

  it('repairs bounded Sampler-style backward Normal vectors and records the repair rate', async () => {
    const pixels = Buffer.alloc(2048 * 2048 * 3, 128);
    for (let index = 2; index < pixels.length; index += 3) pixels[index] = 255;
    // This 20x20 chest patch is fully inside General Skin ownership. Its 400
    // repairs are about 0.016% of owned pixels: representative of Best 4,
    // above the retired 0.01% ceiling, and safely below the 0.1% product cap.
    for (let y = 300; y < 320; y += 1) {
      for (let x = 250; x < 270; x += 1) {
        const repairedPixel = (y * 2048 + x) * 3;
        pixels[repairedPixel] = 127;
        pixels[repairedPixel + 1] = 3;
        pixels[repairedPixel + 2] = 117;
      }
    }
    const source = await sharp(pixels, {
      raw: { width: 2048, height: 2048, channels: 3 }
    })
      .png()
      .toBuffer();

    const prepared = await prepareSkinSurfaceArtworkUpload(input(source, 'normal'));
    expect(prepared.preparation.validation).toMatchObject({
      negativeZVectors: 400,
      backwardVectorRepairs: 400,
      maximumBackwardVectorRepairRate: 0.001
    });
    expect(prepared.preparation.validation.backwardVectorRepairRate).toBeGreaterThan(0.0001);
    expect(prepared.preparation.validation.backwardVectorRepairRate).toBeLessThan(0.001);
  }, 30000);

  it.each([
    ['roughness', 'rgb8-roughness-g', [255, 64, 0]],
    ['metallic', 'rgb8-metallic-b', [255, 255, 64]]
  ])('packs %s into the channel Three.js reads', async (map, encoding, expected) => {
    const source = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: { r: 64, g: 64, b: 64 }
      }
    })
      .png()
      .toBuffer();
    const prepared = await prepareSkinSurfaceArtworkUpload(input(source, map));
    expect(prepared.artwork.canvas.encoding).toBe(encoding);
    const pixel = await sharp(prepared.buffer).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual(expected);
  }, 30000);

  it('rejects wrong dimensions, roles, identities, and backward-facing normals', async () => {
    const wrongSize = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 128, g: 128, b: 255 }
      }
    })
      .png()
      .toBuffer();
    await expect(
      prepareSkinSurfaceArtworkUpload(input(wrongSize, 'normal'))
    ).rejects.toThrow(/2048x2048 or 4096x4096/);
    await expect(
      prepareSkinSurfaceArtworkUpload(input(wrongSize, 'height'))
    ).rejects.toThrow(/map role is unsupported/);
    await expect(
      prepareSkinSurfaceArtworkUpload(
        input(wrongSize, 'normal', { definitionSha256: 'not-a-sha256' })
      )
    ).rejects.toThrow(/unsupported Skin Appearance identity/);

    const backward = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: { r: 128, g: 128, b: 0 }
      }
    })
      .png()
      .toBuffer();
    await expect(
      prepareSkinSurfaceArtworkUpload(input(backward, 'normal'))
    ).rejects.toThrow(/too many backward-facing tangent directions to repair safely/);
  }, 30000);

  it('loads the trusted definition from the packaged Skin Appearance asset root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skin-appearance-'));
    temporaryRoots.push(root);
    const definition = await fs.readFile(
      path.resolve(
        __dirname,
        '../../../../../batshit-app/static/goons/skin-appearance/v1/skin-appearance-v1.json'
      )
    );
    await fs.writeFile(path.join(root, 'skin-appearance-v1.json'), definition);
    process.env.BATSHIT_SKIN_APPEARANCE_ASSET_ROOT = root;

    const source = await sharp({
      create: {
        width: 4096,
        height: 4096,
        channels: 4,
        background: { r: 90, g: 70, b: 60, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    await expect(
      prepareSkinSurfaceArtworkUpload(input(source))
    ).resolves.toMatchObject({ artwork: { definitionSha256: DEFINITION_SHA256 } });
  }, 30000);
});
