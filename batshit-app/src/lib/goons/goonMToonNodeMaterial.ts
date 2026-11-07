import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes'

/** Three r185 NodeMaterial.copy skips the inherited alphaTest accessor.
 * GLTFLoader clones tangent-less MToon materials, so preserve the authored
 * cutoff when that happens without changing any other material behavior. */
export class GoonMToonNodeMaterial extends MToonNodeMaterial {
  override copy(source: MToonNodeMaterial): this {
    super.copy(source)
    this.alphaTest = source.alphaTest
    return this
  }
}
