import type {
  RecipeBehaviorKind,
  RecipeControlIdentity,
  RecipeControlUpdatePlan,
  RecipeMigrationReport,
  RecipeMigrationReportEntry,
  RecipeSourceIdentity,
  RecipeStableControlKind,
  RecipeUpdateEdge,
  RecipeUpdateJob,
  RecipeUpdatesContract,
} from "../updateContracts";
import {
  RECIPE_STRICT_TOLERANCE_PROFILE,
  RECIPE_UPDATE_JOB_CONTRACT,
  RECIPE_UPDATE_PROOF_CONTRACT,
  RECIPE_UPDATES_CONTRACT,
  buildRecipeUpdateDirectEdgeKey,
} from "../updateContracts";
import { RECIPE_MIGRATION_REPORT_CONTRACT } from "../contractIds";
import { RECIPE_SOURCE_CONTRACT } from "../packageMetadata";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const hash = (index: number) => index.toString(16).padStart(8, "0").repeat(8);

export type RecipeUpdateFixtureControl = {
  id: string;
  controlKind: RecipeStableControlKind;
  componentId: string;
  behaviorKinds: RecipeBehaviorKind[];
  range: [number, number];
  value: number;
};

export type RecipeUpdateFixture = {
  fixtureContract: "recipe-update-fixture/v1";
  fixtureVersion: "v1" | "v2";
  identity: RecipeSourceIdentity;
  controls: RecipeUpdateFixtureControl[];
  unlockedDialIds: string[];
  neutralProofSha256: string;
  materialProofSha256: string;
};

const fromIdentity: RecipeSourceIdentity = {
  contract: RECIPE_SOURCE_CONTRACT,
  schemaVersion: 1,
  baseId: "batshit-base-f",
  fitFamily: "batshit-base-f.v1",
  modelSha256: hash(2),
  manifestSemanticSha256: hash(3),
  definitionSha256: hash(4),
  neutralId: "batshit-base-f.neutral.v1",
  neutralRecipeSha256: hash(5),
  physicalBasisSha256: hash(6),
  behaviorSha256: hash(7),
  componentGraphSha256: hash(8),
  topologySha256: hash(9),
  skeletonHierarchySha256: hash(10),
};

const toIdentity: RecipeSourceIdentity = {
  ...fromIdentity,
  modelSha256: hash(12),
  manifestSemanticSha256: hash(13),
  definitionSha256: hash(14),
  neutralId: "batshit-base-f.neutral.v2",
  neutralRecipeSha256: hash(15),
  physicalBasisSha256: hash(16),
  behaviorSha256: hash(17),
  componentGraphSha256: hash(18),
};

const oldControls: RecipeUpdateFixtureControl[] = [
  {
    id: "affine_remap",
    controlKind: "dial",
    componentId: "component.affine",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.5,
  },
  {
    id: "bilateral_shape",
    controlKind: "dial",
    componentId: "component.bilateral",
    behaviorKinds: ["track", "bilateral-unlock"],
    range: [-1, 1],
    value: 0.25,
  },
  {
    id: "bilateral_shape.left_offset",
    controlKind: "side-offset",
    componentId: "component.bilateral",
    behaviorKinds: ["bilateral-unlock"],
    range: [-0.5, 0.5],
    value: 0.1,
  },
  {
    id: "bilateral_shape.right_offset",
    controlKind: "side-offset",
    componentId: "component.bilateral",
    behaviorKinds: ["bilateral-unlock"],
    range: [-0.5, 0.5],
    value: -0.1,
  },
  {
    id: "blocked_control",
    controlKind: "dial",
    componentId: "component.blocked",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.2,
  },
  {
    id: "exact_keep",
    controlKind: "dial",
    componentId: "component.keep",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.35,
  },
  {
    id: "follower_only",
    controlKind: "dial",
    componentId: "component.follower",
    behaviorKinds: ["follower-only"],
    range: [-1, 1],
    value: 0.4,
  },
  {
    id: "joint_height",
    controlKind: "dial",
    componentId: "component.joint",
    behaviorKinds: ["track", "joint"],
    range: [-1, 1],
    value: 0.15,
  },
  {
    id: "macro_weight",
    controlKind: "dial",
    componentId: "component.macro",
    behaviorKinds: ["macro", "shared-clamp"],
    range: [-1, 1],
    value: -0.2,
  },
  {
    id: "piecewise_remap",
    controlKind: "dial",
    componentId: "component.piecewise",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.4,
  },
  {
    id: "presentation_only",
    controlKind: "dial",
    componentId: "component.presentation",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: -0.3,
  },
  {
    id: "removed_active",
    controlKind: "dial",
    componentId: "component.removed.active",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.45,
  },
  {
    id: "removed_zero",
    controlKind: "dial",
    componentId: "component.removed.zero",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0,
  },
  {
    id: "reset_required",
    controlKind: "dial",
    componentId: "component.reset",
    behaviorKinds: ["track"],
    range: [-1, 1],
    value: 0.3,
  },
  {
    id: "root_scale",
    controlKind: "dial",
    componentId: "component.root",
    behaviorKinds: ["root-scale", "joint"],
    range: [-1, 1],
    value: 0.1,
  },
  {
    id: "shared_clamp_a",
    controlKind: "dial",
    componentId: "component.shared-clamp",
    behaviorKinds: ["track", "shared-clamp"],
    range: [-1, 1],
    value: 0.2,
  },
  {
    id: "shared_clamp_b",
    controlKind: "dial",
    componentId: "component.shared-clamp",
    behaviorKinds: ["track", "shared-clamp"],
    range: [-1, 1],
    value: -0.15,
  },
];

