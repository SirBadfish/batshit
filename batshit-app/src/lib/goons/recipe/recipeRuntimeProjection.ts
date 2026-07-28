import type { GoonFileRef, GoonRecord } from "$lib/types/goons";

import type { RecipeStoredAssetRef } from "./archiveContainmentContracts";
import { requireLowercaseSha256 } from "./recipeCanonical";
import {
  GOON_RECIPE_OWNER_V2_CONTRACT,
  type GoonRecipeV2,
  type RecipeRevisionEnvelope,
} from "./recipeLifecycleContracts";
import type {
  RecipeAuthoringRevision,
  RecipeJsonValue,
  RecipeSiblingStateRecord,
  RecipeSource,
  RecipeStateSnapshot,
} from "./recipeContracts";

export const GOON_RECIPE_FIT_RECEIPT_CONTRACT =
  "goon-recipe-fit-receipt/v1" as const;

export const GOON_RECIPE_FIT_SURFACES = [
  "hair",
  "clothing",
  "conceal-geometry",
  "attachment",
] as const;

export type GoonRecipeFitSurface =
  (typeof GOON_RECIPE_FIT_SURFACES)[number];

export type GoonRecipeRevisionIdentity = {
  recipeRevision: number;
  revisionId: string;
  revisionSha256: string;
  stateSha256: string;
};

export type GoonRecipeFitReceipt = {
  contract: typeof GOON_RECIPE_FIT_RECEIPT_CONTRACT;
  receiptId: string;
  surface: GoonRecipeFitSurface;
  assetId: string;
  fitSha256: string;
  boundRevision: GoonRecipeRevisionIdentity;
  evaluatedRevision: GoonRecipeRevisionIdentity;
  status: "current" | "stale";
  staleReason: "recipe-revision-mismatch" | null;
};

export type GoonRecipeOpaqueSiblingState = Record<string, RecipeJsonValue>;

type RecipeSiblingProjection = Pick<
  GoonRecord,
  | "appearanceDials"
  | "facialArtwork"
  | "eyeAppearance"
  | "oralAppearance"
  | "lipArtwork"
>;

