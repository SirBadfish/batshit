import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const GOON_LIVE_BUILD_CONTRACT = "goon-live-build/v1" as const;
const VERSIONED_CONTRACT_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v[1-9][0-9]*$/;

export const GOON_LIVE_BUILD_TOLERANCES = {
  weightScalar: 1e-7,
  vertexMeters: 1e-6,
  jointMeters: 1e-6,
  nodeTranslationMeters: 1e-6,
  pivotMeters: 1e-6,
  scale: 1e-6,
  rotationRadians: 1e-6,
  groundingMeters: 1e-6,
  finalPositionMeters: 1e-6,
} as const;

export type GoonLiveBuildSourceIdentity = {
  revisionId: string;
  revision: number;
  packageSha256: string;
  modelSha256: string;
  manifestSha256: string;
  definitionSha256: string;
  neutralRecipeSha256: string;
  basisSha256: string;
};

export type GoonLiveBuildStateIdentity = {
  contract: string;
  sha256: string;
};

export type GoonLiveBuildBakerIdentity = {
  id: string;
  version: string;
  resolverVersion: string;
  schemaVersion: string;
};

export type GoonLiveBuildInventory = {
  kept: string[];
  removed: string[];
  liveMorphTargets: string[];
  retainedDynamicMorphs: string[];
  retainedCorrectiveMorphs: string[];
};

export type GoonLiveBuildEvidenceProofs = {
  neutralPositionSha256: string;
  skeletonRestSha256: string;
  followerSha256: string;
  rootSha256: string;
  groundingSha256: string;
  performanceSha256: string;
  pivotSha256: string;
  attachmentSha256: string;
  validationReportSha256: string;
};

export type GoonLiveBuildProofs = GoonLiveBuildEvidenceProofs & {
  liveManifestProvenanceSha256: string;
};

export type GoonLiveBuildOutputAsset = {
  sha256: string;
  bytes: number;
};

export type GoonLiveBuildOutputCounts = {
  meshes: number;
  vertices: number;
  nodes: number;
  bones: number;
  morphTargets: number;
  dynamicMorphTargets: number;
  correctiveMorphTargets: number;
  recipeMorphTargets: 0;
};

export type GoonLiveBuildOutput = {
  package: GoonLiveBuildOutputAsset;
  model: GoonLiveBuildOutputAsset;
  manifest: GoonLiveBuildOutputAsset;
  counts: GoonLiveBuildOutputCounts;
};

export type GoonLiveBuildCost = {
  inputBytes: number;
  meshesProcessed: number;
  verticesProcessed: number;
  morphTargetsProcessed: number;
};

export type GoonLiveBuildValidation = {
  maxWeightScalarError: number;
  maxVertexErrorMeters: number;
  maxJointErrorMeters: number;
  maxNodeTranslationErrorMeters: number;
  maxPivotErrorMeters: number;
  maxScaleError: number;
  maxRotationErrorRadians: number;
  maxGroundingErrorMeters: number;
  maxFinalPositionErrorMeters: number;
  rmsFinalPositionErrorMeters: number;
};

export type GoonLiveBuildReceiptContent = {
  contract: typeof GOON_LIVE_BUILD_CONTRACT;
  source: GoonLiveBuildSourceIdentity;
  state: GoonLiveBuildStateIdentity;
  baker: GoonLiveBuildBakerIdentity;
  inventory: GoonLiveBuildInventory;
  proofs: GoonLiveBuildProofs;
  output: GoonLiveBuildOutput;
  cost: GoonLiveBuildCost;
  validation: GoonLiveBuildValidation;
};

export type GoonLiveBuildReceipt = GoonLiveBuildReceiptContent & {
  receiptSha256: string;
};

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(path, `must contain exactly: ${sortedExpected.join(", ")}`);
  }
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)
  ) {
    fail(path, "must be a non-empty stable identifier");
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function finiteMetric(value: unknown, path: string, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  ) {
    fail(path, `must be a finite number between 0 and ${maximum}`);
  }
  // RedisJSON stores JSON numbers as binary doubles and can shift the final
  // insignificant digit of full-precision floating-point evidence. Keep the
  // strict raw tolerance check above, then retain twelve significant digits:
  // far beyond every R7 acceptance tolerance, stable across RedisJSON, and
  // deterministic when the immutable receipt is read back for commit.
  return value === 0 ? 0 : Number(value.toPrecision(12));
}

function sortedUniqueStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const entries = value.map((entry, index) =>
    identifier(entry, `${path}[${index}]`),
  );
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1] >= entries[index]) {
      fail(path, "must be sorted in ascending order with no duplicates");
    }
  }
  return entries;
}

export function parseGoonLiveBuildSourceIdentity(
  value: unknown,
): GoonLiveBuildSourceIdentity {
  const raw = record(value, "goon-live-build.source");
  exactKeys(
    raw,
    [
      "revisionId",
      "revision",
      "packageSha256",
      "modelSha256",
      "manifestSha256",
      "definitionSha256",
      "neutralRecipeSha256",
      "basisSha256",
    ],
    "goon-live-build.source",
  );
  const parsed: GoonLiveBuildSourceIdentity = {
    revisionId: identifier(raw.revisionId, "goon-live-build.source.revisionId"),
    revision: safeInteger(raw.revision, "goon-live-build.source.revision", 1),
    packageSha256: requireLowercaseSha256(
      raw.packageSha256,
      "goon-live-build.source.packageSha256",
    ),
    modelSha256: requireLowercaseSha256(
      raw.modelSha256,
      "goon-live-build.source.modelSha256",
    ),
    manifestSha256: requireLowercaseSha256(
      raw.manifestSha256,
      "goon-live-build.source.manifestSha256",
    ),
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      "goon-live-build.source.definitionSha256",
    ),
    neutralRecipeSha256: requireLowercaseSha256(
      raw.neutralRecipeSha256,
      "goon-live-build.source.neutralRecipeSha256",
    ),
    basisSha256: requireLowercaseSha256(
      raw.basisSha256,
      "goon-live-build.source.basisSha256",
    ),
  };
  if (
    new Set([parsed.packageSha256, parsed.modelSha256, parsed.manifestSha256])
      .size !== 3
  ) {
    fail(
      "goon-live-build.source",
      "package, model, and manifest hashes must be distinct",
    );
  }
  return parsed;
}

export function parseGoonLiveBuildStateIdentity(
  value: unknown,
): GoonLiveBuildStateIdentity {
  const raw = record(value, "goon-live-build.state");
  exactKeys(raw, ["contract", "sha256"], "goon-live-build.state");
  const contract = identifier(raw.contract, "goon-live-build.state.contract");
  if (!VERSIONED_CONTRACT_PATTERN.test(contract)) {
    fail("goon-live-build.state.contract", "must be a versioned contract id");
  }
  return {
    contract,
    sha256: requireLowercaseSha256(raw.sha256, "goon-live-build.state.sha256"),
  };
}

export function parseGoonLiveBuildBakerIdentity(
  value: unknown,
): GoonLiveBuildBakerIdentity {
  const raw = record(value, "goon-live-build.baker");
  exactKeys(
    raw,
    ["id", "version", "resolverVersion", "schemaVersion"],
    "goon-live-build.baker",
  );
  return {
    id: identifier(raw.id, "goon-live-build.baker.id"),
    version: identifier(raw.version, "goon-live-build.baker.version"),
    resolverVersion: identifier(
      raw.resolverVersion,
      "goon-live-build.baker.resolverVersion",
    ),
    schemaVersion: identifier(
      raw.schemaVersion,
      "goon-live-build.baker.schemaVersion",
    ),
  };
}

function fullyQualifiedMorphRef(value: unknown, path: string): string {
  const parsed = identifier(value, path);
  if (
    !/^node:\/[A-Za-z0-9._~+:-]+(?:\/[A-Za-z0-9._~+:-]+)*\/morph:\/[A-Za-z0-9._~+:-]+$/.test(
      parsed,
    )
  ) {
    fail(
      path,
      "must be a fully-qualified node:/.../morph:/... target reference",
    );
  }
  return parsed;
}