const newControls: RecipeUpdateFixtureControl[] = oldControls
  .filter((control) => !control.id.startsWith("removed_"))
  .map((control) => ({
    ...control,
    value:
      control.id === "affine_remap"
        ? 0.75
        : control.id === "piecewise_remap"
          ? 0.6
          : control.id === "reset_required"
            ? 0
            : control.value,
  }));

newControls.push({
  id: "new_control",
  controlKind: "dial",
  componentId: "component.new",
  behaviorKinds: ["track"],
  range: [-1, 1],
  value: 0,
});
newControls.sort((left, right) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
);

export const recipeUpdateV1Fixture = deepFreeze({
  fixtureContract: "recipe-update-fixture/v1",
  fixtureVersion: "v1",
  identity: fromIdentity,
  controls: oldControls,
  unlockedDialIds: ["bilateral_shape"],
  neutralProofSha256: hash(19),
  materialProofSha256: hash(20),
} satisfies RecipeUpdateFixture);

export const recipeUpdateV2Fixture = deepFreeze({
  fixtureContract: "recipe-update-fixture/v1",
  fixtureVersion: "v2",
  identity: toIdentity,
  controls: newControls,
  unlockedDialIds: ["bilateral_shape"],
  neutralProofSha256: hash(21),
  materialProofSha256: hash(22),
} satisfies RecipeUpdateFixture);

export const RECIPE_UPDATE_PAIR_FIXTURE_SHA256 =
  "e86bedddc13eb9103c885d36229b7667148400f0487e084e5e47d2fb87733310";

const identityFor = (
  seed: number,
  overrides: Partial<RecipeControlIdentity> = {},
): RecipeControlIdentity => ({
  presentationSha256: hash(seed),
  mappingSha256: hash(seed + 1),
  basisSha256: hash(seed + 2),
  behaviorSha256: hash(seed + 3),
  componentSha256: hash(seed + 4),
  ...overrides,
});

const fixtureById = (
  fixture: {
    controls: readonly { readonly id: string; readonly value: number }[];
  },
  id: string,
) => {
  const control = fixture.controls.find((entry) => entry.id === id);
  if (!control) throw new Error(`fixture control ${id} is missing`);
  return control;
};

const oldIdentityById = new Map<string, RecipeControlIdentity>();
oldControls.forEach((control, index) => {
  oldIdentityById.set(control.id, identityFor(30 + index * 5));
});

const unchangedIds = new Set([
  "bilateral_shape",
  "bilateral_shape.left_offset",
  "bilateral_shape.right_offset",
  "exact_keep",
  "follower_only",
  "joint_height",
  "macro_weight",
  "root_scale",
  "shared_clamp_a",
  "shared_clamp_b",
]);

const changedIdentity = (id: string, seed: number): RecipeControlIdentity => {
  const oldIdentity = oldIdentityById.get(id);
  if (!oldIdentity) throw new Error(`old fixture identity ${id} is missing`);
  if (unchangedIds.has(id)) return oldIdentity;
  if (id === "presentation_only") {
    return { ...oldIdentity, presentationSha256: hash(seed) };
  }
  return identityFor(seed);
};

const actionById = new Map<string, RecipeControlUpdatePlan["action"]>([
  ["affine_remap", "affine"],
  ["blocked_control", "blocked"],
  ["piecewise_remap", "piecewise"],
  ["presentation_only", "presentation-only"],
  ["removed_active", "removed"],
  ["removed_zero", "removed"],
  ["reset_required", "reset-required"],
  ["new_control", "new"],
]);

