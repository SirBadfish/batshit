import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const RECIPE_SOURCE_CONTRACT = "recipe-source/v1" as const;
export const RECIPE_MANIFEST_SEMANTIC_CONTRACT =
  "recipe-manifest-semantic/v1" as const;

export type RecipeSourceIdentity = {
  contract: typeof RECIPE_SOURCE_CONTRACT;
  schemaVersion: 1;
  baseId: string;
  fitFamily: string;
  modelSha256: string;
  manifestSemanticSha256: string;
  definitionSha256: string;
  neutralId: string;
  neutralRecipeSha256: string;
  physicalBasisSha256: string;
  behaviorSha256: string;
  componentGraphSha256: string;
  topologySha256: string;
  skeletonHierarchySha256: string;
};

type RecipeSourceIdentityInput = Omit<
  RecipeSourceIdentity,
  "contract" | "schemaVersion" | "manifestSemanticSha256"
>;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_IDENTITY_KEYS = [
  "contract",
  "schemaVersion",
  "baseId",
  "fitFamily",
  "modelSha256",
  "manifestSemanticSha256",
  "definitionSha256",
  "neutralId",
  "neutralRecipeSha256",
  "physicalBasisSha256",
  "behaviorSha256",
  "componentGraphSha256",
  "topologySha256",
  "skeletonHierarchySha256",
] as const;

function fail(message: string): never {
  throw new Error(`[${RECIPE_SOURCE_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${context} must contain exactly: ${sortedExpected.join(", ")}`);
  }
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    !STABLE_ID_PATTERN.test(value) ||
    FORBIDDEN_KEYS.has(value)
  ) {
    fail(`${context} must be a stable id`);
  }
  return value;
}

/**
 * Parse the intrinsic identity embedded in an authoring package.
 *
 * Raw avatar.json and .bgoon hashes deliberately do not belong here: those
 * bytes contain this block, so embedding either final digest would be a
 * circular hash. Trusted import computes those transport hashes externally.
 */
export function parseRecipeSourceIdentity(
  value: unknown,
  context = "recipe source identity",
): RecipeSourceIdentity {
  canonicalRecipeString(value);
  const raw = record(value, context);
  exactKeys(raw, SOURCE_IDENTITY_KEYS, context);
  if (raw.contract !== RECIPE_SOURCE_CONTRACT || raw.schemaVersion !== 1) {
    fail(`${context} contract identity is invalid`);
  }
  return {
    contract: RECIPE_SOURCE_CONTRACT,
    schemaVersion: 1,
    baseId: stableId(raw.baseId, `${context}.baseId`),
    fitFamily: stableId(raw.fitFamily, `${context}.fitFamily`),
    modelSha256: requireLowercaseSha256(
      raw.modelSha256,
      `${context}.modelSha256`,
    ),
    manifestSemanticSha256: requireLowercaseSha256(
      raw.manifestSemanticSha256,
      `${context}.manifestSemanticSha256`,
    ),
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      `${context}.definitionSha256`,
    ),
    neutralId: stableId(raw.neutralId, `${context}.neutralId`),
    neutralRecipeSha256: requireLowercaseSha256(
      raw.neutralRecipeSha256,
      `${context}.neutralRecipeSha256`,
    ),
    physicalBasisSha256: requireLowercaseSha256(
      raw.physicalBasisSha256,
      `${context}.physicalBasisSha256`,
    ),
    behaviorSha256: requireLowercaseSha256(
      raw.behaviorSha256,
      `${context}.behaviorSha256`,
    ),
    componentGraphSha256: requireLowercaseSha256(
      raw.componentGraphSha256,
      `${context}.componentGraphSha256`,
    ),
    topologySha256: requireLowercaseSha256(
      raw.topologySha256,
      `${context}.topologySha256`,
    ),
    skeletonHierarchySha256: requireLowercaseSha256(
      raw.skeletonHierarchySha256,
      `${context}.skeletonHierarchySha256`,
    ),
  };
}

