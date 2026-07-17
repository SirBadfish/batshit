import {
  verifyRecipePackageMetadata,
  type RecipeUpdateEdge,
} from "./updateContracts";
import { canonicalRecipeString, sha256Hex } from "./recipeCanonical";
import { parseRecipeSource, type RecipeSource } from "./recipeContracts";
import type { RecipeSourceIdentity } from "./packageMetadata";
import { verifyRecipeSourceProjectionHashes } from "./sourcePackageProjections";

export const RECIPE_SOURCE_RAW_ASSET_PROOF_CONTRACT =
  "recipe-source-raw-asset-proof/v1" as const;

export type RecipeSourceRawAssetInput = {
  packageBytes: Uint8Array;
  modelBytes: Uint8Array;
  manifestBytes: Uint8Array;
};

export type VerifiedRecipeSourceRawAssets = {
  contract: typeof RECIPE_SOURCE_RAW_ASSET_PROOF_CONTRACT;
  source: RecipeSource;
  manifest: Record<string, unknown>;
  packageSha256: string;
  modelSha256: string;
  manifestSha256: string;
};

function fail(message: string): never {
  throw new Error(`[${RECIPE_SOURCE_RAW_ASSET_PROOF_CONTRACT}] ${message}`);
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    "BYTES_PER_ELEMENT" in value &&
    value.BYTES_PER_ELEMENT === 1
  );
}

function nonEmptyBytes(value: unknown, context: string): Uint8Array {
  if (!isByteArray(value) || value.byteLength === 0) {
    fail(`${context} must be a non-empty byte array`);
  }
  return value;
}

function parseManifestBytes(value: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    );
  } catch {
    fail("manifest bytes must be strict UTF-8 JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))
  ) {
    fail("manifest bytes must decode to a plain JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Bind one external Recipe Source record to the exact three byte assets that
 * R2 analyzes. Archive extraction/containment remains an R3 storage receipt;
 * this helper proves the exact package, model, and manifest identities only.
 */
export async function verifyRecipeSourceRawAssets(
  sourceValue: unknown,
  assetsValue: RecipeSourceRawAssetInput,
  expectedIdentity: RecipeSourceIdentity,
  requiredTargetEdge?: RecipeUpdateEdge,
): Promise<VerifiedRecipeSourceRawAssets> {
  const source = parseRecipeSource(sourceValue, "Recipe Source raw assets");
  const packageBytes = nonEmptyBytes(assetsValue.packageBytes, "package bytes");
  const modelBytes = nonEmptyBytes(assetsValue.modelBytes, "model bytes");
  const manifestBytes = nonEmptyBytes(
    assetsValue.manifestBytes,
    "manifest bytes",
  );
  const [packageSha256, modelSha256, manifestSha256] = await Promise.all([
    sha256Hex(packageBytes),
    sha256Hex(modelBytes),
    sha256Hex(manifestBytes),
  ]);
  if (
    source.package.sha256 !== packageSha256 ||
    source.model.sha256 !== modelSha256 ||
    source.manifest.sha256 !== manifestSha256
  ) {
    fail("asset bytes do not match the exact Recipe Source hashes");
  }

  const manifest = parseManifestBytes(manifestBytes);
  const metadata = await verifyRecipePackageMetadata(manifest, modelSha256);
  if (
    canonicalRecipeString(metadata.source) !==
      canonicalRecipeString(source.identities) ||
    canonicalRecipeString(metadata.source) !==
      canonicalRecipeString(expectedIdentity)
  ) {
    fail("embedded identity, external Recipe Source, and edge endpoint differ");
  }
  await verifyRecipeSourceProjectionHashes(
    metadata.source,
    manifest,
    modelBytes,
  );

  if (requiredTargetEdge) {
    const matches = metadata.updates.edges.filter(
      (edge) =>
        edge.directEdgeKey === requiredTargetEdge.directEdgeKey &&
        edge.edgeSha256 === requiredTargetEdge.edgeSha256,
    );
    if (
      matches.length !== 1 ||
      canonicalRecipeString(matches[0]) !==
        canonicalRecipeString(requiredTargetEdge)
    ) {
      fail("target manifest does not contain the exact required update edge");
    }
  }

  return {
    contract: RECIPE_SOURCE_RAW_ASSET_PROOF_CONTRACT,
    source,
    manifest,
    packageSha256,
    modelSha256,
    manifestSha256,
  };
}
