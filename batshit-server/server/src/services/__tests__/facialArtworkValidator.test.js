const fs = require('fs');
const path = require('path');
const {
  clearFacialArtworkContractCacheForTests,
  validateFacialArtworkUpload
} = require('../facialArtworkValidator');

const ROOT = path.resolve(__dirname, '../../../../..');
const CONTRACT = require(path.join(
  ROOT,
  'batshit-app/static/goons/facial-artwork/v2/facial-artwork-v2.json'
));
const TEMPLATE = CONTRACT.templates.find((item) => item.id === 'brow-canvas');
const FIXTURE_ROOT = path.join(
  ROOT,
  '_private/dev-doc/architecture/deep-dives/makehuman/facial-artwork/v2',
  'batshit-base-f-v2/fixtures/round-trip'
);

function input(buffer, overrides = {}) {
  return {
    buffer,
    role: 'brows',
    definitionSha256: CONTRACT.definitionSha256,
    templateId: TEMPLATE.id,
    templateVersion: TEMPLATE.version,
    guideSha256: TEMPLATE.guide.sha256,
    provenance: {
      sourceKind: 'user-authored',
      author: 'Fixture Artist',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    },
    ...overrides
  };
}

describe('facialArtworkValidator', () => {
  beforeEach(() => {
    clearFacialArtworkContractCacheForTests();
  });

  test('accepts the exact positive edit-kit bytes and returns their SHA-256', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURE_ROOT, 'brow-canvas.png'));
    await expect(validateFacialArtworkUpload(input(buffer))).resolves.toMatchObject({
      role: 'brows',
      definitionSha256: CONTRACT.definitionSha256,
      sha256: '4275a2e38633056ff58a45775e2640d6b035a40deb6c6d0c33629b5e077f91e1',
      width: 2048,
      height: 1024,
      mimeType: 'image/png'
    });
  });

  test('rejects stale definitions and wrong template identity', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURE_ROOT, 'brow-canvas.png'));
    await expect(
      validateFacialArtworkUpload(input(buffer, { definitionSha256: 'f'.repeat(64) }))
    ).rejects.toThrow(/does not match the current template definition/);
    await expect(
      validateFacialArtworkUpload(input(buffer, { guideSha256: 'e'.repeat(64) }))
    ).rejects.toThrow(/template identity/);
  });

  test('rejects transparent blanks, malformed provenance, and non-PNG bytes', async () => {
    const blank = fs.readFileSync(
      path.join(
        ROOT,
        'batshit-app/static/goons/facial-artwork/v2/batshit-base-f-v2/blanks/brow-canvas.png'
      )
    );
    await expect(validateFacialArtworkUpload(input(blank))).rejects.toThrow(/alpha is empty/);

    const fixture = fs.readFileSync(path.join(FIXTURE_ROOT, 'brow-canvas.png'));
    await expect(
      validateFacialArtworkUpload(
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
    await expect(validateFacialArtworkUpload(input(Buffer.from('not a png')))).rejects.toThrow(
      /not a PNG/
    );
  });
});
