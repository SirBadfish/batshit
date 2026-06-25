import type {
  GoonFileRef,
  GoonRoomShellBuilder,
  GoonRoomSurface,
  GoonRoomSurfaceSide
} from '$lib/types/goons'

export const ROOM_DEFAULT_SIZE = 13.5
export const ROOM_DEFAULT_HEIGHT = ROOM_DEFAULT_SIZE * (1200 / 2048)
export const ROOM_MIN_HEIGHT = ROOM_DEFAULT_HEIGHT * 0.5
export const ROOM_LOW_CEILING = ROOM_DEFAULT_HEIGHT * 0.8
export const ROOM_HEIGHT_PRESET_VALUES = [100, 75, 50] as const
export type RoomHeightPresetValue = (typeof ROOM_HEIGHT_PRESET_VALUES)[number]
export const ROOM_HEIGHT_PRESET_SPECS: Record<RoomHeightPresetValue, string> = {
  100: '2048x1200',
  75: '2048x900',
  50: '2048x600'
}

const ROOM_HEIGHT_PRESET_HEIGHTS: Record<RoomHeightPresetValue, number> = {
  100: ROOM_DEFAULT_HEIGHT,
  75: ROOM_DEFAULT_HEIGHT * 0.75,
  50: ROOM_DEFAULT_HEIGHT * 0.5
}

function normalizeRoomHeightPresetValue(value?: number | null): RoomHeightPresetValue {
  const numeric = Number.isFinite(value) ? Number(value) : 100
  if (numeric === 75) return 75
  if (numeric === 50) return 50
  return 100
}

function clampRoomHeight(height: number) {
  return roomPresetValueToHeight(roomHeightToPresetValue(height))
}

export function roomHeightToPresetValue(height?: number | null): RoomHeightPresetValue {
  const resolved = Number.isFinite(height) ? Number(height) : ROOM_DEFAULT_HEIGHT
  let closestPreset: RoomHeightPresetValue = 100
  let closestDelta = Math.abs(resolved - ROOM_HEIGHT_PRESET_HEIGHTS[closestPreset])

  for (const preset of ROOM_HEIGHT_PRESET_VALUES) {
    const delta = Math.abs(resolved - ROOM_HEIGHT_PRESET_HEIGHTS[preset])
    if (delta < closestDelta) {
      closestPreset = preset
      closestDelta = delta
    }
  }

  return closestPreset
}

export function roomPresetValueToHeight(value?: number | null) {
  const preset = normalizeRoomHeightPresetValue(value)
  return ROOM_HEIGHT_PRESET_HEIGHTS[preset]
}

export function roomHeightToPercent(height?: number | null) {
  return roomHeightToPresetValue(height)
}

export function createDefaultRoomSurfaceSide(
  overrides: Partial<GoonRoomSurfaceSide> = {}
): GoonRoomSurfaceSide {
  const tileScale = Array.isArray(overrides.tileScale) ? overrides.tileScale : [1, 1]
  const fit = overrides.fit === 'stretch' ? 'stretch' : 'tile'
  const transparency =
    overrides.transparency === 'cutout' || overrides.transparency === 'glass'
      ? overrides.transparency
      : 'opaque'
  return {
    texture: overrides.texture,
    trimTexture: overrides.trimTexture,
    fit,
    tileScale: [
      Number.isFinite(tileScale[0]) && tileScale[0] > 0 ? tileScale[0] : 1,
      Number.isFinite(tileScale[1]) && tileScale[1] > 0 ? tileScale[1] : 1
    ],
    transparency,
    opacity: overrides.opacity
  }
}

export function createDefaultRoomSurface(
  overrides: Partial<GoonRoomSurface> = {}
): GoonRoomSurface {
  const { enabled, interior, exterior, ...legacy } = overrides as GoonRoomSurface & GoonRoomSurfaceSide
  const interiorSide = createDefaultRoomSurfaceSide({ ...(legacy ?? {}), ...(interior ?? {}) })
  const exteriorSide = createDefaultRoomSurfaceSide({ ...(exterior ?? {}) })
  return {
    enabled: enabled ?? true,
    interior: interiorSide,
    exterior: exteriorSide
  }
}

