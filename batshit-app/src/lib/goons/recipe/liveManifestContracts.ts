import {
  parseGoonLiveBuildBakerIdentity,
  parseGoonLiveBuildEvidenceProofs,
  parseGoonLiveBuildInventory,
  parseGoonLiveBuildOutputCounts,
  parseGoonLiveBuildSourceIdentity,
  parseGoonLiveBuildStateIdentity,
  verifyGoonLiveBuildReceipt,
  type GoonLiveBuildBakerIdentity,
  type GoonLiveBuildEvidenceProofs,
  type GoonLiveBuildInventory,
  type GoonLiveBuildOutputCounts,
  type GoonLiveBuildReceipt,
  type GoonLiveBuildSourceIdentity,
  type GoonLiveBuildStateIdentity,
} from "./liveBuildContracts";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";

export const GOON_LIVE_MANIFEST_CONTRACT = "goon-live-manifest/v1" as const;

export type GoonLiveManifestContent = {
  contract: typeof GOON_LIVE_MANIFEST_CONTRACT;
  source: GoonLiveBuildSourceIdentity;
  state: GoonLiveBuildStateIdentity;
  baker: GoonLiveBuildBakerIdentity;
  inventory: GoonLiveBuildInventory;
  proofs: GoonLiveBuildEvidenceProofs;
  counts: GoonLiveBuildOutputCounts;
};

