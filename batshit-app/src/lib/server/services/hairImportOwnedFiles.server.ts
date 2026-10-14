import { HAIR_IMPORT_UPLOAD_RECEIPT_CONTRACT, type HairImportUploadOwner } from "./hairImportCandidateIdentity";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { HairAssetFileRefV1 } from "$lib/goons/hairAssets";
import { canonicalRecipeString } from "$lib/goons/recipe/recipeCanonical";
import type { HairImportOwnedFile } from "./hairImportJobRepository.server";
import { deleteGoonUploadAssetDisposition } from './goonAssetCleanupService'
import { isDiscoveredHairCleanupFile, type HairCleanupContext } from './hairCleanupContext'
import { hairCleanupContextForTransport } from './hairCleanupTransport.server'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
} from "./batshitServerUrls";

type HairArtifactRole =
  | "geometry"
  | "follower-definition"
  | "physics-definition"
  | "material-definition"
  | "neutral-value"
  | "highlight-mask"
  | "normal"
  | "roughness"
  | "preview"
  | "import-receipt"
  | "fit-receipt"
  | "refit-source";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(parts: readonly Uint8Array[]) {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const payload = concat([typeBytes, data]);
  return concat([u32(data.byteLength), payload, u32(crc32(payload))]);
}

export function createHairImportTexturePng(
  kind: "neutral-value" | "highlight-mask",
  width = 64,
  height = 64,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 256 ||
    height > 256
  ) {
    throw new Error(
      "Hair import generated texture dimensions must be between 2 and 256 pixels.",
    );
  }
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      // UV.u crosses an authored lock; UV.v follows its length. Most of the
      // lock stays Base, with one soft Highlight streak instead of tinting
      // opposite sides of the entire wig with a global gradient.
      const distance = Math.abs(x / (width - 1) - 0.5);
      const transition = Math.min(1, Math.max(0, (0.18 - distance) / 0.1));
      const streak = transition * transition * (3 - 2 * transition);
      const value = kind === "neutral-value" ? 128 : Math.round(streak * 255);
      scanlines[offset] = value;
      scanlines[offset + 1] = value;
      scanlines[offset + 2] = value;
      scanlines[offset + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(scanlines, { level: 9 }))),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

export function strictJsonBytes(value: unknown) {
  const text = canonicalRecipeString(value);
  if (!text || text === "null" || text[0] !== "{") {
    throw new Error("Hair import artifact must serialize to one JSON object.");
  }
  return new TextEncoder().encode(`${text}\n`);
}

