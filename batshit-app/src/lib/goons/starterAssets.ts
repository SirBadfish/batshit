export type StarterGoonAsset = {
  id: string
  name: string
  description: string
  filename: string
  downloadUrl: string
}

const STARTER_GOON_DOWNLOAD_BASE_URL = 'https://batshit.ai/downloads/goons'

export const STARTER_GOON_ASSETS = [
  {
    id: 'starter_vroid',
    name: 'Starter Goon (VRoid)',
    description: 'Downloadable VRoid placeholder with default cues.',
    filename: 'starter-vroid.vrm',
    downloadUrl: `${STARTER_GOON_DOWNLOAD_BASE_URL}/starter-vroid.vrm`
  }
] satisfies StarterGoonAsset[]

export function resolveStarterGoonAsset(id: string | null | undefined) {
  if (!id) return null
  return STARTER_GOON_ASSETS.find((asset) => asset.id === id) ?? null
}