export type GoonLiveManifest = GoonLiveManifestContent & {
  provenanceSha256: string;
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

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseGoonLiveManifestContent(
  value: unknown,
): GoonLiveManifestContent {
  canonicalRecipeString(value);
  const raw = record(value, "goon-live-manifest");
  exactKeys(
    raw,
    ["contract", "source", "state", "baker", "inventory", "proofs", "counts"],
    "goon-live-manifest",
  );
  if (raw.contract !== GOON_LIVE_MANIFEST_CONTRACT) {
    fail(
      "goon-live-manifest.contract",
      `must equal ${GOON_LIVE_MANIFEST_CONTRACT}`,
    );
  }
  const parsed: GoonLiveManifestContent = {
    contract: GOON_LIVE_MANIFEST_CONTRACT,
    source: parseGoonLiveBuildSourceIdentity(raw.source),
    state: parseGoonLiveBuildStateIdentity(raw.state),
    baker: parseGoonLiveBuildBakerIdentity(raw.baker),
    inventory: parseGoonLiveBuildInventory(raw.inventory),
    proofs: parseGoonLiveBuildEvidenceProofs(raw.proofs),
    counts: parseGoonLiveBuildOutputCounts(raw.counts),
  };
  if (
    parsed.counts.morphTargets !== parsed.inventory.liveMorphTargets.length ||
    parsed.counts.dynamicMorphTargets !==
      parsed.inventory.retainedDynamicMorphs.length ||
    parsed.counts.correctiveMorphTargets !==
      parsed.inventory.retainedCorrectiveMorphs.length
  ) {
    fail("goon-live-manifest", "Live morph inventories do not match counts");
  }
  return parsed;
}

export function parseGoonLiveManifest(value: unknown): GoonLiveManifest {
  canonicalRecipeString(value);
  const raw = record(value, "goon-live-manifest");
  exactKeys(
    raw,
    [
      "contract",
      "source",
      "state",
      "baker",
      "inventory",
      "proofs",
      "counts",
      "provenanceSha256",
    ],
    "goon-live-manifest",
  );
  const { provenanceSha256, ...content } = raw;
  return {
    ...parseGoonLiveManifestContent(content),
    provenanceSha256: requireLowercaseSha256(
      provenanceSha256,
      "goon-live-manifest.provenanceSha256",
    ),
  };
}

export function canonicalGoonLiveManifestContent(value: unknown): string {
  const raw = record(value, "goon-live-manifest content");
  const content = hasOwn(raw, "provenanceSha256")
    ? (({ provenanceSha256: _provenanceSha256, ...rest }) => rest)(raw)
    : raw;
  return canonicalRecipeString(parseGoonLiveManifestContent(content));
}

export async function goonLiveManifestProvenanceSha256(
  value: unknown,
): Promise<string> {
  const raw = record(value, "goon-live-manifest content");
  const content = hasOwn(raw, "provenanceSha256")
    ? (({ provenanceSha256: _provenanceSha256, ...rest }) => rest)(raw)
    : raw;
  return canonicalRecipeSha256(parseGoonLiveManifestContent(content));
}

export async function createGoonLiveManifest(
  value: unknown,
): Promise<GoonLiveManifest> {
  const content = parseGoonLiveManifestContent(value);
  return {
    ...content,
    provenanceSha256: await goonLiveManifestProvenanceSha256(content),
  };
}

export async function verifyGoonLiveManifest(
  value: unknown,
): Promise<GoonLiveManifest> {
  const manifest = parseGoonLiveManifest(value);
  const actual = await goonLiveManifestProvenanceSha256(manifest);
  if (actual !== manifest.provenanceSha256) {
    fail(
      "goon-live-manifest.provenanceSha256",
      `mismatch: expected ${manifest.provenanceSha256}, got ${actual}`,
    );
  }
  return manifest;
}

function receiptProjection(
  receipt: GoonLiveBuildReceipt,
): GoonLiveManifestContent {
  const {
    liveManifestProvenanceSha256: _liveManifestProvenanceSha256,
    ...evidenceProofs
  } = receipt.proofs;
  return {
    contract: GOON_LIVE_MANIFEST_CONTRACT,
    source: receipt.source,
    state: receipt.state,
    baker: receipt.baker,
    inventory: receipt.inventory,
    proofs: evidenceProofs,
    counts: receipt.output.counts,
  };
}

export async function verifyGoonLiveManifestAgainstReceipt(
  manifestValue: unknown,
  receiptValue: unknown,
): Promise<GoonLiveManifest> {
  const [manifest, receipt] = await Promise.all([
    verifyGoonLiveManifest(manifestValue),
    verifyGoonLiveBuildReceipt(receiptValue),
  ]);
  if (
    receipt.proofs.liveManifestProvenanceSha256 !== manifest.provenanceSha256
  ) {
    fail(
      "goon-live-manifest.provenanceSha256",
      "does not match goon-live-build.proofs.liveManifestProvenanceSha256",
    );
  }
  if (
    canonicalGoonLiveManifestContent(manifest) !==
    canonicalGoonLiveManifestContent(receiptProjection(receipt))
  ) {
    fail(
      "goon-live-manifest",
      "projection does not match the external goon-live-build/v1 receipt",
    );
  }
  return manifest;
}

/**
 * Parse the immutable provenance block at avatar.json#liveBuild. The complete
 * avatar manifest may contain normal runtime contracts, but never authoring
 * appearance controls; those belong only to Recipe Source.
 */
export function parseGoonLiveManifestFromAvatarManifest(
  value: unknown,
): GoonLiveManifest {
  canonicalRecipeString(value);
  const raw = record(value, "avatar.json");
  if (hasOwn(raw, "appearanceDials")) {
    fail("avatar.json#appearanceDials", "must be absent from a Live manifest");
  }
  if (hasOwn(raw, "dials")) {
    fail("avatar.json#dials", "must be absent from a Live manifest");
  }
  if (!hasOwn(raw, "liveBuild")) {
    fail("avatar.json#liveBuild", "is required");
  }
  return parseGoonLiveManifest(raw.liveBuild);
}

export async function verifyGoonLiveAvatarManifestAgainstReceipt(
  avatarManifestValue: unknown,
  receiptValue: unknown,
): Promise<GoonLiveManifest> {
  return verifyGoonLiveManifestAgainstReceipt(
    parseGoonLiveManifestFromAvatarManifest(avatarManifestValue),
    receiptValue,
  );
}