export function normalizeRoomShellBuilder(
  builder?: GoonRoomShellBuilder | null
): GoonRoomShellBuilder {
  const base: GoonRoomShellBuilder = builder ? JSON.parse(JSON.stringify(builder)) : {}
  const legacy = base as GoonRoomShellBuilder & {
    layout?: string
    floorTexture?: GoonFileRef
    wallTexture?: GoonFileRef
    ceilingTexture?: GoonFileRef
    exteriorTexture?: GoonFileRef
  }

  const layout = legacy.layout
  const usingLegacyLayout = Boolean(layout)
  const wallEnabled: Record<'north' | 'south' | 'east' | 'west', boolean> = {
    north: true,
    south: true,
    east: true,
    west: true
  }
  let ceilingEnabled = true

  if (usingLegacyLayout) {
    wallEnabled.north = false
    wallEnabled.south = false
    wallEnabled.east = false
    wallEnabled.west = false
    ceilingEnabled = false
    if (layout === 'floor_2_walls' || layout === 'floor_2_walls_ceiling') {
      wallEnabled.north = true
      wallEnabled.east = true
    } else if (layout === 'floor_3_walls' || layout === 'floor_3_walls_ceiling') {
      wallEnabled.north = true
      wallEnabled.east = true
      wallEnabled.west = true
    }
    if (layout === 'floor_2_walls_ceiling' || layout === 'floor_3_walls_ceiling') {
      ceilingEnabled = true
    }
  }

  const surfaces = base.surfaces ?? {}
  const wallSurfaces = surfaces.walls ?? {}
  const fallbackExterior = legacy.exteriorTexture

  const floor = createDefaultRoomSurface({
    ...(surfaces.floor ?? {}),
    interior: {
      ...(surfaces.floor?.interior ?? {}),
      texture:
        surfaces.floor?.interior?.texture ??
        (surfaces.floor as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.floorTexture
    },
    exterior: {
      ...(surfaces.floor?.exterior ?? {}),
      texture: surfaces.floor?.exterior?.texture ?? fallbackExterior
    }
  })
  const ceiling = createDefaultRoomSurface({
    ...(surfaces.ceiling ?? {}),
    enabled: surfaces.ceiling?.enabled ?? ceilingEnabled,
    interior: {
      ...(surfaces.ceiling?.interior ?? {}),
      texture:
        surfaces.ceiling?.interior?.texture ??
        (surfaces.ceiling as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.ceilingTexture
    },
    exterior: {
      ...(surfaces.ceiling?.exterior ?? {}),
      texture: surfaces.ceiling?.exterior?.texture ?? fallbackExterior
    }
  })
  const north = createDefaultRoomSurface({
    ...(wallSurfaces.north ?? {}),
    enabled: wallSurfaces.north?.enabled ?? wallEnabled.north,
    interior: {
      ...(wallSurfaces.north?.interior ?? {}),
      texture:
        wallSurfaces.north?.interior?.texture ??
        (wallSurfaces.north as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.wallTexture
    },
    exterior: {
      ...(wallSurfaces.north?.exterior ?? {}),
      texture: wallSurfaces.north?.exterior?.texture ?? fallbackExterior
    }
  })
  const south = createDefaultRoomSurface({
    ...(wallSurfaces.south ?? {}),
    enabled: wallSurfaces.south?.enabled ?? wallEnabled.south,
    interior: {
      ...(wallSurfaces.south?.interior ?? {}),
      texture:
        wallSurfaces.south?.interior?.texture ??
        (wallSurfaces.south as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.wallTexture
    },
    exterior: {
      ...(wallSurfaces.south?.exterior ?? {}),
      texture: wallSurfaces.south?.exterior?.texture ?? fallbackExterior
    }
  })
  const east = createDefaultRoomSurface({
    ...(wallSurfaces.east ?? {}),
    enabled: wallSurfaces.east?.enabled ?? wallEnabled.east,
    interior: {
      ...(wallSurfaces.east?.interior ?? {}),
      texture:
        wallSurfaces.east?.interior?.texture ??
        (wallSurfaces.east as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.wallTexture
    },
    exterior: {
      ...(wallSurfaces.east?.exterior ?? {}),
      texture: wallSurfaces.east?.exterior?.texture ?? fallbackExterior
    }
  })
  const west = createDefaultRoomSurface({
    ...(wallSurfaces.west ?? {}),
    enabled: wallSurfaces.west?.enabled ?? wallEnabled.west,
    interior: {
      ...(wallSurfaces.west?.interior ?? {}),
      texture:
        wallSurfaces.west?.interior?.texture ??
        (wallSurfaces.west as GoonRoomSurfaceSide | undefined)?.texture ??
        legacy.wallTexture
    },
    exterior: {
      ...(wallSurfaces.west?.exterior ?? {}),
      texture: wallSurfaces.west?.exterior?.texture ?? fallbackExterior
    }
  })

  return {
    width: Number.isFinite(base.width) && (base.width ?? 0) > 0 ? base.width : ROOM_DEFAULT_SIZE,
    depth: Number.isFinite(base.depth) && (base.depth ?? 0) > 0 ? base.depth : ROOM_DEFAULT_SIZE,
    height: clampRoomHeight(
      Number.isFinite(base.height) && (base.height ?? 0) > 0 ? Number(base.height) : ROOM_DEFAULT_HEIGHT
    ),
    floorOffsetY: Number.isFinite(base.floorOffsetY) ? base.floorOffsetY : 0,
    surfaces: {
      floor,
      ceiling,
      walls: { north, south, east, west }
    }
  }
}