const allIds = [
  ...new Set([...oldControls, ...newControls].map((control) => control.id)),
].sort();
const fromIds = oldControls.map((control) => control.id).sort();
const toIds = newControls.map((control) => control.id).sort();

const controlPlans: RecipeControlUpdatePlan[] = allIds.map((id, index) => {
  const oldControl = oldControls.find((control) => control.id === id) ?? null;
  const newControl = newControls.find((control) => control.id === id) ?? null;
  const action = actionById.get(id) ?? "keep";
  const from = oldControl ? (oldIdentityById.get(id) ?? null) : null;
  const to = newControl
    ? id === "new_control"
      ? identityFor(220)
      : changedIdentity(id, 225 + index * 5)
    : null;
  return {
    id,
    controlKind: (newControl ?? oldControl)!.controlKind,
    action,
    componentId: (newControl ?? oldControl)!.componentId,
    behaviorKinds: [...(newControl ?? oldControl)!.behaviorKinds],
    from,
    to,
    mapping:
      action === "affine"
        ? { kind: "affine", scale: 1.5, offset: 0, proofSha256: hash(226) }
        : action === "piecewise"
          ? {
              kind: "piecewise",
              points: [
                [-1, -1],
                [0, 0],
                [0.4, 0.6],
                [1, 1],
              ],
              proofSha256: hash(227),
            }
          : null,
    reason:
      action === "keep"
        ? "The complete control identity is unchanged."
        : action === "presentation-only"
          ? "Only the label and editor placement changed."
          : action === "new"
            ? "The new control starts at exact neutral."
            : action === "removed"
              ? "The old control no longer exists in v2."
              : action === "reset-required"
                ? "The old result has no unique exact v2 solution."
                : action === "blocked"
                  ? "The component proof is intentionally invalid for automatic migration."
                  : "The authored direct-edge map exactly reproduces the v1 physical result.",
    proofSha256: hash(228 + index),
  };
});

const directEdgeKey = buildRecipeUpdateDirectEdgeKey(fromIdentity, toIdentity);

const updateEdge: RecipeUpdateEdge = {
  id: "batshit-base-f.v1-to-v2",
  directEdgeKey,
  from: fromIdentity,
  to: toIdentity,
  stableIdLedger: {
    fromIds,
    toIds,
    entries: allIds.map((id) => ({
      id,
      fromKind:
        oldControls.find((control) => control.id === id)?.controlKind ?? null,
      toKind:
        newControls.find((control) => control.id === id)?.controlKind ?? null,
    })),
  },
  controls: controlPlans,
  aliases: [],
  siblingSubplans: [
    {
      surface: "facialArtwork",
      fromContract: "facial-artwork/v3",
      toContract: "facial-artwork/v3",
      action: "keep",
      reason: "The Facial Artwork definition and physical basis are unchanged.",
      proofSha256: hash(249),
    },
    {
      surface: "eyeAppearance",
      fromContract: "eye-appearance/v1",
      toContract: "eye-appearance/v2",
      action: "migrate",
      reason:
        "The package carries an explicit Eye Appearance sibling migration.",
      proofSha256: hash(250),
    },
    {
      surface: "oralAppearance",
      fromContract: null,
      toContract: null,
      action: "not-present",
      reason: "Neither fixture contains Oral Appearance state.",
      proofSha256: hash(251),
    },
  ],
  warnings: [
    {
      code: "material-changed",
      message: "The v2 tooth material changed and requires matched preview.",
      requiresPreview: true,
      proofSha256: recipeUpdateV2Fixture.materialProofSha256,
    },
    {
      code: "neutral-changed",
      message:
        "The v2 neutral identity changed and requires absolute-output preview.",
      requiresPreview: true,
      proofSha256: recipeUpdateV2Fixture.neutralProofSha256,
    },
  ],
  proof: {
    contract: RECIPE_UPDATE_PROOF_CONTRACT,
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    scalarTolerance: 1e-7,
    positionToleranceMeters: 1e-6,
    scaleTolerance: 1e-6,
    quaternionToleranceRadians: 1e-6,
    maximumMeasuredError: 0,
    fixtureSha256: RECIPE_UPDATE_PAIR_FIXTURE_SHA256,
    componentProofSha256: hash(253),
    wholeRecipeProofSha256: hash(254),
  },
  edgeSha256:
    "040fc2f9ba119f4aad662a33363d4e91977ee9fa93b4c5a1e51bfa1a032be14e",
};