function sortedUniqueMorphRefs(value: unknown, path: string): string[] {
  const entries = sortedUniqueStrings(value, path);
  return entries.map((entry, index) =>
    fullyQualifiedMorphRef(entry, `${path}[${index}]`),
  );
}

export function parseGoonLiveBuildInventory(
  value: unknown,
): GoonLiveBuildInventory {
  const raw = record(value, "goon-live-build.inventory");
  exactKeys(
    raw,
    [
      "kept",
      "removed",
      "liveMorphTargets",
      "retainedDynamicMorphs",
      "retainedCorrectiveMorphs",
    ],
    "goon-live-build.inventory",
  );
  const parsed: GoonLiveBuildInventory = {
    kept: sortedUniqueStrings(raw.kept, "goon-live-build.inventory.kept"),
    removed: sortedUniqueStrings(
      raw.removed,
      "goon-live-build.inventory.removed",
    ),
    liveMorphTargets: sortedUniqueMorphRefs(
      raw.liveMorphTargets,
      "goon-live-build.inventory.liveMorphTargets",
    ),
    retainedDynamicMorphs: sortedUniqueMorphRefs(
      raw.retainedDynamicMorphs,
      "goon-live-build.inventory.retainedDynamicMorphs",
    ),
    retainedCorrectiveMorphs: sortedUniqueMorphRefs(
      raw.retainedCorrectiveMorphs,
      "goon-live-build.inventory.retainedCorrectiveMorphs",
    ),
  };
  if (!parsed.removed.includes("manifest:/appearanceDials")) {
    fail(
      "goon-live-build.inventory.removed",
      "must include manifest:/appearanceDials",
    );
  }
  const kept = new Set(parsed.kept);
  for (const removed of parsed.removed) {
    if (kept.has(removed))
      fail("goon-live-build.inventory", `${removed} is both kept and removed`);
  }
  const liveMorphTargets = new Set(parsed.liveMorphTargets);
  for (const retained of [
    ...parsed.retainedDynamicMorphs,
    ...parsed.retainedCorrectiveMorphs,
  ]) {
    if (!liveMorphTargets.has(retained)) {
      fail(
        "goon-live-build.inventory",
        `${retained} is retained but absent from liveMorphTargets`,
      );
    }
  }
  const dynamic = new Set(parsed.retainedDynamicMorphs);
  for (const corrective of parsed.retainedCorrectiveMorphs) {
    if (dynamic.has(corrective)) {
      fail(
        "goon-live-build.inventory",
        `${corrective} cannot be both dynamic and corrective`,
      );
    }
  }
  const qualifiedKeptMorphs = parsed.kept.filter((entry) =>
    entry.includes("/morph:/"),
  );
  if (
    qualifiedKeptMorphs.length !== parsed.liveMorphTargets.length ||
    qualifiedKeptMorphs.some(
      (entry, index) => entry !== parsed.liveMorphTargets[index],
    )
  ) {
    fail(
      "goon-live-build.inventory",
      "liveMorphTargets must exactly inventory the fully-qualified morph targets in kept",
    );
  }
  return parsed;
}

export function parseGoonLiveBuildEvidenceProofs(
  value: unknown,
): GoonLiveBuildEvidenceProofs {
  const raw = record(value, "goon-live-build.proofs");
  const keys = [
    "neutralPositionSha256",
    "skeletonRestSha256",
    "followerSha256",
    "rootSha256",
    "groundingSha256",
    "performanceSha256",
    "pivotSha256",
    "attachmentSha256",
    "validationReportSha256",
  ] as const;
  exactKeys(raw, keys, "goon-live-build.proofs");
  return Object.fromEntries(
    keys.map((key) => [
      key,
      requireLowercaseSha256(raw[key], `goon-live-build.proofs.${key}`),
    ]),
  ) as GoonLiveBuildEvidenceProofs;
}