function responseError(status: number, body: string) {
  return new Error(
    `batshit-server rejected Hair import storage (${status}): ${body}`,
  );
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function stageHairImportSource(input: {
  originalName: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<HairImportOwnedFile & { originalName: string }> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([ownedArrayBuffer(input.bytes)], { type: input.mimeType }),
    input.originalName,
  );
  const response = await fetch(
    `${getInternalBatshitServerUrl()}/api/upload/goon-hair-import-source`,
    {
      method: "POST",
      headers: getInternalBatshitServerAuthHeaders(),
      body: form,
    },
  );
  if (!response.ok) throw responseError(response.status, await response.text());
  const body = (await response.json()) as { file?: Record<string, unknown> };
  const file = body.file;
  if (
    !file ||
    typeof file.filename !== "string" ||
    typeof file.sha256 !== "string"
  ) {
    throw new Error(
      "batshit-server returned an invalid Hair import source receipt.",
    );
  }
  return {
    uploadType: "goon_hair_imports",
    filename: file.filename,
    originalName: input.originalName,
    ref: `/uploads/goon_hair_imports/${file.filename}`,
    sha256: file.sha256,
    bytes: Number(file.size),
    mimeType: input.mimeType,
  };
}

export async function stageHairImportPreviewGeometry(
  bytes: Uint8Array,
): Promise<HairImportOwnedFile> {
  const staged = await stageHairImportSource({
    originalName: "inspection-preview.glb",
    bytes,
    mimeType: "model/gltf-binary",
  });
  return {
    uploadType: staged.uploadType,
    filename: staged.filename,
    ref: staged.ref,
    sha256: staged.sha256,
    bytes: staged.bytes,
    mimeType: staged.mimeType,
  };
}

export async function storeHairAssetArtifact(input: {
  assetId: string;
  revisionId: string;
  role: HairArtifactRole;
  importOwner?: HairImportUploadOwner & { stateVersion: number };
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<HairImportOwnedFile> {
  const expectedSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const form = new FormData();
  form.set("assetId", input.assetId);
  form.set("revisionId", input.revisionId);
  form.set("role", input.role);
  if (input.importOwner) {
    form.set("hairImportOwner", JSON.stringify({
      contract: HAIR_IMPORT_UPLOAD_RECEIPT_CONTRACT,
      userId: input.importOwner.userId,
      jobId: input.importOwner.jobId,
    }));
    form.set("hairImportStateVersion", String(input.importOwner.stateVersion));
  }
  form.set(
    "file",
    new Blob([ownedArrayBuffer(input.bytes)], { type: input.mimeType }),
    input.filename,
  );
  const response = await fetch(
    `${getInternalBatshitServerUrl()}/api/upload/goon-hair-asset`,
    {
      method: "POST",
      headers: getInternalBatshitServerAuthHeaders(),
      body: form,
    },
  );
  if (!response.ok) throw responseError(response.status, await response.text());
  const body = (await response.json()) as { file?: Record<string, unknown> };
  const file = body.file;
  if (
    !file ||
    typeof file.filename !== "string" ||
    file.sha256 !== expectedSha256 ||
    Number(file.size) !== input.bytes.byteLength
  ) {
    throw new Error(
      "batshit-server returned an invalid Hair Asset artifact receipt.",
    );
  }
  return {
    uploadType: "goon_hair_assets",
    filename: file.filename,
    ref: `/uploads/goon_hair_assets/${file.filename}`,
    sha256: expectedSha256,
    bytes: input.bytes.byteLength,
    mimeType: input.mimeType,
  };
}

export async function readHairImportOwnedFile(file: HairImportOwnedFile) {
  const response = await fetch(`${getInternalBatshitServerUrl()}${file.ref}`, {
    headers: getInternalBatshitServerAuthHeaders(),
  });
  if (!response.ok) throw responseError(response.status, await response.text());
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== file.bytes || hash !== file.sha256) {
    throw new Error(
      `Stored Hair import file ${file.ref} no longer matches its staging receipt.`,
    );
  }
  return bytes;
}

export async function deleteHairImportOwnedFile(
  file: Pick<HairImportOwnedFile, "uploadType" | "filename">,
  cleanupContext?: HairCleanupContext,
) {
  return deleteGoonUploadAssetDisposition(file.uploadType, file.filename, cleanupContext)

}

/** Join the actual publication queue before looking for an upload whose
 * response was lost. The caller records this exact subset before deletion. */
export async function discoverHairImportCleanupFiles(cleanupContext: HairCleanupContext): Promise<HairImportOwnedFile[]> {
  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset-deletion/discover-hair-import`, {
    method: 'POST', headers: { ...getInternalBatshitServerAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cleanupContext: hairCleanupContextForTransport(cleanupContext) })
  })
  if (!response.ok) throw responseError(response.status, await response.text())
  const payload = await response.json()
  if (!Array.isArray(payload?.files) || payload.files.length > 4096 || !payload.files.every(isDiscoveredHairCleanupFile)) {
    throw new Error('Hair cleanup discovery returned an invalid file list. Retry without changing the saved job.')
  }
  return payload.files
}

export function hairAssetFileRef(
  file: HairImportOwnedFile,
): HairAssetFileRefV1 {
  return {
    ref: file.ref,
    sha256: file.sha256,
    bytes: file.bytes,
    mimeType: file.mimeType,
  };
}