export const recipeUpdatesFixture = deepFreeze({
  contract: RECIPE_UPDATES_CONTRACT,
  schemaVersion: 1,
  edges: [updateEdge],
} satisfies RecipeUpdatesContract);

const reportEntries: RecipeMigrationReportEntry[] = controlPlans.map((plan) => {
  const oldValue =
    oldControls.find((control) => control.id === plan.id)?.value ?? null;
  const newValue =
    newControls.find((control) => control.id === plan.id)?.value ?? null;
  const classification =
    plan.action === "keep"
      ? "kept"
      : plan.action === "presentation-only"
        ? "presentation-updated"
        : plan.action === "affine" || plan.action === "piecewise"
          ? "remapped"
          : plan.action;
  const requiresRemovedReview = classification === "removed" && oldValue !== 0;
  return {
    id: plan.id,
    classification,
    componentId: plan.componentId,
    oldValue,
    proposedValue: classification === "blocked" ? null : newValue,
    reason: plan.reason,
    proofStatus:
      classification === "kept" ||
      classification === "presentation-updated" ||
      classification === "remapped"
        ? "verified"
        : classification === "reset-required"
          ? "not-preserved"
          : classification === "blocked"
            ? "failed"
            : "not-required",
    maximumError: 0,
    tolerance: 1e-7,
    proofSha256: plan.proofSha256,
    requiresPreview:
      requiresRemovedReview ||
      classification === "reset-required" ||
      classification === "blocked",
    requiresConfirmation:
      requiresRemovedReview || classification === "reset-required",
  } satisfies RecipeMigrationReportEntry;
});

export const recipeMigrationReportFixture = deepFreeze({
  contract: RECIPE_MIGRATION_REPORT_CONTRACT,
  reportId: "migration.batshit-base-f.v1-to-v2",
  directEdgeKey,
  edgeSha256: updateEdge.edgeSha256,
  fromRecipeRevision: 1,
  toRecipeRevision: 2,
  status: "blocked",
  entries: reportEntries,
  warnings: updateEdge.warnings,
  proof: {
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    wholeRecipeMaximumError: 0,
    wholeRecipeRmsError: 0,
    wholeRecipeTolerance: 1e-6,
    wholeRecipeProofSha256: hash(254),
    reportSha256:
      "886b9080a8c78f0413a1d0a3fdac3fe8963ad20825118f33eaffdafb8741e091",
  },
} satisfies RecipeMigrationReport);

export const recipeUpdateReadyJobFixture = deepFreeze({
  contract: RECIPE_UPDATE_JOB_CONTRACT,
  jobId: "recipe-update.fixture.ready",
  goonId: "goon.fixture",
  directEdgeKey,
  edgeSha256: updateEdge.edgeSha256,
  expectedRecipeRevision: 1,
  concurrencyTokenSha256: hash(201),
  attempt: 0,
  state: "ready",
  reportSha256: recipeMigrationReportFixture.proof.reportSha256,
  candidateAssets: [
    {
      role: "source-package",
      ref: "goons/candidates/source.bgoon",
      sha256: hash(11),
      bytes: 12_000,
    },
    {
      role: "source-model",
      ref: "goons/candidates/source.glb",
      sha256: toIdentity.modelSha256,
      bytes: 10_000,
    },
    {
      role: "source-manifest",
      ref: "goons/candidates/source-avatar.json",
      sha256: hash(13),
      bytes: 2_000,
    },
    {
      role: "live-package",
      ref: "goons/candidates/live.bgoon",
      sha256: hash(202),
      bytes: 8_000,
    },
    {
      role: "live-model",
      ref: "goons/candidates/live.glb",
      sha256: hash(203),
      bytes: 7_000,
    },
    {
      role: "live-manifest",
      ref: "goons/candidates/live-avatar.json",
      sha256: hash(204),
      bytes: 1_000,
    },
    {
      role: "live-build-receipt",
      ref: "goons/candidates/live-build.json",
      sha256: hash(205),
      bytes: 1_500,
    },
  ],
  committedRevisionId: null,
  commitReceiptSha256: null,
  failure: null,
} satisfies RecipeUpdateJob);

export const recipeFixtureValues = deepFreeze({
  affineOld: fixtureById(recipeUpdateV1Fixture, "affine_remap").value,
  affineNew: fixtureById(recipeUpdateV2Fixture, "affine_remap").value,
  piecewiseOld: fixtureById(recipeUpdateV1Fixture, "piecewise_remap").value,
  piecewiseNew: fixtureById(recipeUpdateV2Fixture, "piecewise_remap").value,
});
