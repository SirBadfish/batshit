/** Fixed reserved subtrees in the existing single whole-Settings write. Never a generic path writer. */
export function serializeUserSettingsReservedLiterals(
  settings: Record<string, unknown>,
  literals: { admin?: string; legacyCloset?: string } = {}
): string {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('The Settings postimage is unavailable.')
  const root = { ...settings }, additions: string[] = []
  if (literals.admin !== undefined) {
    const decoded: unknown = JSON.parse(literals.admin)
    if (decoded !== null && (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))) throw new Error('The Admin Settings literal is unavailable.')
    delete root.admin_settings
    additions.push(`"admin_settings":${literals.admin}`)
  }
  if (literals.legacyCloset !== undefined && literals.legacyCloset !== '') {
    JSON.parse(literals.legacyCloset) // Validate syntax without reserializing its numeric representation.
    const value = root.goons_settings
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Goon Settings postimage is unavailable.')
    const goons = { ...value } as Record<string, unknown>
    delete root.goons_settings
    delete goons.globalCloset
    const plain = JSON.stringify(goons)
    additions.push(`"goons_settings":${plain.slice(0, -1)}${plain === '{}' ? '' : ','}"globalCloset":${literals.legacyCloset}}`)
  }
  const plain = JSON.stringify(root)
  return additions.length ? `${plain.slice(0, -1)}${plain === '{}' ? '' : ','}${additions.join(',')}}` : plain
}
