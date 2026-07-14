import * as THREE from 'three'

/**
 * Body conceal mutates triangle indices, so its base geometry must be owned by
 * the runtime mesh. Morph payloads are immutable authoring inputs, however,
 * and cloning hundreds of large attributes is catastrophic in WKWebView.
 * Share those BufferAttribute objects until the appearance runtime captures
 * and removes them; keep the morph arrays themselves separate so either
 * geometry may replace its inventory without mutating the other.
 */
export function cloneGeometryForBodyConceal(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const morphAttributes = source.morphAttributes
  source.morphAttributes = {}
  let cloned: THREE.BufferGeometry
  try {
    cloned = source.clone()
  } finally {
    source.morphAttributes = morphAttributes
  }

  for (const attributeName of ['position', 'normal', 'color'] as const) {
    const attributes = morphAttributes[attributeName]
    if (attributes) cloned.morphAttributes[attributeName] = [...attributes]
  }
  cloned.morphTargetsRelative = source.morphTargetsRelative
  return cloned
}
