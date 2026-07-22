import * as THREE from 'three'
import {
  resolveOralAppearanceState,
  type OralAppearanceDefinitionV1,
  type OralAppearanceFamily,
  type OralAppearanceRgb,
  type OralAppearanceStateV1
} from './oralAppearance'

type OralMaterial = THREE.Material & {
  color: THREE.Color
  roughness: number
}

type RuntimeFamily = {
  material: OralMaterial
  baseColor: THREE.Color
  baseRoughness: number
}

function fail(message: string): never {
  throw new Error(`[oral-appearance/runtime] ${message}`)
}

function exactNamedObject(root: THREE.Object3D, name: string) {
  const matches: THREE.Object3D[] = []
  root.traverse((node) => {
    if (node.name === name) matches.push(node)
  })
  if (matches.length !== 1) {
    fail(`expected exactly one runtime object named ${name}, found ${matches.length}`)
  }
  return matches[0]
}

function oralMaterial(node: THREE.Object3D, expectedName: string) {
  const mesh = node as THREE.Mesh
  if (!mesh.isMesh) fail(`${node.name} must be a mesh`)
  if (Array.isArray(mesh.material)) fail(`${node.name} must use exactly one material`)
  const material = mesh.material as Partial<OralMaterial>
  if (material.name !== expectedName) {
    fail(`${node.name} must use ${expectedName}, found ${material.name || 'an unnamed material'}`)
  }
  if (!(material.color instanceof THREE.Color) || typeof material.roughness !== 'number') {
    fail(`${expectedName} must expose color and roughness controls`)
  }
  return material as OralMaterial
}

function stateColor(value: OralAppearanceRgb) {
  return new THREE.Color().setRGB(value[0], value[1], value[2], THREE.SRGBColorSpace)
}

function close(left: number, right: number) {
  return Math.abs(left - right) <= 1e-6
}

export class OralAppearanceEngineRuntime {
  private state: OralAppearanceStateV1
  private readonly families: Record<OralAppearanceFamily, RuntimeFamily>
  private disposed = false

  constructor(
    root: THREE.Object3D,
    readonly definition: OralAppearanceDefinitionV1,
    initialState: OralAppearanceStateV1 | null | undefined
  ) {
    this.state = resolveOralAppearanceState(definition, initialState)
    this.families = {
      teeth: this.bindFamily(root, 'teeth'),
      gums: this.bindFamily(root, 'gums'),
      tongue: this.bindFamily(root, 'tongue')
    }
    this.applyState()
  }

  private bindFamily(root: THREE.Object3D, family: OralAppearanceFamily): RuntimeFamily {
    const binding = this.definition.runtimeBindings[family]
    const materials = binding.nodes.map((name) =>
      oralMaterial(exactNamedObject(root, name), binding.material)
    )
    if (materials.some((material) => material !== materials[0])) {
      fail(`${family} nodes must share one exact material instance`)
    }
    const material = materials[0]
    const defaults = this.definition.materialDefaults[family]
    const expectedColor = stateColor(defaults.color)
    if (
      !close(material.color.r, expectedColor.r) ||
      !close(material.color.g, expectedColor.g) ||
      !close(material.color.b, expectedColor.b) ||
      !close(material.roughness, defaults.roughness)
    ) {
      fail(`${family} authored material defaults do not match avatar.json#oralAppearance`)
    }
    return {
      material,
      baseColor: material.color.clone(),
      baseRoughness: material.roughness
    }
  }

  getState() {
    return structuredClone(this.state)
  }

  setState(value: OralAppearanceStateV1 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    this.state = resolveOralAppearanceState(this.definition, value)
    this.applyState()
    return this.getState()
  }

  private applyState() {
    const teeth = this.families.teeth.material
    teeth.color.copy(stateColor(this.state.teeth.color)).multiplyScalar(this.state.teeth.brightness)
    teeth.roughness = 1 - this.state.teeth.shine

    this.families.gums.material.color.copy(stateColor(this.state.gums.color))
    this.families.tongue.material.color.copy(stateColor(this.state.tongue.color))
  }

  private restoreAuthoredMaterials() {
    for (const family of ['teeth', 'gums', 'tongue'] as const) {
      const runtime = this.families[family]
      runtime.material.color.copy(runtime.baseColor)
      runtime.material.roughness = runtime.baseRoughness
    }
  }

  dispose() {
    if (this.disposed) return
    this.restoreAuthoredMaterials()
    this.disposed = true
  }
}
