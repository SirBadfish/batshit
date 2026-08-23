const GOON_PACKAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_GOON_PACKAGE_BYTES = 1024 * 1024 * 1024

type NativeGoonPackageSelection = {
  handleId: string
  name: string
  size: number
  mimeType: string
}

export type NativeGoonPackageDialogBridge = {
  openGoonPackage: () => Promise<NativeGoonPackageSelection | null>
  readGoonPackageChunk: (request: {
    handleId: string
    offset: number
    length: number
  }) => Promise<unknown>
  releaseGoonPackage: (handleId: string) => Promise<boolean>
}

type ZeroNativeApi = {
  dialogs?: Partial<NativeGoonPackageDialogBridge>
}

function resolveNativeBridge(): NativeGoonPackageDialogBridge | null {
  if (typeof window === 'undefined') return null
  const dialogs = (window as typeof window & { zero?: ZeroNativeApi }).zero?.dialogs
  if (
    typeof dialogs?.openGoonPackage !== 'function' ||
    typeof dialogs.readGoonPackageChunk !== 'function' ||
    typeof dialogs.releaseGoonPackage !== 'function'
  ) {
    return null
  }
  return dialogs as NativeGoonPackageDialogBridge
}

function validateSelection(value: NativeGoonPackageSelection): NativeGoonPackageSelection {
  if (
    !value ||
    typeof value.handleId !== 'string' ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.includes('/') ||
    value.name.includes('\\') ||
    value.name.includes('\0') ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_GOON_PACKAGE_BYTES ||
    value.mimeType !== 'application/zip'
  ) {
    throw new Error('The native Goon package picker returned invalid file metadata.')
  }
  const lowerName = value.name.toLowerCase()
  if (!lowerName.endsWith('.bgoon') && !lowerName.endsWith('.zip')) {
    throw new Error('Goon File Package must be a .bgoon or .zip archive.')
  }
  return value
}

function exactArrayBuffer(value: unknown, expectedBytes: number): ArrayBuffer {
  let bytes: Uint8Array
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value)
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  } else {
    throw new Error('The native Goon package picker returned an invalid file chunk.')
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('The selected Goon package changed before it could be read.')
  }
  return bytes.slice().buffer
}

export async function materializeNativeGoonPackageFile(
  bridge: NativeGoonPackageDialogBridge,
  rawSelection: NativeGoonPackageSelection
): Promise<File> {
  const releaseHandleId = typeof rawSelection?.handleId === 'string'
    ? rawSelection.handleId
    : null
  try {
    const selection = validateSelection(rawSelection)
    const parts: ArrayBuffer[] = []
    for (let offset = 0; offset < selection.size;) {
      const length = Math.min(GOON_PACKAGE_READ_CHUNK_BYTES, selection.size - offset)
      const chunk = await bridge.readGoonPackageChunk({
        handleId: selection.handleId,
        offset,
        length
      })
      parts.push(exactArrayBuffer(chunk, length))
      offset += length
    }
    return new File(parts, selection.name, {
      type: selection.mimeType,
      lastModified: Date.now()
    })
  } finally {
    if (releaseHandleId) {
      await bridge.releaseGoonPackage(releaseHandleId).catch(() => false)
    }
  }
}

/**
 * Returns undefined outside the packaged desktop bridge so callers can use a
 * normal browser file input, null when the native dialog is canceled, or the
 * exact user-selected package as a browser File.
 */
export async function pickGoonPackageFile(): Promise<File | null | undefined> {
  const bridge = resolveNativeBridge()
  if (!bridge) return undefined
  const selection = await bridge.openGoonPackage()
  if (!selection) return null
  return materializeNativeGoonPackageFile(bridge, selection)
}