function proofs(value: unknown): GoonLiveBuildProofs {
  const raw = record(value, "goon-live-build.proofs");
  const evidenceKeys = [
    "neutralPositionSha256",
    "skeletonRestSha256",
    "followerSha256",
    "rootSha256",
    "groundingSha256",
    "performanceSha256",
    "pivotSha256",
    "attachmentSha256",
    "validationReportSha256",
  ] as const;
  exactKeys(
    raw,
    [...evidenceKeys, "liveManifestProvenanceSha256"],
    "goon-live-build.proofs",
  );
  const evidence = parseGoonLiveBuildEvidenceProofs(
    Object.fromEntries(evidenceKeys.map((key) => [key, raw[key]])),
  );
  return {
    ...evidence,
    liveManifestProvenanceSha256: requireLowercaseSha256(
      raw.liveManifestProvenanceSha256,
      "goon-live-build.proofs.liveManifestProvenanceSha256",
    ),
  };
}

function outputAsset(value: unknown, path: string): GoonLiveBuildOutputAsset {
  const raw = record(value, path);
  exactKeys(raw, ["sha256", "bytes"], path);
  return {
    sha256: requireLowercaseSha256(raw.sha256, `${path}.sha256`),
    bytes: safeInteger(raw.bytes, `${path}.bytes`, 1),
  };
}

export function parseGoonLiveBuildOutputCounts(
  value: unknown,
): GoonLiveBuildOutputCounts {
  const raw = record(value, "goon-live-build.output.counts");
  exactKeys(
    raw,
    [
      "meshes",
      "vertices",
      "nodes",
      "bones",
      "morphTargets",
      "dynamicMorphTargets",
      "correctiveMorphTargets",
      "recipeMorphTargets",
    ],
    "goon-live-build.output.counts",
  );
  const recipeMorphTargets = safeInteger(
    raw.recipeMorphTargets,
    "goon-live-build.output.counts.recipeMorphTargets",
  );
  if (recipeMorphTargets !== 0) {
    fail(
      "goon-live-build.output.counts.recipeMorphTargets",
      "must be exactly 0",
    );
  }
  const counts: GoonLiveBuildOutputCounts = {
    meshes: safeInteger(raw.meshes, "goon-live-build.output.counts.meshes"),
    vertices: safeInteger(
      raw.vertices,
      "goon-live-build.output.counts.vertices",
    ),
    nodes: safeInteger(raw.nodes, "goon-live-build.output.counts.nodes"),
    bones: safeInteger(raw.bones, "goon-live-build.output.counts.bones"),
    morphTargets: safeInteger(
      raw.morphTargets,
      "goon-live-build.output.counts.morphTargets",
    ),
    dynamicMorphTargets: safeInteger(
      raw.dynamicMorphTargets,
      "goon-live-build.output.counts.dynamicMorphTargets",
    ),
    correctiveMorphTargets: safeInteger(
      raw.correctiveMorphTargets,
      "goon-live-build.output.counts.correctiveMorphTargets",
    ),
    recipeMorphTargets,
  };
  if (
    counts.dynamicMorphTargets > counts.morphTargets ||
    counts.correctiveMorphTargets > counts.morphTargets
  ) {
    fail(
      "goon-live-build.output.counts",
      "retained morph counts exceed total morphTargets",
    );
  }
  return counts;
}

function output(value: unknown): GoonLiveBuildOutput {
  const raw = record(value, "goon-live-build.output");
  exactKeys(
    raw,
    ["package", "model", "manifest", "counts"],
    "goon-live-build.output",
  );
  const parsed: GoonLiveBuildOutput = {
    package: outputAsset(raw.package, "goon-live-build.output.package"),
    model: outputAsset(raw.model, "goon-live-build.output.model"),
    manifest: outputAsset(raw.manifest, "goon-live-build.output.manifest"),
    counts: parseGoonLiveBuildOutputCounts(raw.counts),
  };
  if (
    new Set([
      parsed.package.sha256,
      parsed.model.sha256,
      parsed.manifest.sha256,
    ]).size !== 3
  ) {
    fail(
      "goon-live-build.output",
      "package, model, and manifest hashes must be distinct",
    );
  }
  return parsed;
}

