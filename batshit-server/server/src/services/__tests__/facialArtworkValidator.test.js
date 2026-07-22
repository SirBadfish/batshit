const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const zlib = require('zlib');
const {
  clearFacialArtworkContractCacheForTests,
  prepareFacialArtworkUpload
} = require('../facialArtworkValidator');

const ROOT = path.resolve(__dirname, '../../../../..');
const CONTRACT = require(path.join(
  ROOT,
  'batshit-app/static/goons/facial-artwork/v4/facial-artwork-v4.json'
));
const TEMPLATE = CONTRACT.templates.find((item) => item.id === 'brow-canvas');
const LASHES_TEMPLATE = CONTRACT.templates.find(
  (item) => item.id === 'lashes-eye-outline-canvas'
);

function input(buffer, overrides = {}) {
  const orientation = overrides.orientation || TEMPLATE.canonicalOrientation;
  const variant =
    orientation === TEMPLATE.canonicalOrientation
      ? TEMPLATE
      : TEMPLATE.mirroredHorizontalVariant || TEMPLATE;
  return {
    buffer,
    role: 'brows',
    definitionSha256: CONTRACT.definitionSha256,
    templateId: TEMPLATE.id,
    templateVersion: TEMPLATE.version,
    orientation,
    guideSha256: variant.guide.sha256,
    maskSha256: variant.safePaintMask.sha256,
    provenance: {
      sourceKind: 'user-authored',
      author: 'Fixture Artist',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    },
    ...overrides
  };
}

function lashesInput(buffer, orientation = LASHES_TEMPLATE.canonicalOrientation) {
  const variant =
    orientation === LASHES_TEMPLATE.canonicalOrientation
      ? LASHES_TEMPLATE
      : LASHES_TEMPLATE.mirroredHorizontalVariant;
  return {
    ...input(buffer),
    role: 'lashes_eye_outline',
    templateId: LASHES_TEMPLATE.id,
    templateVersion: LASHES_TEMPLATE.version,
    orientation,
    guideSha256: variant.guide.sha256,
    maskSha256: variant.safePaintMask.sha256
  };
}

function roleInput(roleId, buffer) {
  const role = CONTRACT.roles.find((item) => item.id === roleId);
  const template = CONTRACT.templates.find((item) => item.id === role.template);
  return {
    ...input(buffer),
    role: roleId,
    templateId: template.id,
    templateVersion: template.version,
    orientation: template.canonicalOrientation,
    guideSha256: template.guide.sha256,
    maskSha256: template.safePaintMask.sha256
  };
}

function chunkTypes(buffer) {
  const types = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    types.push(type);
    offset += length + 12;
  }
  return types;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])) >>> 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function addCanonicalSrgbChunk(buffer) {
  const chunks = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (type !== 'sRGB' && type !== 'iCCP') chunks.push(buffer.subarray(offset, end));
    if (type === 'IHDR') chunks.push(pngChunk('sRGB', Buffer.from([0])));
    offset = end;
  }
  return Buffer.concat(chunks);
}

async function encodeCanonicalRgba(rgba, width, height) {
  const buffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ progressive: false })
    .toBuffer();
  return addCanonicalSrgbChunk(buffer);
}

async function createPaintedTemplateFixture(template) {
  const [width, height] = template.dimensions;
  const maskBytes = fs.readFileSync(
    path.join(ROOT, 'batshit-app/static', template.safePaintMask.path)
  );
  const mask = await sharp(maskBytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (mask.info.width !== width || mask.info.height !== height) {
    throw new Error(`Template mask dimensions do not match ${template.id}`);
  }

  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = mask.data[pixel * mask.info.channels];
    if (alpha === 0) continue;
    const offset = pixel * 4;
    rgba[offset] = 79;
    rgba[offset + 1] = 43;
    rgba[offset + 2] = 33;
    rgba[offset + 3] = alpha;
  }
  return encodeCanonicalRgba(rgba, width, height);
}

