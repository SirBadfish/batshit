import { describe, expect, it, vi } from 'vitest'

import {
  materializeNativeGoonPackageFile,
  type NativeGoonPackageDialogBridge
} from './goonPackageFilePicker'

function bridgeFor(chunks: Uint8Array[]): NativeGoonPackageDialogBridge {
  let index = 0
  return {
    openGoonPackage: vi.fn(),
    readGoonPackageChunk: vi.fn(async () => chunks[index++] ?? new Uint8Array()),
    releaseGoonPackage: vi.fn(async () => true)
  }
}

describe('native Goon package file picker', () => {
  it('reassembles the exact selected bytes and always releases the opaque handle', async () => {
    const bridge = bridgeFor([new Uint8Array([1, 2, 3, 4])])
    const file = await materializeNativeGoonPackageFile(bridge, {
      handleId: '123e4567-e89b-42d3-a456-426614174000',
      name: 'Batshit Base.bgoon',
      size: 4,
      mimeType: 'application/zip'
    })

    expect(file.name).toBe('Batshit Base.bgoon')
    expect(file.type).toBe('application/zip')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4])
    expect(bridge.readGoonPackageChunk).toHaveBeenCalledWith({
      handleId: '123e4567-e89b-42d3-a456-426614174000',
      offset: 0,
      length: 4
    })
    expect(bridge.releaseGoonPackage).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000'
    )
  })

  it('fails loudly on a short read and still releases the native file', async () => {
    const bridge = bridgeFor([new Uint8Array([1, 2, 3])])
    await expect(materializeNativeGoonPackageFile(bridge, {
      handleId: '123e4567-e89b-42d3-a456-426614174000',
      name: 'candidate.zip',
      size: 4,
      mimeType: 'application/zip'
    })).rejects.toThrow('changed before it could be read')
    expect(bridge.releaseGoonPackage).toHaveBeenCalledOnce()
  })

  it('rejects unexpected metadata before reading package bytes', async () => {
    const bridge = bridgeFor([])
    await expect(materializeNativeGoonPackageFile(bridge, {
      handleId: '123e4567-e89b-42d3-a456-426614174000',
      name: '../secret.txt',
      size: 10,
      mimeType: 'text/plain'
    })).rejects.toThrow('invalid file metadata')
    expect(bridge.readGoonPackageChunk).not.toHaveBeenCalled()
    expect(bridge.releaseGoonPackage).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000'
    )
  })
})