function cost(value: unknown): GoonLiveBuildCost {
  const raw = record(value, "goon-live-build.cost");
  exactKeys(
    raw,
    [
      "inputBytes",
      "meshesProcessed",
      "verticesProcessed",
      "morphTargetsProcessed",
    ],
    "goon-live-build.cost",
  );
  return {
    inputBytes: safeInteger(
      raw.inputBytes,
      "goon-live-build.cost.inputBytes",
      1,
    ),
    meshesProcessed: safeInteger(
      raw.meshesProcessed,
      "goon-live-build.cost.meshesProcessed",
    ),
    verticesProcessed: safeInteger(
      raw.verticesProcessed,
      "goon-live-build.cost.verticesProcessed",
    ),
    morphTargetsProcessed: safeInteger(
      raw.morphTargetsProcessed,
      "goon-live-build.cost.morphTargetsProcessed",
    ),
  };
}

function validation(value: unknown): GoonLiveBuildValidation {
  const raw = record(value, "goon-live-build.validation");
  exactKeys(
    raw,
    [
      "maxWeightScalarError",
      "maxVertexErrorMeters",
      "maxJointErrorMeters",
      "maxNodeTranslationErrorMeters",
      "maxPivotErrorMeters",
      "maxScaleError",
      "maxRotationErrorRadians",
      "maxGroundingErrorMeters",
      "maxFinalPositionErrorMeters",
      "rmsFinalPositionErrorMeters",
    ],
    "goon-live-build.validation",
  );
  const parsed: GoonLiveBuildValidation = {
    maxWeightScalarError: finiteMetric(
      raw.maxWeightScalarError,
      "goon-live-build.validation.maxWeightScalarError",
      GOON_LIVE_BUILD_TOLERANCES.weightScalar,
    ),
    maxVertexErrorMeters: finiteMetric(
      raw.maxVertexErrorMeters,
      "goon-live-build.validation.maxVertexErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.vertexMeters,
    ),
    maxJointErrorMeters: finiteMetric(
      raw.maxJointErrorMeters,
      "goon-live-build.validation.maxJointErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.jointMeters,
    ),
    maxNodeTranslationErrorMeters: finiteMetric(
      raw.maxNodeTranslationErrorMeters,
      "goon-live-build.validation.maxNodeTranslationErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.nodeTranslationMeters,
    ),
    maxPivotErrorMeters: finiteMetric(
      raw.maxPivotErrorMeters,
      "goon-live-build.validation.maxPivotErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.pivotMeters,
    ),
    maxScaleError: finiteMetric(
      raw.maxScaleError,
      "goon-live-build.validation.maxScaleError",
      GOON_LIVE_BUILD_TOLERANCES.scale,
    ),
    maxRotationErrorRadians: finiteMetric(
      raw.maxRotationErrorRadians,
      "goon-live-build.validation.maxRotationErrorRadians",
      GOON_LIVE_BUILD_TOLERANCES.rotationRadians,
    ),
    maxGroundingErrorMeters: finiteMetric(
      raw.maxGroundingErrorMeters,
      "goon-live-build.validation.maxGroundingErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.groundingMeters,
    ),
    maxFinalPositionErrorMeters: finiteMetric(
      raw.maxFinalPositionErrorMeters,
      "goon-live-build.validation.maxFinalPositionErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.finalPositionMeters,
    ),
    rmsFinalPositionErrorMeters: finiteMetric(
      raw.rmsFinalPositionErrorMeters,
      "goon-live-build.validation.rmsFinalPositionErrorMeters",
      GOON_LIVE_BUILD_TOLERANCES.finalPositionMeters,
    ),
  };
  if (parsed.rmsFinalPositionErrorMeters > parsed.maxFinalPositionErrorMeters) {
    fail(
      "goon-live-build.validation.rmsFinalPositionErrorMeters",
      "may not exceed maxFinalPositionErrorMeters",
    );
  }
  return parsed;
}

