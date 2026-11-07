import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseHairBuiltinCatalog, type HairBuiltinCatalog } from '$lib/goons/hairBuiltinCatalog'

// This leaf verifies packaged identities, without Redis/lifecycle imports or
// reading geometry. Repository loading still verifies the actual asset files.
let catalogPromise: Promise<HairBuiltinCatalog> | null = null

export function loadHairBuiltinCatalogMetadata(): Promise<HairBuiltinCatalog> {
  if (!catalogPromise) {
    catalogPromise = readFile(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')
      .then((raw) => parseHairBuiltinCatalog(JSON.parse(raw)))
      .catch((error) => { catalogPromise = null; throw error })
  }
  return catalogPromise
}
