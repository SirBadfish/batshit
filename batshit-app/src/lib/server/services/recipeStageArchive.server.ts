import type { RecipeStoredAssetRef } from '$lib/goons/recipe/archiveContainmentContracts'
import { strictStoredZipEntries } from '$lib/goons/recipe/liveGoonBaker'

export class RecipeStageArchiveMismatchError extends Error {}

/** Fresh Stage only: all three stored files are independently read and hash
 * checked by readVerified. Canonical ZIP members may then share the archive's
 * immutable backing store. Never pass these views to a mutable migration hook. */
export async function readStageSourceArchiveBytes(
  assets: { archive: RecipeStoredAssetRef; model: RecipeStoredAssetRef; manifest: RecipeStoredAssetRef },
  readVerified: (asset: RecipeStoredAssetRef) => Promise<Uint8Array>
) {
  const packageBytes = await readVerified(assets.archive)
  let entries: Map<string, Uint8Array> | undefined
  try {
    entries = strictStoredZipEntries(packageBytes)
  } catch {
    // Authoring also supports compressed/noncanonical ZIPs. This only selects
    // storage ownership; the existing full builder still verifies those files.
  }
  if (!entries) {
    const [modelBytes, manifestBytes] = await Promise.all([
      readVerified(assets.model), readVerified(assets.manifest)
    ])
    return { packageBytes, modelBytes, manifestBytes }
  }
  const modelBytes = entries.get('avatar.glb')!
  const manifestBytes = entries.get('avatar.json')!
  // A private, void-returning scope prevents the independent fetched copy from
  // escaping into the long-lived construction inputs.
  async function verifyMember(asset: RecipeStoredAssetRef, member: Uint8Array) {
    const extracted = await readVerified(asset)
    let matches = member.byteLength === extracted.byteLength
    for (let index = 0; matches && index < member.byteLength; index += 1) {
      matches = member[index] === extracted[index]
    }
    if (!matches) {
      throw new RecipeStageArchiveMismatchError(`Stored Recipe asset ${asset.ref} differs from its archive member.`)
    }
  }
  await verifyMember(assets.model, modelBytes)
  await verifyMember(assets.manifest, manifestBytes)
  return { packageBytes, modelBytes, manifestBytes }
}
