export type BinaryInput = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>
export type OwnedBytes = Uint8Array<ArrayBuffer>

export function toOwnedBytes(input: BinaryInput): OwnedBytes {
  if (
    input instanceof Uint8Array &&
    input.buffer instanceof ArrayBuffer &&
    input.byteOffset === 0 &&
    input.byteLength === input.buffer.byteLength
  ) {
    return input as OwnedBytes
  }

  const view = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)

  return Uint8Array.from(view)
}

export function bytesToBlob(input: BinaryInput, options?: BlobPropertyBag): Blob {
  return new Blob([toOwnedBytes(input)], options)
}

export function bytesToFile(input: BinaryInput, name: string, options?: FilePropertyBag): File {
  return new File([toOwnedBytes(input)], name, options)
}