export function parseGoonLiveBuildReceiptContent(
  value: unknown,
): GoonLiveBuildReceiptContent {
  // Canonicalization is also the strict JSON-value preflight: it rejects
  // undefined, sparse arrays, accessors, cycles, and non-finite numbers.
  canonicalRecipeString(value);
  const raw = record(value, "goon-live-build");
  exactKeys(
    raw,
    [
      "contract",
      "source",
      "state",
      "baker",
      "inventory",
      "proofs",
      "output",
      "cost",
      "validation",
    ],
    "goon-live-build",
  );
  if (raw.contract !== GOON_LIVE_BUILD_CONTRACT) {
    fail("goon-live-build.contract", `must equal ${GOON_LIVE_BUILD_CONTRACT}`);
  }
  const parsed: GoonLiveBuildReceiptContent = {
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: parseGoonLiveBuildSourceIdentity(raw.source),
    state: parseGoonLiveBuildStateIdentity(raw.state),
    baker: parseGoonLiveBuildBakerIdentity(raw.baker),
    inventory: parseGoonLiveBuildInventory(raw.inventory),
    proofs: proofs(raw.proofs),
    output: output(raw.output),
    cost: cost(raw.cost),
    validation: validation(raw.validation),
  };
  if (
    parsed.output.counts.morphTargets !==
      parsed.inventory.liveMorphTargets.length ||
    parsed.output.counts.dynamicMorphTargets !==
      parsed.inventory.retainedDynamicMorphs.length ||
    parsed.output.counts.correctiveMorphTargets !==
      parsed.inventory.retainedCorrectiveMorphs.length
  ) {
    fail(
      "goon-live-build",
      "Live morph inventories do not match output counts",
    );
  }
  if (
    parsed.output.counts.dynamicMorphTargets +
      parsed.output.counts.correctiveMorphTargets >
    parsed.output.counts.morphTargets
  ) {
    fail(
      "goon-live-build.output.counts",
      "retained morph categories exceed total morphTargets",
    );
  }
  return parsed;
}

export function parseGoonLiveBuildReceipt(
  value: unknown,
): GoonLiveBuildReceipt {
  canonicalRecipeString(value);
  const raw = record(value, "goon-live-build receipt");
  exactKeys(
    raw,
    [
      "contract",
      "source",
      "state",
      "baker",
      "inventory",
      "proofs",
      "output",
      "cost",
      "validation",
      "receiptSha256",
    ],
    "goon-live-build receipt",
  );
  const { receiptSha256, ...content } = raw;
  return {
    ...parseGoonLiveBuildReceiptContent(content),
    receiptSha256: requireLowercaseSha256(
      receiptSha256,
      "goon-live-build.receiptSha256",
    ),
  };
}

export function canonicalGoonLiveBuildReceiptContent(value: unknown): string {
  return canonicalRecipeString(parseGoonLiveBuildReceiptContent(value));
}

export async function goonLiveBuildReceiptSha256(
  value: unknown,
): Promise<string> {
  const raw = record(value, "goon-live-build receipt content");
  const content = Object.prototype.hasOwnProperty.call(raw, "receiptSha256")
    ? (({ receiptSha256: _receiptSha256, ...rest }) => rest)(raw)
    : raw;
  return canonicalRecipeSha256(parseGoonLiveBuildReceiptContent(content));
}

export async function createGoonLiveBuildReceipt(
  value: unknown,
): Promise<GoonLiveBuildReceipt> {
  const content = parseGoonLiveBuildReceiptContent(value);
  return {
    ...content,
    receiptSha256: await goonLiveBuildReceiptSha256(content),
  };
}

export async function verifyGoonLiveBuildReceipt(
  value: unknown,
): Promise<GoonLiveBuildReceipt> {
  const receipt = parseGoonLiveBuildReceipt(value);
  const actual = await goonLiveBuildReceiptSha256(receipt);
  if (actual !== receipt.receiptSha256) {
    throw new Error(
      `goon-live-build.receiptSha256 mismatch: expected ${receipt.receiptSha256}, got ${actual}`,
    );
  }
  return receipt;
}
