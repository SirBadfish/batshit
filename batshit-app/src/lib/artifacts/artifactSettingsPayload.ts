/**
 * BL-546: Settings > Artifacts saves only the fields the user changed.
 *
 * The panel keeps the settings it hydrated from the loaded artifact as a baseline, built by the
 * same function that builds a save. A save sends a field only when its value now differs from
 * that baseline, so a field the user never touched is never written back from the panel's copy
 * (an agent's patch, an Agents > Access list, a Fabric field list saved after the panel opened
 * all stay as stored).
 *
 * `metadata` is compared key by key and only the changed keys are sent, because the server merges
 * a saved `metadata` over the stored one (`ArtifactsService.update`). A key the panel removed is
 * not sent: the merge could not remove it either, which is why the panel clears a key by saving
 * `null` (`applyArtifactPowerSourceToMetadata` does this for `runtime_manager`).
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
export function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry) => {
    if (!isPlainRecord(entry)) return entry
    return Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]]))
  })
}

function changedMetadataKeys(baseline: unknown, next: unknown): Record<string, unknown> | null {
  const before = isPlainRecord(baseline) ? baseline : {}
  const after = isPlainRecord(next) ? next : {}
  const changes: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(after)) {
    if (stableJson(value) !== stableJson(before[name])) changes[name] = value
  }
  return Object.keys(changes).length > 0 ? changes : null
}

/**
 * The fields of `next` whose values differ from `baseline`; `metadata` holds only its changed
 * keys and is left out when none changed. An empty object means there is nothing to save.
 */
export function changedArtifactSettingsFields(
  baseline: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(next)) {
    if (name === 'metadata') {
      const metadataChanges = changedMetadataKeys(baseline.metadata, value)
      if (metadataChanges) changed.metadata = metadataChanges
      continue
    }
    if (stableJson(value) !== stableJson(baseline[name])) changed[name] = value
  }
  return changed
}