describe('facialArtworkValidator', () => {
  beforeEach(() => {
    clearFacialArtworkContractCacheForTests();
  });

  test('prepares the positive edit-kit and returns the canonical stored SHA-256', async () => {
    const buffer = await createPaintedTemplateFixture(TEMPLATE);
    const prepared = await prepareFacialArtworkUpload(input(buffer));
    expect(prepared.artwork).toMatchObject({
      role: 'brows',
      definitionSha256: CONTRACT.definitionSha256,
      width: 2048,
      height: 1024,
      mimeType: 'image/png',
      template: {
        orientation: TEMPLATE.canonicalOrientation,
        guideSha256: TEMPLATE.guide.sha256,
        maskSha256: TEMPLATE.safePaintMask.sha256
      }
    });
    expect(prepared.artwork.sha256).toBe(
      crypto.createHash('sha256').update(prepared.buffer).digest('hex')
    );
    expect(chunkTypes(prepared.buffer)).toContain('sRGB');
    expect(chunkTypes(prepared.buffer)).not.toContain('iCCP');
  });

  test('accepts a package-specific definition when its trusted template identity is exact', async () => {
    const buffer = await createPaintedTemplateFixture(TEMPLATE);
    const packageDefinitionSha256 = 'f'.repeat(64);
    const prepared = await prepareFacialArtworkUpload(
      input(buffer, { definitionSha256: packageDefinitionSha256 })
    );
    expect(prepared.artwork.definitionSha256).toBe(packageDefinitionSha256);
  });

  test('reloads the trusted definition when its file changes without a server restart', async () => {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-facial-artwork-'));
    const temporaryRoot = path.join(temporaryParent, 'v4');
    const sourceRoot = path.join(
      ROOT,
      'batshit-app/static/goons/facial-artwork/v4'
    );
    const previousRoot = process.env.BATSHIT_FACIAL_ARTWORK_ASSET_ROOT;
    fs.cpSync(sourceRoot, temporaryRoot, { recursive: true });
    process.env.BATSHIT_FACIAL_ARTWORK_ASSET_ROOT = temporaryRoot;
    clearFacialArtworkContractCacheForTests();

    try {
      const buffer = await createPaintedTemplateFixture(TEMPLATE);
      await expect(prepareFacialArtworkUpload(input(buffer))).resolves.toBeTruthy();

      const contractPath = path.join(temporaryRoot, 'facial-artwork-v4.json');
      const changedContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      changedContract.templates.find((item) => item.id === TEMPLATE.id).version = 'cache-reloaded';
      fs.writeFileSync(contractPath, `${JSON.stringify(changedContract, null, 2)}\n`);

      await expect(prepareFacialArtworkUpload(input(buffer))).rejects.toThrow(
        /template identity/
      );
    } finally {
      if (previousRoot === undefined) {
        delete process.env.BATSHIT_FACIAL_ARTWORK_ASSET_ROOT;
      } else {
        process.env.BATSHIT_FACIAL_ARTWORK_ASSET_ROOT = previousRoot;
      }
      clearFacialArtworkContractCacheForTests();
      fs.rmSync(temporaryParent, { recursive: true, force: true });
    }
  });

  test('rejects malformed definition ownership and wrong template identity', async () => {
    const buffer = await createPaintedTemplateFixture(TEMPLATE);
    await expect(
      prepareFacialArtworkUpload(input(buffer, { definitionSha256: 'not-a-sha256' }))
    ).rejects.toThrow(/must be a lowercase SHA-256 hash/);
    await expect(
      prepareFacialArtworkUpload(input(buffer, { guideSha256: 'e'.repeat(64) }))
    ).rejects.toThrow(/template identity/);
    await expect(
      prepareFacialArtworkUpload(input(buffer, { maskSha256: 'd'.repeat(64) }))
    ).rejects.toThrow(/template identity/);
    await expect(
      prepareFacialArtworkUpload(
        input(buffer, {
          orientation: 'anatomical-right',
          guideSha256: TEMPLATE.guide.sha256,
          maskSha256: TEMPLATE.safePaintMask.sha256
        })
      )
    ).rejects.toThrow(/does not support orientation anatomical-right/);
  });

  test('accepts left- and right-authored eye treatment variants as canonical bytes', async () => {
    const leftBuffer = await createPaintedTemplateFixture(LASHES_TEMPLATE);
    const leftResult = await prepareFacialArtworkUpload(lashesInput(leftBuffer));
    expect(leftResult.artwork.template).toMatchObject({
      orientation: 'anatomical-left',
      guideSha256: LASHES_TEMPLATE.guide.sha256,
      maskSha256: LASHES_TEMPLATE.safePaintMask.sha256
    });
    expect(leftResult.artwork.sha256).toBe(
      crypto.createHash('sha256').update(leftResult.buffer).digest('hex')
    );

    const decoded = await sharp(leftBuffer).raw().toBuffer({ resolveWithObject: true });
    const rightRgba = Buffer.alloc(decoded.data.length);
    for (let y = 0; y < decoded.info.height; y += 1) {
      for (let x = 0; x < decoded.info.width; x += 1) {
        const source = (y * decoded.info.width + (decoded.info.width - 1 - x)) * 4;
        const destination = (y * decoded.info.width + x) * 4;
        decoded.data.copy(rightRgba, destination, source, source + 4);
      }
    }
    const rightBuffer = await encodeCanonicalRgba(
      rightRgba,
      decoded.info.width,
      decoded.info.height
    );
    const rightResult = await prepareFacialArtworkUpload(
      lashesInput(rightBuffer, 'anatomical-right')
    );
    expect(rightResult.artwork.template).toMatchObject({
      orientation: 'anatomical-right',
      guideSha256: LASHES_TEMPLATE.mirroredHorizontalVariant.guide.sha256,
      maskSha256: LASHES_TEMPLATE.mirroredHorizontalVariant.safePaintMask.sha256
    });
    expect(rightResult.artwork.sha256).toBe(
      crypto.createHash('sha256').update(rightResult.buffer).digest('hex')
    );
  });

  test('normalizes AI-style PNG color metadata, hidden RGB, and safe-mask overflow', async () => {
    const irisTemplate = CONTRACT.templates.find((item) => item.id === 'iris-radial');
    const [width, height] = irisTemplate.dimensions;
    const rgba = Buffer.alloc(width * height * 4, 0);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      rgba[offset] = 18;
      rgba[offset + 1] = 201;
      rgba[offset + 2] = 166;
      rgba[offset + 3] = 255;
    }
    const aiStyle = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .withIccProfile('p3')
      .png({ progressive: false })
      .toBuffer();
    expect(chunkTypes(aiStyle)).not.toContain('sRGB');
    expect(chunkTypes(aiStyle)).toContain('iCCP');

    const prepared = await prepareFacialArtworkUpload(roleInput('iris', aiStyle));
    expect(chunkTypes(prepared.buffer)).toContain('sRGB');
    expect(chunkTypes(prepared.buffer)).not.toContain('iCCP');
    expect(prepared.preparation.colorSpaceNormalized).toBe(true);
    expect(prepared.preparation.clippedAlphaPixels).toBeGreaterThan(0);
    expect(prepared.preparation.clearedTransparentRgbPixels).toBeGreaterThan(0);
    const decoded = await sharp(prepared.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width, height, channels: 4, depth: 'uchar' });
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      if (decoded.data[offset + 3] === 0) {
        expect(decoded.data.subarray(offset, offset + 3)).toEqual(Buffer.alloc(3));
      }
    }
  });

  test('rejects a discontinuous upper/lower eye-treatment join', async () => {
    const buffer = await createPaintedTemplateFixture(LASHES_TEMPLATE);
    const decoded = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const rgba = Buffer.from(decoded.data);
    const { width, height } = decoded.info;
    const semanticBytes = fs.readFileSync(
      path.join(ROOT, 'batshit-app/static', LASHES_TEMPLATE.semanticMap.path)
    );
    const semantic = await sharp(semanticBytes).greyscale().raw().toBuffer();
    const lowerOuter = LASHES_TEMPLATE.semanticMap.palette.outer_lower_transition;
    for (let pixel = 0; pixel < semantic.length; pixel += 1) {
      if (semantic[pixel] === lowerOuter) {
        rgba.fill(0, pixel * 4, pixel * 4 + 4);
      }
    }
    const discontinuous = await encodeCanonicalRgba(rgba, width, height);
    await expect(prepareFacialArtworkUpload(lashesInput(discontinuous))).rejects.toThrow(
      /discontinuous outer canthus upper\/lower join/
    );
  });

  test('rejects transparent blanks, malformed provenance, and non-PNG bytes', async () => {
    const blank = fs.readFileSync(
      path.join(
        ROOT,
        'batshit-app/static',
        TEMPLATE.transparentBlank.path
      )
    );
    await expect(prepareFacialArtworkUpload(input(blank))).rejects.toThrow(/alpha is empty/);

    const fixture = await createPaintedTemplateFixture(TEMPLATE);
    await expect(
      prepareFacialArtworkUpload(
        input(fixture, {
          provenance: {
            sourceKind: 'user-authored',
            author: 'Fixture Artist',
            license: 'LicenseRef-User-Owned',
            rightsConfirmed: false
          }
        })
      )
    ).rejects.toThrow(/rightsConfirmed must be true/);
    await expect(prepareFacialArtworkUpload(input(Buffer.from('not a png')))).rejects.toThrow(
      /not a PNG/
    );
  });

  test('keeps template dimensions strict instead of silently resampling artwork', async () => {
    const wrongSize = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#ff00ffff' }
    })
      .png()
      .toBuffer();
    await expect(prepareFacialArtworkUpload(input(wrongSize))).rejects.toThrow(
      /exact 2048x1024 template dimensions/
    );
  });
});
