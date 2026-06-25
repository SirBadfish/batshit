import type { GoonRoomTexture } from '$lib/types/goons'

export const BUILTIN_TRIM_TEXTURES: GoonRoomTexture[] = [
  {
    kind: 'trim',
    filename: 'builtin_trim_concrete.svg',
    originalName: 'Built-in: Concrete',
    url: '/goons/trim/trim-concrete.svg',
    mimeType: 'image/svg+xml'
  },
  {
    kind: 'trim',
    filename: 'builtin_trim_metal.svg',
    originalName: 'Built-in: Metal',
    url: '/goons/trim/trim-metal.svg',
    mimeType: 'image/svg+xml'
  },
  {
    kind: 'trim',
    filename: 'builtin_trim_wood.svg',
    originalName: 'Built-in: Wood',
    url: '/goons/trim/trim-wood.svg',
    mimeType: 'image/svg+xml'
  }
]

export const DEFAULT_TRIM_TEXTURE = BUILTIN_TRIM_TEXTURES[0]