const SIBLING_PROJECTIONS = [
  {
    field: "facialArtwork",
    contract: "facial-artwork-state/v4",
    ids: ["facialArtwork", "facial-artwork"],
  },
  {
    field: "eyeAppearance",
    contract: "eye-appearance-state/v3",
    ids: ["eyeAppearance", "eye-appearance"],
  },
  {
    field: "oralAppearance",
    contract: null,
    ids: ["oralAppearance", "oral-appearance"],
  },
  {
    field: "lipArtwork",
    contract: "lip-artwork-state/v2",
    ids: ["lipArtwork", "lip-artwork"],
  },
] as const;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FIT_SURFACE_SET = new Set<string>(GOON_RECIPE_FIT_SURFACES);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${context} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function stableId(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    throw new Error(`${context} must be a stable id.`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${context} must be a positive safe integer.`);
  }
  return value as number;
}

function parseRevisionIdentity(
  value: unknown,
  context: string,
): GoonRecipeRevisionIdentity {
  const raw = requiredRecord(value, context);
  exactKeys(
    raw,
    ["recipeRevision", "revisionId", "revisionSha256", "stateSha256"],
    context,
  );
  return {
    recipeRevision: positiveInteger(raw.recipeRevision, `${context}.recipeRevision`),
    revisionId: stableId(raw.revisionId, `${context}.revisionId`),
    revisionSha256: requireLowercaseSha256(
      raw.revisionSha256,
      `${context}.revisionSha256`,
    ),
    stateSha256: requireLowercaseSha256(
      raw.stateSha256,
      `${context}.stateSha256`,
    ),
  };
}

export function recipeRevisionIdentity(
  revision: Pick<
    RecipeAuthoringRevision,
    "recipeRevision" | "revisionId" | "revisionSha256" | "state"
  >,
): GoonRecipeRevisionIdentity {
  return {
    recipeRevision: revision.recipeRevision,
    revisionId: revision.revisionId,
    revisionSha256: revision.revisionSha256,
    stateSha256: revision.state.stateSha256,
  };
}

export function parseGoonRecipeFitReceipt(value: unknown): GoonRecipeFitReceipt {
  const raw = requiredRecord(value, "Recipe fit receipt");
  exactKeys(
    raw,
    [
      "contract",
      "receiptId",
      "surface",
      "assetId",
      "fitSha256",
      "boundRevision",
      "evaluatedRevision",
      "status",
      "staleReason",
    ],
    "Recipe fit receipt",
  );
  if (raw.contract !== GOON_RECIPE_FIT_RECEIPT_CONTRACT) {
    throw new Error(
      `Recipe fit receipt contract must be ${GOON_RECIPE_FIT_RECEIPT_CONTRACT}.`,
    );
  }
  if (typeof raw.surface !== "string" || !FIT_SURFACE_SET.has(raw.surface)) {
    throw new Error("Recipe fit receipt surface is unsupported.");
  }
  if (raw.status !== "current" && raw.status !== "stale") {
    throw new Error("Recipe fit receipt status must be current or stale.");
  }
  if (
    raw.staleReason !== null &&
    raw.staleReason !== "recipe-revision-mismatch"
  ) {
    throw new Error("Recipe fit receipt staleReason is unsupported.");
  }
  return {
    contract: GOON_RECIPE_FIT_RECEIPT_CONTRACT,
    receiptId: stableId(raw.receiptId, "Recipe fit receipt.receiptId"),
    surface: raw.surface as GoonRecipeFitSurface,
    assetId: stableId(raw.assetId, "Recipe fit receipt.assetId"),
    fitSha256: requireLowercaseSha256(
      raw.fitSha256,
      "Recipe fit receipt.fitSha256",
    ),
    boundRevision: parseRevisionIdentity(
      raw.boundRevision,
      "Recipe fit receipt.boundRevision",
    ),
    evaluatedRevision: parseRevisionIdentity(
      raw.evaluatedRevision,
      "Recipe fit receipt.evaluatedRevision",
    ),
    status: raw.status,
    staleReason: raw.staleReason,
  };
}

function sameRevisionIdentity(
  left: GoonRecipeRevisionIdentity,
  right: GoonRecipeRevisionIdentity,
) {
  return (
    left.recipeRevision === right.recipeRevision &&
    left.revisionId === right.revisionId &&
    left.revisionSha256 === right.revisionSha256 &&
    left.stateSha256 === right.stateSha256
  );
}

/**
 * Re-evaluate durable fit evidence without ever retargeting its immutable
 * bound revision. A rollback to that exact revision makes the receipt current
 * again; every other revision is visibly stale until a fitter writes new proof.
 */
export function reconcileGoonRecipeFitReceipts(
  receipts: readonly GoonRecipeFitReceipt[] | null | undefined,
  activeRevision: GoonRecipeRevisionIdentity,
): GoonRecipeFitReceipt[] {
  return (receipts ?? [])
    .map((value) => parseGoonRecipeFitReceipt(value))
    .map((receipt) => {
      const current = sameRevisionIdentity(receipt.boundRevision, activeRevision);
      return {
        ...receipt,
        evaluatedRevision: cloneJson(activeRevision),
        status: current ? "current" as const : "stale" as const,
        staleReason: current ? null : "recipe-revision-mismatch" as const,
      };
    })
    .sort((left, right) => left.receiptId.localeCompare(right.receiptId));
}

function sourceFileRef(
  ref: { ref: string },
  fallback: "recipe-source.bgoon" | "avatar.glb" | "avatar.json",
): GoonFileRef {
  return {
    url: ref.ref,
    filename: ref.ref.split("/").pop()?.trim() || fallback,
  };
}

function projectSiblingState(
  state: RecipeStateSnapshot,
): RecipeSiblingProjection {
  const projection: RecipeSiblingProjection = {
    appearanceDials: cloneJson(state.appearanceDials),
  };
  const claimed = new Set<string>();
  for (const descriptor of SIBLING_PROJECTIONS) {
    const matches = state.siblings.filter(
      (sibling) =>
        (descriptor.ids as readonly string[]).includes(sibling.id) ||
        (descriptor.contract !== null && sibling.contract === descriptor.contract),
    );
    if (matches.length > 1) {
      throw new Error(
        `Recipe State ambiguously binds more than one ${descriptor.field} sibling.`,
      );
    }
    const sibling = matches[0];
    if (!sibling) continue;
    if (claimed.has(sibling.id)) {
      throw new Error(`Recipe sibling ${sibling.id} is bound to more than one surface.`);
    }
    if (descriptor.contract !== null && sibling.contract !== descriptor.contract) {
      throw new Error(
        `Recipe sibling ${sibling.id} must use ${descriptor.contract}.`,
      );
    }
    const siblingState = requiredRecord(
      sibling.state,
      `Recipe sibling ${sibling.id} state`,
    );
    const stateContract = siblingState.schemaVersion ?? siblingState.contract;
    if (stateContract !== sibling.contract) {
      throw new Error(
        `Recipe sibling ${sibling.id} state contract does not match its record.`,
      );
    }
    if (siblingState.definitionSha256 !== sibling.definitionSha256) {
      throw new Error(
        `Recipe sibling ${sibling.id} state definition does not match its record.`,
      );
    }
    claimed.add(sibling.id);
    (projection as Record<string, unknown>)[descriptor.field] = cloneJson(
      siblingState,
    );
  }
  return projection;
}

function applySiblingProjection(
  goon: GoonRecord,
  state: RecipeStateSnapshot,
) {
  const projection = projectSiblingState(state);
  goon.appearanceDials = projection.appearanceDials;
  for (const field of [
    "facialArtwork",
    "eyeAppearance",
    "oralAppearance",
    "lipArtwork",
  ] as const) {
    const value = projection[field];
    if (value) goon[field] = value as never;
    else delete goon[field];
  }
}

export function recipeOwnerV2(
  goon: Pick<GoonRecord, "recipe"> | null | undefined,
): GoonRecipeV2 | null {
  return goon?.recipe?.contract === GOON_RECIPE_OWNER_V2_CONTRACT
    ? goon.recipe
    : null;
}

export function isMountedRecipeLiveGoon(
  goon: Pick<GoonRecord, "recipe"> | null | undefined,
) {
  return Boolean(recipeOwnerV2(goon)?.activeRevision);
}

export function projectGoonRecipeSource(
  goon: GoonRecord,
  options: {
    source?: RecipeSource;
    state?: RecipeStateSnapshot;
  } = {},
): GoonRecord {
  const owner = recipeOwnerV2(goon);
  if (!owner) return goon;
  const source = options.source ?? owner.authoringRevision.source;
  const state = options.state ?? owner.authoringRevision.state;
  const projected = cloneJson(goon);
  projected.customAvatar = {
    ...(projected.customAvatar ?? {}),
    package: sourceFileRef(source.package, "recipe-source.bgoon"),
    model: sourceFileRef(source.model, "avatar.glb"),
    manifest: sourceFileRef(source.manifest, "avatar.json"),
  };
  delete projected.customAvatar.pending;
  delete projected.customAvatar.backup;
  applySiblingProjection(projected, state);
  return projected;
}

export function resolveGoonLiveActivationKey(
  goon: GoonRecord | null | undefined,
) {
  if (!goon) return "";
  const owner = recipeOwnerV2(goon);
  const avatar = [
    goon.customAvatar?.package?.url ?? "",
    goon.customAvatar?.model?.url ?? goon.files?.vrmPending?.url ?? goon.files?.vrm?.url ?? "",
    goon.customAvatar?.manifest?.url ?? goon.guidedAvatar?.manifest?.url ?? "",
  ];
  if (!owner?.activeRevision) return [goon.id, ...avatar].join("::");
  return [
    goon.id,
    owner.activeRevision.ref,
    owner.activeRevision.sha256,
    ...avatar,
  ].join("::");
}

export function applyRecipeRevisionProjection(
  goon: GoonRecord,
  envelope: RecipeRevisionEnvelope,
  toFileRef: (
    asset: RecipeStoredAssetRef,
    role: "package" | "model" | "manifest",
  ) => GoonFileRef,
) {
  goon.customAvatar = {
    ...(goon.customAvatar ?? {}),
    package: toFileRef(envelope.live.package, "package"),
    model: toFileRef(envelope.live.model, "model"),
    manifest: toFileRef(envelope.live.manifest, "manifest"),
  };
  delete goon.customAvatar.pending;
  delete goon.customAvatar.backup;
  applySiblingProjection(goon, envelope.revision.state);
  if (goon.recipeFitReceipts) {
    goon.recipeFitReceipts = reconcileGoonRecipeFitReceipts(
      goon.recipeFitReceipts,
      recipeRevisionIdentity(envelope.revision),
    );
  }
  return goon;
}

export function findRecipeSiblingState(
  state: RecipeStateSnapshot,
  ids: readonly string[],
): RecipeSiblingStateRecord | null {
  const matches = state.siblings.filter((sibling) => ids.includes(sibling.id));
  if (matches.length > 1) {
    throw new Error(`Recipe State ambiguously binds sibling ids: ${ids.join(", ")}.`);
  }
  return matches[0] ?? null;
}
