import {
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  type AppearanceDialDefinition,
  type AppearanceDialsManifest,
  type AppearanceTargetDefinition,
} from "../appearanceDials.contracts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

export function testAppearanceTarget(
  node: string,
  morph: string,
  overrides: Partial<AppearanceTargetDefinition> = {},
): AppearanceTargetDefinition {
  return {
    usages: ["identity"],
    runtimeRetention: "recipe-only",
    side: "none",
    bindings: [{ node, morph }],
    baselineValue: 0,
    influenceMin: -1,
    influenceMax: 1,
    combine: "exclusive",
    impact: "surface",
    provenance: {
      catalogId: `fixture.${morph}`,
      componentId: morph,
      license: "CC0-1.0",
      reviewStatus: "approved",
      contentSha256: HASH_A,
    },
    ...overrides,
  };
}

export function testTrackDial(
  id: string,
  target: string,
  overrides: Partial<AppearanceDialDefinition> = {},
): AppearanceDialDefinition {
  return {
    id,
    label: id,
    region: "body",
    tier: "core",
    order: 0,
    description: id,
    keywords: [id],
    kind: "tracks",
    range: [-1, 1],
    default: 0,
    step: 0.01,
    members: [
      {
        target,
        track: [
          [-1, -1],
          [0, 0],
          [1, 1],
        ],
      },
    ],
    ...overrides,
  };
}

export function createAppearanceRecipeTestManifest(): AppearanceDialsManifest {
  return {
    contract: APPEARANCE_DIALS_CONTRACT,
    definitionSha256: HASH_C,
    neutral: {
      id: "fixture-neutral",
      recipeSha256: HASH_D,
    },
    productResolution: {
      contract: APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
      catalogSha256: HASH_A,
      policySha256: HASH_B,
      resolutionSha256: HASH_E,
    },
    fitEvidence: {
      contract: APPEARANCE_FIT_EVIDENCE_CONTRACT,
      definitionSha256: HASH_C,
      modelSha256: HASH_D,
      scenarioSetSha256: HASH_E,
      eyeReportSha256: HASH_A,
      oralReportSha256: HASH_B,
      facialArtworkDefinitionSha256: HASH_F,
      facialArtworkContractFileSha256: HASH_E,
      facialArtworkProofSha256: HASH_D,
    },
    mappedFaceMorphNames: [],
    nodes: {
      body: {
        node: "Body",
        kind: "mesh",
        role: "body",
        side: "none",
        required: true,
        scalePolicy: "any",
        exactNodeMatches: 1,
      },
      parent: {
        node: "Parent",
        kind: "anchor",
        role: "generic-follower",
        side: "none",
        required: true,
        scalePolicy: "any",
        exactNodeMatches: 1,
      },
      attachment: {
        node: "Attachment",
        kind: "anchor",
        role: "attachment-anchor",
        side: "none",
        required: true,
        scalePolicy: "any",
        parent: { kind: "node", id: "parent" },
        exactNodeMatches: 1,
      },
      bone_attachment: {
        node: "BoneAttachment",
        kind: "anchor",
        role: "attachment-anchor",
        side: "none",
        required: true,
        scalePolicy: "any",
        parent: { kind: "bone", name: "Head" },
        exactNodeMatches: 1,
      },
    },
    regions: [
      {
        id: "body",
        label: "Body",
        surface: "body",
        order: 0,
      },
    ],
    dials: [],
    targets: {},
    followers: {},
  };
}