/**
 * Versioned, non-self-referential avatar.json projection.
 *
 * Package-facing Recipe blocks and evaluation/presentation provenance are
 * excluded. Every runtime/physical contract remains in the projection.
 */
export function recipeManifestSemanticContent(value: unknown): unknown {
  const manifest = record(value, "avatar.json");
  const clone = JSON.parse(canonicalRecipeString(manifest)) as Record<
    string,
    unknown
  >;
  delete clone.recipeSource;
  delete clone.recipeUpdates;
  delete clone.liveBuild;
  delete clone.evaluation;
  delete clone.name;
  delete clone.description;
  const rig = clone.rig;
  if (rig && typeof rig === "object" && !Array.isArray(rig)) {
    delete (rig as Record<string, unknown>).provenance;
  }

  const appearance = clone.appearanceDials;
  if (
    appearance &&
    typeof appearance === "object" &&
    !Array.isArray(appearance)
  ) {
    const appearanceRecord = appearance as Record<string, unknown>;
    delete appearanceRecord.definitionSha256;
    delete appearanceRecord.evaluation;
    delete appearanceRecord.fitEvidence;
    delete appearanceRecord.productResolution;
    delete appearanceRecord.regions;
    if (Array.isArray(appearanceRecord.dials)) {
      for (const dial of appearanceRecord.dials) {
        if (!dial || typeof dial !== "object" || Array.isArray(dial)) continue;
        const dialRecord = dial as Record<string, unknown>;
        for (const key of [
          "label",
          "description",
          "keywords",
          "region",
          "tier",
          "order",
          "step",
        ]) {
          delete dialRecord[key];
        }
        const symmetry = dialRecord.symmetry;
        if (
          symmetry &&
          typeof symmetry === "object" &&
          !Array.isArray(symmetry)
        ) {
          for (const side of ["left", "right"]) {
            const sideValue = (symmetry as Record<string, unknown>)[side];
            if (
              sideValue &&
              typeof sideValue === "object" &&
              !Array.isArray(sideValue)
            ) {
              delete (sideValue as Record<string, unknown>).label;
              delete (sideValue as Record<string, unknown>).step;
            }
          }
        }
      }
    }
    if (
      appearanceRecord.targets &&
      typeof appearanceRecord.targets === "object" &&
      !Array.isArray(appearanceRecord.targets)
    ) {
      for (const target of Object.values(
        appearanceRecord.targets as Record<string, unknown>,
      )) {
        if (target && typeof target === "object" && !Array.isArray(target)) {
          delete (target as Record<string, unknown>).provenance;
        }
      }
    }
    if (
      appearanceRecord.followers &&
      typeof appearanceRecord.followers === "object" &&
      !Array.isArray(appearanceRecord.followers)
    ) {
      for (const follower of Object.values(
        appearanceRecord.followers as Record<string, unknown>,
      )) {
        if (
          follower &&
          typeof follower === "object" &&
          !Array.isArray(follower)
        ) {
          delete (follower as Record<string, unknown>).provenance;
        }
      }
    }
  }

  const facialArtwork = clone.facialArtwork;
  if (
    facialArtwork &&
    typeof facialArtwork === "object" &&
    !Array.isArray(facialArtwork)
  ) {
    const facialArtworkRecord = facialArtwork as Record<string, unknown>;
    for (const key of ["definitionSha256", "productExportApproved", "status"]) {
      delete facialArtworkRecord[key];
    }
    const topologyFreeze = facialArtworkRecord.topologyFreeze;
    if (
      topologyFreeze &&
      typeof topologyFreeze === "object" &&
      !Array.isArray(topologyFreeze)
    ) {
      const stripTopologyProvenanceHashes = (entry: unknown): void => {
        if (Array.isArray(entry)) {
          for (const child of entry) stripTopologyProvenanceHashes(child);
          return;
        }
        if (!entry || typeof entry !== "object") return;
        for (const [key, child] of Object.entries(
          entry as Record<string, unknown>,
        )) {
          if (/sha256$/i.test(key)) {
            delete (entry as Record<string, unknown>)[key];
          } else {
            stripTopologyProvenanceHashes(child);
          }
        }
      };
      stripTopologyProvenanceHashes(topologyFreeze);
    }
  }

  const eyeAppearance = clone.eyeAppearance;
  if (
    eyeAppearance &&
    typeof eyeAppearance === "object" &&
    !Array.isArray(eyeAppearance)
  ) {
    const eyeAppearanceRecord = eyeAppearance as Record<string, unknown>;
    for (const key of [
      "definitionSha256",
      "ownership",
      "productExportApproved",
      "rangeEvidence",
      "status",
    ]) {
      delete eyeAppearanceRecord[key];
    }
  }
  return {
    contract: RECIPE_MANIFEST_SEMANTIC_CONTRACT,
    manifest: clone,
  };
}

