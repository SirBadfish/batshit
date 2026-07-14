declare module 'three/addons/objects/GroundedSkybox.js' {
  import { Mesh, Texture } from 'three'

  export class GroundedSkybox extends Mesh {
    constructor(map: Texture, height: number, radius: number, resolution?: number)
  }
}
