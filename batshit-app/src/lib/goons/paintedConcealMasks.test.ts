import { describe, expect, it } from 'vitest'
import {
  compressPaintedTriangleRanges,
  countPaintedConcealTriangles,
  expandPaintedTriangleRanges,
  normalizePaintedConcealMask,
  normalizePaintedTriangleIndices
} from './paintedConcealMasks'

describe('paintedConcealMasks', () => {
  it('normalizes triangle indices deterministically', () => {
    expect(normalizePaintedTriangleIndices([5, 1, 5, -1, 2.5, 3], 5)).toEqual([1, 3])
  })

  it('compresses and expands inclusive triangle ranges', () => {
    const ranges = compressPaintedTriangleRanges([7, 1, 2, 3, 9, 8])
    expect(ranges).toEqual([
      [1, 3],
      [7, 9]
    ])
    expect(expandPaintedTriangleRanges(ranges)).toEqual([1, 2, 3, 7, 8, 9])
  })

  it('drops invalid or stale mesh masks while preserving valid data', () => {
    const mask = normalizePaintedConcealMask({
      version: 1,
      topologySignature: 'topology:a',
      updatedAt: '2026-04-24T12:00:00.000Z',
      meshes: [
        {
          mesh: 'Body',
          topologySignature: 'mesh:a',
          triangleCount: 10,
          vertexCount: 6,
          triangleRanges: [
            [0, 2],
            [99, 100]
          ]
        },
        {
          mesh: '',
          topologySignature: 'mesh:b',
          triangleCount: 10,
          vertexCount: 6,
          triangleRanges: [[1, 1]]
        }
      ]
    })

    expect(mask).toEqual({
      version: 1,
      topologySignature: 'topology:a',
      updatedAt: '2026-04-24T12:00:00.000Z',
      meshes: [
        {
          mesh: 'Body',
          topologySignature: 'mesh:a',
          triangleCount: 10,
          vertexCount: 6,
          triangleRanges: [[0, 2]]
        }
      ]
    })
    expect(countPaintedConcealTriangles(mask)).toBe(3)
  })
})