export async function recipeManifestSemanticSha256(
  manifest: unknown,
): Promise<string> {
  return canonicalRecipeSha256(recipeManifestSemanticContent(manifest));
}

export async function createRecipeSourceIdentity(
  input: RecipeSourceIdentityInput,
  manifest: unknown,
): Promise<RecipeSourceIdentity> {
  return parseRecipeSourceIdentity({
    contract: RECIPE_SOURCE_CONTRACT,
    schemaVersion: 1,
    ...input,
    manifestSemanticSha256: await recipeManifestSemanticSha256(manifest),
  });
}

export async function verifyRecipeSourceIdentity(
  value: unknown,
  manifest: unknown,
  exactModelSha256: unknown,
): Promise<RecipeSourceIdentity> {
  const identity = parseRecipeSourceIdentity(value);
  const modelSha256 = requireLowercaseSha256(
    exactModelSha256,
    "exact model SHA-256",
  );
  if (identity.modelSha256 !== modelSha256) {
    fail("embedded modelSha256 does not match the exact avatar.glb bytes");
  }
  const semanticSha256 = await recipeManifestSemanticSha256(manifest);
  if (identity.manifestSemanticSha256 !== semanticSha256) {
    fail(
      `manifest semantic hash mismatch: expected ${identity.manifestSemanticSha256}, got ${semanticSha256}`,
    );
  }
  return identity;
}

export async function verifyRecipeSourceManifest(
  value: unknown,
  exactModelSha256: unknown,
): Promise<RecipeSourceIdentity> {
  const manifest = record(value, "avatar.json");
  if (
    !("appearanceDials" in manifest) ||
    manifest.appearanceDials === null ||
    typeof manifest.appearanceDials !== "object" ||
    Array.isArray(manifest.appearanceDials)
  ) {
    fail("authoring avatar.json must contain appearanceDials");
  }
  if ("liveBuild" in manifest) {
    fail("authoring avatar.json cannot contain liveBuild metadata");
  }
  const identity = await verifyRecipeSourceIdentity(
    manifest.recipeSource,
    manifest,
    exactModelSha256,
  );
  const rig = record(manifest.rig, "avatar.json.rig");
  const appearance = record(
    manifest.appearanceDials,
    "avatar.json.appearanceDials",
  );
  const neutral = record(
    appearance.neutral,
    "avatar.json.appearanceDials.neutral",
  );
  const baseId = stableId(rig.baseId, "avatar.json.rig.baseId");
  const fitFamily = stableId(rig.fitFamily, "avatar.json.rig.fitFamily");
  const definitionSha256 = requireLowercaseSha256(
    appearance.definitionSha256,
    "avatar.json.appearanceDials.definitionSha256",
  );
  const neutralId = stableId(
    neutral.id,
    "avatar.json.appearanceDials.neutral.id",
  );
  const neutralRecipeSha256 = requireLowercaseSha256(
    neutral.recipeSha256,
    "avatar.json.appearanceDials.neutral.recipeSha256",
  );
  if (
    identity.baseId !== baseId ||
    identity.fitFamily !== fitFamily ||
    identity.definitionSha256 !== definitionSha256 ||
    identity.neutralId !== neutralId ||
    identity.neutralRecipeSha256 !== neutralRecipeSha256
  ) {
    fail("embedded source identity disagrees with authoring manifest identity");
  }
  return identity;
}
