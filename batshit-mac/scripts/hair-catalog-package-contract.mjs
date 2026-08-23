export const HAIR_CATALOG_PACKAGE_CONTRACT = Object.freeze({
  contract: 'hair-catalog/v2',
  runtimeRoot: 'batshit-app/static/goon-assets/hair',
  definition: 'v2/catalog.json',
  schemaVersion: 'hair-catalog/v2'
});

export function validateHairCatalogPackageDefinition(value) {
  const keys = value && typeof value === 'object' ? Object.keys(value).sort() : [];
  if (
    value?.schemaVersion !== HAIR_CATALOG_PACKAGE_CONTRACT.schemaVersion ||
    !Array.isArray(value?.assets) ||
    !Array.isArray(value?.currentRevisions) ||
    !Array.isArray(value?.successorEdges) ||
    keys.join(',') !== 'assets,currentRevisions,schemaVersion,successorEdges'
  ) {
    throw new Error('Hair Asset package input contains an invalid hair-catalog/v2 catalog.');
  }
  return value;
}
