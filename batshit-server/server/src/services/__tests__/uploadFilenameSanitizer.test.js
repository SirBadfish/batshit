const uploadRouter = require('../../api/upload-redis');
const { zipSync, strToU8 } = require('fflate');

describe('upload filename sanitizer', () => {
  it('replaces spaces and unsafe characters while preserving the file extension', () => {
    expect(
      uploadRouter.buildSafeUploadFilename('Screen Shot 2026-03-15 at 11.44.00 AM.png', 'image')
    ).toBe('Screen_Shot_2026-03-15_at_11_44_00_AM.png');
  });

  it('falls back to a safe base name when the original name is empty or unusable', () => {
    expect(uploadRouter.buildSafeUploadFilename('   ', 'document')).toBe('document');
    expect(uploadRouter.buildSafeUploadFilename('***.txt', 'document')).toBe('document.txt');
  });
});

describe('upload content validation', () => {
  it('keeps core Goon import lanes on the same 600 MB cap', () => {
    expect(uploadRouter.GOON_CORE_IMPORT_MAX_FILE_SIZE).toBe(600 * 1024 * 1024);
    expect(uploadRouter.getUploadLimitForPath('/upload/goon')).toBe(
      uploadRouter.GOON_CORE_IMPORT_MAX_FILE_SIZE
    );
    expect(uploadRouter.getUploadLimitForPath('/upload/goon-guided-package')).toBe(
      uploadRouter.GOON_CORE_IMPORT_MAX_FILE_SIZE
    );
    expect(uploadRouter.getUploadLimitForPath('/upload/goon-custom-package')).toBe(
      uploadRouter.GOON_CORE_IMPORT_MAX_FILE_SIZE
    );
  });

  it('accepts images only when the extension matches the file signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    expect(() =>
      uploadRouter.validateGenericUploadFile({
        originalname: 'example.png',
        mimetype: 'image/png',
        buffer: png
      })
    ).not.toThrow();

    expect(() =>
      uploadRouter.validateGenericUploadFile({
        originalname: 'example.jpg',
        mimetype: 'image/jpeg',
        buffer: png
      })
    ).toThrow(/extension does not match/i);
  });

  it('rejects generic archive uploads so archives use dedicated package routes', () => {
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);

    expect(() =>
      uploadRouter.validateGenericUploadFile({
        originalname: 'files.zip',
        mimetype: 'application/zip',
        buffer: archive
      })
    ).toThrow(/dedicated Batshit package upload endpoint/i);
  });

  it('rejects unsupported files inside Goon archives before extracting them', () => {
    const archive = Buffer.from(
      zipSync({
        'avatar.json': strToU8(JSON.stringify({ name: 'Test' })),
        'avatar.vrm': new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
        'nested/extra.txt': strToU8('nope')
      })
    );

    expect(() =>
      uploadRouter.readConstrainedGoonArchiveEntries(archive, {
        laneLabel: 'Advanced/Blender Goon',
        allowedBasenames: ['avatar.json', 'avatar.vrm'],
        maxUncompressedBytes: 1024 * 1024
      })
    ).toThrow(/unsupported files/i);
  });
});

describe('guided outfit manifest parsing', () => {
  it('preserves material and conceal metadata for guided outfit pieces', () => {
    const outfit = uploadRouter.parseGuidedOutfitData({
      outfit: {
        pieces: [
          {
            id: 'athleisure_top',
            label: 'Athleisure Top',
            runtimeNodeNames: ['mesh_Athleisure_Top'],
            defaultOn: false,
            materialNames: ['Athleisure_Top_Kiln_Baked', ''],
            concealRegions: ['upper_belly', 'upper_back', 'upper_belly']
          }
        ],
        presets: [
          {
            id: 'none',
            name: 'None',
            piecesOff: ['athleisure_top']
          }
        ]
      }
    });

    expect(outfit.pieces).toEqual([
      {
        id: 'athleisure_top',
        label: 'Athleisure Top',
        runtimeNodeNames: ['mesh_Athleisure_Top'],
        defaultOn: false,
        materialNames: ['Athleisure_Top_Kiln_Baked'],
        concealRegions: ['upper_belly', 'upper_back']
      }
    ]);
    expect(outfit.presets).toEqual([
      {
        id: 'none',
        name: 'None',
        piecesOff: ['athleisure_top']
      }
    ]);
  });
});
