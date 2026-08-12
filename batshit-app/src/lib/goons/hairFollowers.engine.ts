import * as THREE from 'three'

import type { ResolvedAppearanceDialState } from './appearanceDials.contracts'
import {
  hairFollowerMorphNames,
  parseHairFollowerDefinition,
  resolveHairFollowerWeights,
  type HairFollowerDefinitionV1
} from './hairFollowers'

export type HairFollowerRuntimeHandle = {
  apply(state: Pick<ResolvedAppearanceDialState, 'values'>): void
  dispose(): void
}

type RuntimeMesh = {
  mesh: THREE.Mesh
  indexByName: Map<string, number>
}

function fail(message: string): never {
  throw new Error(`[hair-appearance-followers/v1] ${message}`)
}

export class HairFollowerEngineRuntime implements HairFollowerRuntimeHandle {
  readonly definition: HairFollowerDefinitionV1
  private readonly meshes: RuntimeMesh[]
  private disposed = false

  constructor(root: THREE.Object3D, definitionValue: HairFollowerDefinitionV1) {
    this.definition = parseHairFollowerDefinition(definitionValue)
    const expectedNames = hairFollowerMorphNames(this.definition)
    const expectedSet = new Set(expectedNames)
    const meshes: RuntimeMesh[] = []
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      const dictionary = object.morphTargetDictionary
      const influences = object.morphTargetInfluences
      if (!dictionary || !influences) {
        fail(`Hair mesh ${object.name || object.uuid} is missing its follower morph inventory`)
      }
      const actualNames = Object.keys(dictionary)
      if (
        actualNames.length !== expectedNames.length ||
        actualNames.some((name) => !expectedSet.has(name))
      ) {
        fail(`Hair mesh ${object.name || object.uuid} has a drifted follower morph inventory`)
      }
      const indexByName = new Map<string, number>()
      for (const name of expectedNames) {
        const index = dictionary[name]
        if (!Number.isSafeInteger(index) || index < 0 || index >= influences.length) {
          fail(`Hair mesh ${object.name || object.uuid} has no stable ${name} morph slot`)
        }
        indexByName.set(name, index)
      }
      meshes.push({ mesh: object, indexByName })
    })
    if (meshes.length === 0) fail('Hair follower geometry contains no meshes')
    this.meshes = meshes
  }

  apply(state: Pick<ResolvedAppearanceDialState, 'values'>): void {
    if (this.disposed) fail('cannot apply a disposed Hair follower runtime')
    const weights = resolveHairFollowerWeights(this.definition, state)
    for (const { mesh, indexByName } of this.meshes) {
      const influences = mesh.morphTargetInfluences
      if (!influences) fail(`Hair mesh ${mesh.name || mesh.uuid} lost its morph influences`)
      for (const [name, index] of indexByName) {
        const weight = weights.get(name)
        if (weight === undefined || !Number.isFinite(weight)) {
          fail(`Hair follower ${name} resolved an invalid runtime weight`)
        }
        influences[index] = weight
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { mesh, indexByName } of this.meshes) {
      const influences = mesh.morphTargetInfluences
      if (!influences) continue
      for (const index of indexByName.values()) influences[index] = 0
    }
  }
}
