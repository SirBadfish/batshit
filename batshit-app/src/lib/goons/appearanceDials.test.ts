import { describe, expect, it } from "vitest";
import macroEngineFixture from "./__fixtures__/bodyDialsMacroEngine.json";
import macroParityFixture from "./__fixtures__/bodyDialsMacroParity.json";
import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  appearanceDialValuesEqual,
  getAppearanceRecipeBakeInventory,
  getAppearanceTargetBindings,
  parseAppearanceDialsManifest,
  reconcileAppearanceDialValues,
  relockAppearanceDialSides,
  resolveAppearanceDialState,
  validateAppearanceRuntimeInventory,
  type AppearanceDialMacroAxis,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
  type AppearanceRuntimeInventory,
} from "./appearanceDials";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function provenance(componentId: string) {
  return {
    catalogId: "mh.core.fixture." + componentId,
    componentId,
    license: "CC0-1.0",
    reviewStatus: "approved",
    contentSha256: HASH_A,
    containerSha256: HASH_B,
  };
}

function appearanceNode(
  node: string,
  role: string,
  side: "none" | "left" | "right" | "bilateral",
  overrides: Record<string, unknown> = {},
) {
  return {
    node,
    kind: "mesh",
    role,
    side,
    required: true,
    scalePolicy: "any",
    exactNodeMatches: 1,
    ...overrides,
  };
}

function target(
  morph: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    usages: ["identity"],
    runtimeRetention: "recipe-only",
    side: "none",
    bindings: [{ node: "face", morph }],
    baselineValue: 0,
    influenceMin: -2,
    influenceMax: 2,
    combine: "exclusive",
    impact: "surface",
    provenance: provenance(morph),
    ...overrides,
  };
}

function followerSamples() {
  return [
    {
      input: -1,
      translation: [-0.1, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 1, 0],
    },
    {
      input: 0,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 1, 0],
    },
    {
      input: 1,
      translation: [0.1, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 1, 0],
    },
  ];
}

function buildManifest(): Record<string, any> {
  return {
    contractVersion: 2,
    face: {
      mesh: "Face",
      expressions: { blink: "blink" },
      controls: {
        eyelids_left: { positive: "eyeWideLeft", negative: "eyeBlinkLeft" },
      },
      customMorphs: { scar: "scar" },
    },
    appearanceDials: {
      contract: APPEARANCE_DIALS_CONTRACT,
      definitionSha256: HASH_C,
      neutral: {
        id: "batshit-base-f-v1-neutral",
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
        face: {
          node: "Face",
          kind: "mesh",
          role: "face",
          side: "none",
          required: true,
          scalePolicy: "any",
          exactNodeMatches: 1,
        },
        eyes: {
          node: "Eyes",
          kind: "anchor",
          role: "generic-follower",
          side: "none",
          required: true,
          scalePolicy: "uniform-only",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
        sclera_left: {
          node: "ScleraLeft",
          kind: "mesh",
          role: "eye-sclera",
          side: "left",
          required: true,
          scalePolicy: "any",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
      },
      regions: [
        { id: "body", label: "Body", surface: "body", order: 0 },
        { id: "head", label: "Head", surface: "head-face", order: 0 },
        {
          id: "eyes",
          label: "Eyes",
          surface: "head-face",
          order: 1,
          parentId: "head",
        },
      ],
      targets: {
        face_fullness: target("face_fullness"),
        head_forward: target("head_forward", {
          side: "bilateral",
          influenceMin: -1,
          influenceMax: 1,
          impact: "structural",
          requirements: {
            jointFollow: true,
            followerRefs: ["head-assets"],
          },
        }),
        eye_left: target("eye_left", {
          side: "left",
          combine: "sum-clamp",
        }),
        eye_right: target("eye_right", {
          side: "right",
          combine: "sum-clamp",
        }),
      },
      dials: [
        {
          id: "face_fullness",
          label: "Face Fullness",
          region: "head",
          tier: "core",
          order: 0,
          description: "Gaunt to full face.",
          keywords: ["face", "fullness"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "face_fullness",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "head_projection",
          label: "Head Projection",
          region: "head",
          tier: "detail",
          order: 1,
          description: "Moves the head backward or forward.",
          keywords: ["head", "projection"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "head_forward",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "eye_spacing",
          label: "Eye Spacing",
          region: "eyes",
          tier: "core",
          order: 0,
          description: "Closer to wider-set eyes.",
          keywords: ["eyes", "spacing"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "eye_left",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
            {
              target: "eye_right",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
          symmetry: {
            mode: "linked-with-offsets",
            left: {
              id: "eye_spacing_left_offset",
              label: "Left Offset",
              range: [-0.5, 0.5],
              step: 0.01,
              members: [
                {
                  target: "eye_left",
                  track: [
                    [-0.5, -0.5],
                    [0, 0],
                    [0.5, 0.5],
                  ],
                },
              ],
            },
            right: {
              id: "eye_spacing_right_offset",
              label: "Right Offset",
              range: [-0.5, 0.5],
              step: 0.01,
              members: [
                {
                  target: "eye_right",
                  track: [
                    [-0.5, -0.5],
                    [0, 0],
                    [0.5, 0.5],
                  ],
                },
              ],
            },
          },
        },
        {
          id: "overall_height",
          label: "Overall Height",
          region: "body",
          tier: "core",
          order: 0,
          description: "Uniform avatar height.",
          keywords: ["height", "scale"],
          kind: "root-scale",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          scalePerUnit: 0.15,
        },
      ],
      jointFollow: {
        contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
        space: "avatar-root",
        units: "meters",
        restSkeletonSha256: HASH_E,
        deltas: {
          head_forward: {
            Head: [0, 0, 0.2],
          },
        },
        clipRemap: {
          contract: APPEARANCE_CLIP_REMAP_CONTRACT,
          hipsBone: "mixamorig:Hips",
        },
      },
      followers: {
        "head-assets": {
          contract: APPEARANCE_FOLLOWER_CONTRACT,
          space: "node-parent-rest",
          composition: "rest-relative-follower-channel-id-order/v2",
          interpolation: "linear-trs-slerp-rotation-morph/v2",
          extrapolation: "clamp",
          provenance: {
            ...provenance("head-assets"),
            license: "LicenseRef-Batshit-First-Party",
          },
          nodeIds: ["eyes", "sclera_left"],
          drivers: [
            {
              driver: { kind: "target", id: "head_forward" },
              channels: [
                {
                  id: "eyes-trs",
                  kind: "node-trs",
                  node: "eyes",
                  samples: followerSamples(),
                },
                {
                  id: "sclera-deform",
                  kind: "morph-weight",
                  node: "sclera_left",
                  morph: "follow_head_forward",
                  weightRange: [-1, 1],
                  runtimeRetention: "recipe-only",
                  samples: [
                    [-1, -1],
                    [0, 0],
                    [1, 1],
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

function parse(raw = buildManifest()): AppearanceDialsManifest {
  const parsed = parseAppearanceDialsManifest(raw);
  expect(parsed).not.toBeNull();
  return parsed!;
}

function valueState(
  manifest: AppearanceDialsManifest,
  values: Record<string, number> = {},
  unlockedDialIds: string[] = [],
): AppearanceDialValueState {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values,
    unlockedDialIds,
  };
}

function runtimeInventory(): AppearanceRuntimeInventory {
  return {
    nodes: [
      {
        runtimeId: "body-0",
        node: "Body",
        kind: "mesh",
        localScale: [1, 1, 1],
        morphs: [],
      },
      {
        runtimeId: "face-0",
        node: "Face",
        kind: "mesh",
        localScale: [1, 1, 1],
        morphs: [
          { name: "face_fullness", index: 0, initialWeight: 0 },
          { name: "head_forward", index: 1, initialWeight: 0 },
          { name: "eye_left", index: 2, initialWeight: 0 },
          { name: "eye_right", index: 3, initialWeight: 0 },
          { name: "blink", index: 4, initialWeight: 0 },
          { name: "eyeWideLeft", index: 5, initialWeight: 0 },
          { name: "eyeBlinkLeft", index: 6, initialWeight: 0 },
          { name: "scar", index: 7, initialWeight: 0 },
        ],
      },
      {
        runtimeId: "eyes-0",
        node: "Eyes",
        kind: "anchor",
        parentBone: "Head",
        localScale: [1, 1, 1],
        morphs: [],
      },
      {
        runtimeId: "sclera-left-0",
        node: "ScleraLeft",
        kind: "mesh",
        parentBone: "Head",
        localScale: [1, 1, 1],
        morphs: [{ name: "follow_head_forward", index: 0, initialWeight: 0 }],
      },
    ],
    faceBindings: [
      { runtimeNodeId: "face-0", morph: "blink" },
      { runtimeNodeId: "face-0", morph: "eyeWideLeft" },
      { runtimeNodeId: "face-0", morph: "eyeBlinkLeft" },
      { runtimeNodeId: "face-0", morph: "scar" },
    ],
  };
}

describe("appearance-dials/v2 parser and provenance", () => {
  it("treats a missing block as unsupported and rejects v1/v2 coexistence", () => {
    expect(parseAppearanceDialsManifest({ contractVersion: 2 })).toBeNull();
    const raw = buildManifest();
    raw.dials = { contract: "body-dials/v1" };
    expect(() => parseAppearanceDialsManifest(raw)).toThrow("may not contain");
  });

  it("parses the complete contract and preserves exact target bindings", () => {
    const manifest = parse();
    expect(manifest.definitionSha256).toBe(HASH_C);
    expect(manifest.productResolution.resolutionSha256).toBe(HASH_E);
    expect(manifest.mappedFaceMorphNames).toEqual([
      "blink",
      "eyeBlinkLeft",
      "eyeWideLeft",
      "scar",
    ]);
    expect(manifest.nodes.face.exactNodeMatches).toBe(1);
    expect(manifest.fitEvidence.definitionSha256).toBe(HASH_C);
    expect(getAppearanceTargetBindings(manifest)).toContainEqual({
      target: "head_forward",
      node: "face",
      morph: "head_forward",
    });
  });

  it("allows package dials to omit obsolete inline descriptions with an empty string", () => {
    const raw = buildManifest();
    raw.appearanceDials.dials[0].description = "";
    expect(parseAppearanceDialsManifest(raw)?.dials[0].description).toBe("");
  });

  it("rejects self-asserted ineligible or path-bearing provenance", () => {
    const ccBy = buildManifest();
    ccBy.appearanceDials.targets.face_fullness.provenance.license = "CC-BY-4.0";
    expect(() => parseAppearanceDialsManifest(ccBy)).toThrow(
      "ineligible provenance",
    );

    const path = buildManifest();
    path.appearanceDials.targets.face_fullness.provenance.sourcePath =
      "/tmp/target";
    expect(() => parseAppearanceDialsManifest(path)).toThrow(
      "forbidden path field",
    );

    const rootPath = buildManifest();
    rootPath.appearanceDials.productResolution.sourceLocator =
      "/tmp/resolution";
    expect(() => parseAppearanceDialsManifest(rootPath)).toThrow(
      "forbidden path field",
    );

    const badRootHash = buildManifest();
    badRootHash.appearanceDials.productResolution.policySha256 = "nope";
    expect(() => parseAppearanceDialsManifest(badRootHash)).toThrow(
      "productResolution is malformed",
    );

    const ambiguousArchive = buildManifest();
    ambiguousArchive.appearanceDials.productResolution.archiveSha256 = HASH_F;
    expect(() => parseAppearanceDialsManifest(ambiguousArchive)).toThrow(
      "archive hashes belong to target provenance",
    );

    const targetArchive = buildManifest();
    targetArchive.appearanceDials.targets.face_fullness.provenance.archiveSha256 =
      HASH_F;
    expect(() => parseAppearanceDialsManifest(targetArchive)).not.toThrow();
  });

  it("rejects unstable ids and malformed optional target metadata", () => {
    const reserved = buildManifest();
    reserved.appearanceDials.targets.constructor = target("bad");
    expect(() => parseAppearanceDialsManifest(reserved)).toThrow(
      "appearance target constructor",
    );

    const malformedSole = buildManifest();
    malformedSole.appearanceDials.targets.face_fullness.soleDeltaY = "oops";
    expect(() => parseAppearanceDialsManifest(malformedSole)).toThrow(
      "appearance target face_fullness is malformed",
    );
  });

  it("enforces exact node roles, sides, and acyclic hierarchy", () => {
    const wrongEyeSide = buildManifest();
    wrongEyeSide.appearanceDials.nodes.sclera_left.side = "none";
    expect(() => parseAppearanceDialsManifest(wrongEyeSide)).toThrow(
      "requires a left/right side",
    );

    const cycle = buildManifest();
    cycle.appearanceDials.nodes.body.parent = { kind: "node", id: "face" };
    cycle.appearanceDials.nodes.face.parent = { kind: "node", id: "body" };
    expect(() => parseAppearanceDialsManifest(cycle)).toThrow(
      "node hierarchy contains a cycle",
    );
  });

  it("accepts one brow and eye-treatment canvas per side while preserving eye/oral uniqueness", () => {
    const perSide = buildManifest();
    Object.assign(perSide.appearanceDials.nodes, {
      brow_left: appearanceNode("BS_BrowCanvas_L", "brow-canvas", "left"),
      brow_right: appearanceNode("BS_BrowCanvas_R", "brow-canvas", "right"),
      eye_treatment_left: appearanceNode(
        "BS_EyeTreatmentCanvas_L",
        "eye-treatment-canvas",
        "left",
      ),
      eye_treatment_right: appearanceNode(
        "BS_EyeTreatmentCanvas_R",
        "eye-treatment-canvas",
        "right",
      ),
      teeth_upper: appearanceNode("BS_Teeth_Upper", "teeth-upper", "none"),
    });
    expect(() => parseAppearanceDialsManifest(perSide)).not.toThrow();

    const bilateralBrow = structuredClone(perSide);
    bilateralBrow.appearanceDials.nodes.brow_left.side = "bilateral";
    expect(() => parseAppearanceDialsManifest(bilateralBrow)).toThrow(
      "brow-canvas node brow_left requires a left/right side",
    );

    const duplicateBrowSide = structuredClone(perSide);
    duplicateBrowSide.appearanceDials.nodes.brow_left_second = appearanceNode(
      "BS_Brow_Second_L",
      "brow-canvas",
      "left",
    );
    expect(() => parseAppearanceDialsManifest(duplicateBrowSide)).toThrow(
      "role/side brow-canvas/left is duplicated",
    );

    const duplicateEyeSide = structuredClone(perSide);
    duplicateEyeSide.appearanceDials.nodes.sclera_left_second = appearanceNode(
      "BS_Sclera_Second_L",
      "eye-sclera",
      "left",
    );
    expect(() => parseAppearanceDialsManifest(duplicateEyeSide)).toThrow(
      "role/side eye-sclera/left is duplicated",
    );

    const duplicateOralRole = structuredClone(perSide);
    duplicateOralRole.appearanceDials.nodes.teeth_upper_second = appearanceNode(
      "BS_Teeth_Upper_Second",
      "teeth-upper",
      "none",
    );
    expect(() => parseAppearanceDialsManifest(duplicateOralRole)).toThrow(
      "role/side teeth-upper/none is duplicated",
    );

    const duplicateRuntimeName = structuredClone(perSide);
    duplicateRuntimeName.appearanceDials.nodes.eye_treatment_left.node =
      "BS_BrowCanvas_L";
    expect(() => parseAppearanceDialsManifest(duplicateRuntimeName)).toThrow(
      "runtime node BS_BrowCanvas_L is declared more than once",
    );
  });

  it("rejects prefixed identity morphs that alias mapped Fcl morphs", () => {
    const raw = buildManifest();
    raw.face.expressions.blink = "Fcl_Blink";
    raw.appearanceDials.targets.head_forward.bindings[0].morph =
      "Face.mesh.Fcl_Blink";
    expect(() => parseAppearanceDialsManifest(raw)).toThrow(
      "collides with face animation/custom morph Fcl_Blink",
    );
  });
});

describe("target usages, corrective ownership, and Recipe retention", () => {
  function addDualUseCorrective(raw: Record<string, any>) {
    raw.appearanceDials.targets.butt_corrective = target("butt_corrective", {
      usages: ["identity", "pose-corrective"],
      runtimeRetention: "retain-in-live-goon",
    });
    raw.appearanceDials.dials.push({
      id: "butt_depth",
      label: "Butt Depth",
      region: "body",
      tier: "detail",
      order: 2,
      description: "Adjusts butt depth.",
      keywords: ["butt", "depth"],
      kind: "tracks",
      range: [-1, 1],
      default: 0,
      step: 0.01,
      members: [
        {
          target: "butt_corrective",
          track: [
            [-1, -1],
            [0, 0],
            [1, 1],
          ],
        },
      ],
    });
    raw.rig = {
      correctives: {
        entries: [{ target: "butt_corrective" }],
      },
    };
  }

  it("keeps dual-use corrective channels and removes identity-only channels", () => {
    const raw = buildManifest();
    addDualUseCorrective(raw);
    const inventory = getAppearanceRecipeBakeInventory(parse(raw));
    expect(inventory.retainInLiveGoonTargetIds).toEqual(["butt_corrective"]);
    expect(inventory.bakeAndRemoveTargetIds).toContain("face_fullness");
    expect(inventory.bakeAndRemoveFollowerMorphs).toContainEqual({
      follower: "head-assets",
      channel: "sclera-deform",
      node: "sclera_left",
      morph: "follow_head_forward",
    });
    expect(inventory.bakeFollowerNodeTransforms).toContainEqual({
      follower: "head-assets",
      channel: "eyes-trs",
      node: "eyes",
    });
    expect(inventory.bakeJointRestTargetIds).toEqual(["head_forward"]);
    expect(inventory.preserveDynamicFaceMorphNames).toContain("blink");
  });

  it("rejects retention drift and missing/trespassing corrective ownership", () => {
    const wrongRetention = buildManifest();
    addDualUseCorrective(wrongRetention);
    wrongRetention.appearanceDials.targets.butt_corrective.runtimeRetention =
      "recipe-only";
    expect(() => parseAppearanceDialsManifest(wrongRetention)).toThrow(
      "inconsistent runtime retention",
    );

    const orphan = buildManifest();
    addDualUseCorrective(orphan);
    orphan.rig.correctives.entries = [];
    expect(() => parseAppearanceDialsManifest(orphan)).toThrow(
      "no rig.correctives ownership",
    );

    const trespass = buildManifest();
    trespass.rig = { correctives: { entries: [{ target: "face_fullness" }] } };
    expect(() => parseAppearanceDialsManifest(trespass)).toThrow(
      "lacks pose-corrective usage",
    );
  });
});

describe("runtime node/index ownership", () => {
  it("binds every declared morph to one concrete zero-weight runtime index", () => {
    const result = validateAppearanceRuntimeInventory(
      parse(),
      runtimeInventory(),
    );
    expect(result.bindings).toHaveLength(4);
    expect(result.followerMorphBindings).toHaveLength(1);
    expect(result.ownedRuntimeKeys.size).toBe(5);
    expect(result.runtimeNodeIdsByManifestNode.get("eyes")).toBe("eyes-0");
  });

  it("rejects missing/ambiguous nodes, missing morphs, and nonzero loaded weights", () => {
    const missingNode = runtimeInventory();
    missingNode.nodes = missingNode.nodes.filter(
      (node) => node.node !== "Eyes",
    );
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), missingNode),
    ).toThrow("expected exactly 1 runtime node match, got 0");

    const ambiguousNode = runtimeInventory();
    ambiguousNode.nodes.push({
      runtimeId: "face-1",
      node: "Face",
      kind: "mesh",
      localScale: [1, 1, 1],
      morphs: [],
    });
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), ambiguousNode),
    ).toThrow("runtime node match, got 2");

    const missingMorph = runtimeInventory();
    missingMorph.nodes[1].morphs = missingMorph.nodes[1].morphs.filter(
      (morph) => morph.name !== "head_forward",
    );
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), missingMorph),
    ).toThrow("expected one exact runtime morph head_forward");

    const nonzero = runtimeInventory();
    nonzero.nodes[1].morphs[0].initialWeight = 0.25;
    expect(() => validateAppearanceRuntimeInventory(parse(), nonzero)).toThrow(
      "not rebased to zero",
    );
  });

  it("enforces runtime hierarchy and uniform-only presentation scale", () => {
    const wrongParent = runtimeInventory();
    wrongParent.nodes.find((node) => node.node === "Eyes")!.parentBone = "Neck";
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), wrongParent),
    ).toThrow("wrong runtime bone parent");

    const nonUniform = runtimeInventory();
    nonUniform.nodes.find((node) => node.node === "Eyes")!.localScale = [
      1, 1.2, 1,
    ];
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), nonUniform),
    ).toThrow("violates uniform-only scale");
  });

  it("requires complete parser-derived runtime face binding evidence", () => {
    const omitted = runtimeInventory() as any;
    delete omitted.faceBindings;
    expect(() => validateAppearanceRuntimeInventory(parse(), omitted)).toThrow(
      "runtime face binding evidence is required",
    );

    const empty = runtimeInventory();
    empty.faceBindings = [];
    expect(() => validateAppearanceRuntimeInventory(parse(), empty)).toThrow(
      "face binding evidence is incomplete",
    );

    const partial = runtimeInventory();
    partial.faceBindings = partial.faceBindings.filter(
      (binding) => binding.morph !== "scar",
    );
    expect(() => validateAppearanceRuntimeInventory(parse(), partial)).toThrow(
      "face binding evidence is incomplete; missing scar",
    );
  });

  it("detects normalized Fcl aliases by concrete mesh/index, not string equality", () => {
    const raw = buildManifest();
    raw.appearanceDials.targets.head_forward.bindings[0].morph =
      "Face.mesh.Fcl_Blink";
    const manifest = parse(raw);
    const inventory = runtimeInventory();
    inventory.nodes[1].morphs[1].name = "Face.mesh.Fcl_Blink";
    inventory.faceBindings = [{ runtimeNodeId: "face-0", morph: "Fcl_Blink" }];
    expect(() =>
      validateAppearanceRuntimeInventory(manifest, inventory),
    ).toThrow("collides with normalized face morph Fcl_Blink");
  });

  it("does not overblock the same raw morph name on a different mesh", () => {
    const inventory = runtimeInventory();
    inventory.nodes[0].morphs.push({
      name: "face_fullness",
      index: 0,
      initialWeight: 0,
    });
    inventory.faceBindings.push({
      runtimeNodeId: "body-0",
      morph: "face_fullness",
    });
    expect(() =>
      validateAppearanceRuntimeInventory(parse(), inventory),
    ).not.toThrow();
  });

  it("allows an absent explicitly optional follower node", () => {
    const raw = buildManifest();
    raw.appearanceDials.nodes.teeth = {
      node: "Teeth",
      kind: "mesh",
      role: "teeth-upper",
      side: "none",
      required: false,
      scalePolicy: "any",
      exactNodeMatches: 1,
    };
    raw.appearanceDials.followers["head-assets"].nodeIds.push("teeth");
    expect(() =>
      validateAppearanceRuntimeInventory(parse(raw), runtimeInventory()),
    ).not.toThrow();
  });
});

describe("typed follower contract", () => {
  it("supports follower-only Recipe dials without dummy body targets", () => {
    const raw = buildManifest();
    raw.appearanceDials.dials.push({
      id: "oral_depth",
      label: "Oral Depth",
      region: "head",
      tier: "advanced",
      order: 9,
      description: "",
      keywords: ["oral", "depth"],
      kind: "follower-only",
      range: [-1, 1],
      default: 0,
      step: 0.01,
      requirements: { followerRefs: ["oral-depth"] },
    });
    raw.appearanceDials.followers["oral-depth"] = {
      contract: APPEARANCE_FOLLOWER_CONTRACT,
      space: "node-parent-rest",
      composition: "rest-relative-follower-channel-id-order/v2",
      interpolation: "linear-trs-slerp-rotation-morph/v2",
      extrapolation: "clamp",
      provenance: {
        ...provenance("oral-depth"),
        license: "LicenseRef-Batshit-First-Party",
      },
      nodeIds: ["face"],
      drivers: [
        {
          driver: { kind: "dial", id: "oral_depth" },
          channels: [
            {
              id: "oral-depth-translate",
              kind: "node-trs",
              node: "face",
              samples: followerSamples(),
            },
          ],
        },
      ],
    };

    const manifest = parse(raw);
    const resolved = resolveAppearanceDialState(
      manifest,
      valueState(manifest, { oral_depth: 0.5 }),
    );
    expect(resolved.influences.get("face_fullness")).toBe(0);
    expect(resolved.followerState.nodeTransforms).toContainEqual(
      expect.objectContaining({
        follower: "oral-depth",
        channel: "oral-depth-translate",
        node: "face",
        translation: [0.05, 0, 0],
      }),
    );
    expect(
      getAppearanceRecipeBakeInventory(manifest).bakeFollowerNodeTransforms,
    ).toContainEqual({
      follower: "oral-depth",
      channel: "oral-depth-translate",
      node: "face",
    });

    delete raw.appearanceDials.dials.at(-1).requirements;
    expect(() => parseAppearanceDialsManifest(raw)).toThrow(
      "requires one or more followerRefs",
    );
  });

  it("rejects the retired rigid contract and malformed transform channels", () => {
    const retired = buildManifest();
    retired.appearanceDials.followers["head-assets"].contract =
      "rigid-trs-samples/v1";
    expect(() => parseAppearanceDialsManifest(retired)).toThrow(
      "appearance follower head-assets",
    );

    const empty = buildManifest();
    empty.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples = [];
    expect(() => parseAppearanceDialsManifest(empty)).toThrow(
      "empty sample track",
    );

    const noOp = buildManifest();
    noOp.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples = [
      followerSamples()[1],
      { ...followerSamples()[1], input: 1 },
    ];
    expect(() => parseAppearanceDialsManifest(noOp)).toThrow(
      "no-op or uncentered track",
    );

    const nonUniform = buildManifest();
    nonUniform.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples[2].scale = [2, 1, 1];
    expect(() => parseAppearanceDialsManifest(nonUniform)).toThrow(
      "violates uniform-only scale",
    );

    const interpolation = buildManifest();
    interpolation.appearanceDials.followers["head-assets"].interpolation =
      "linear-everything";
    expect(() => parseAppearanceDialsManifest(interpolation)).toThrow(
      "appearance follower head-assets",
    );

    const extrapolation = buildManifest();
    extrapolation.appearanceDials.followers["head-assets"].extrapolation =
      "extend";
    expect(() => parseAppearanceDialsManifest(extrapolation)).toThrow(
      "appearance follower head-assets",
    );
  });

  it("rejects incomplete range coverage and both directions of driver ownership drift", () => {
    const range = buildManifest();
    range.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples = followerSamples().slice(1);
    expect(() => parseAppearanceDialsManifest(range)).toThrow(
      "does not cover target influence range",
    );

    const unclaimed = buildManifest();
    delete unclaimed.appearanceDials.targets.head_forward.requirements
      .followerRefs;
    expect(() => parseAppearanceDialsManifest(unclaimed)).toThrow(
      "unclaimed driver",
    );

    const missingDriver = buildManifest();
    missingDriver.appearanceDials.targets.face_fullness.requirements = {
      followerRefs: ["head-assets"],
    };
    missingDriver.appearanceDials.followers[
      "head-assets"
    ].drivers[0].driver.id = "face_fullness";
    missingDriver.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples = followerSamples().map(
      (sample, index) => ({
        ...sample,
        input: index === 0 ? -2 : index === 2 ? 2 : 0,
      }),
    );
    missingDriver.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[1].samples = [
      [-2, -1],
      [0, 0],
      [2, 1],
    ];
    expect(() => parseAppearanceDialsManifest(missingDriver)).toThrow(
      "head_forward has no executable driver",
    );
  });

  it("supports logical-dial drivers and resolves deterministic rest-relative outputs", () => {
    const raw = buildManifest();
    const follower = raw.appearanceDials.followers["head-assets"];
    delete raw.appearanceDials.targets.head_forward.requirements.followerRefs;
    raw.appearanceDials.dials[1].requirements = {
      followerRefs: ["head-assets"],
    };
    follower.drivers[0].driver = { kind: "dial", id: "head_projection" };
    follower.drivers[0].channels[0].samples[2].rotation = [
      0,
      0,
      Math.SQRT1_2,
      Math.SQRT1_2,
    ];
    follower.drivers[0].channels.push({
      id: "aaa-sclera-trs",
      kind: "node-trs",
      node: "sclera_left",
      samples: followerSamples(),
    });
    const manifest = parse(raw);
    const state = resolveAppearanceDialState(
      manifest,
      valueState(manifest, { head_projection: 0.5 }),
    );
    expect(
      state.followerInputs.get("head-assets")?.get("dial:head_projection"),
    ).toBe(0.5);
    expect(
      state.followerState.nodeTransforms.map((entry) => entry.channel),
    ).toEqual(["aaa-sclera-trs", "eyes-trs"]);
    const eyes = state.followerState.nodeTransforms[1];
    expect(eyes).toEqual(
      expect.objectContaining({
        follower: "head-assets",
        channel: "eyes-trs",
        node: "eyes",
        translation: [0.05, 0, 0],
        scale: [1, 1, 1],
      }),
    );
    expect(eyes.rotation[2]).toBeCloseTo(0.382683, 5);
    expect(eyes.rotation[3]).toBeCloseTo(0.92388, 5);
    expect(state.followerState.morphs).toEqual([
      expect.objectContaining({
        follower: "head-assets",
        channel: "sclera-deform",
        node: "sclera_left",
        weight: 0.5,
      }),
    ]);
  });

  it("requires first-party follower provenance and fit evidence bound to the definition", () => {
    const cc0Follower = buildManifest();
    cc0Follower.appearanceDials.followers["head-assets"].provenance.license =
      "CC0-1.0";
    expect(() => parseAppearanceDialsManifest(cc0Follower)).toThrow(
      "ineligible provenance",
    );

    const staleFit = buildManifest();
    staleFit.appearanceDials.fitEvidence.definitionSha256 = HASH_F;
    expect(() => parseAppearanceDialsManifest(staleFit)).toThrow(
      "fitEvidence is malformed or stale",
    );
  });
});

describe("joint-follow/remap contract", () => {
  it("requires two-way target ownership and rejects retired unversioned fields", () => {
    const unclaimed = buildManifest();
    delete unclaimed.appearanceDials.targets.head_forward.requirements
      .jointFollow;
    expect(() => parseAppearanceDialsManifest(unclaimed)).toThrow(
      "inconsistent joint-follow ownership",
    );

    const missing = buildManifest();
    delete missing.appearanceDials.jointFollow.deltas.head_forward;
    expect(() => parseAppearanceDialsManifest(missing)).toThrow(
      "jointFollow is malformed",
    );

    const retired = buildManifest();
    retired.appearanceDials.hipsClipRemap = "rest-relative/v1";
    expect(() => parseAppearanceDialsManifest(retired)).toThrow(
      "retired unversioned joint/remap fields",
    );
  });

  it("rejects unknown space, units, rest hash, and clip remap", () => {
    const space = buildManifest();
    space.appearanceDials.jointFollow.space = "bone-local";
    expect(() => parseAppearanceDialsManifest(space)).toThrow(
      "jointFollow is malformed",
    );

    const hash = buildManifest();
    hash.appearanceDials.jointFollow.restSkeletonSha256 = "unknown";
    expect(() => parseAppearanceDialsManifest(hash)).toThrow(
      "jointFollow is malformed",
    );

    const remap = buildManifest();
    remap.appearanceDials.jointFollow.clipRemap.contract = "typo/v1";
    expect(() => parseAppearanceDialsManifest(remap)).toThrow(
      "clipRemap is malformed",
    );
  });
});

describe("versioned value reconciliation and bilateral unlock semantics", () => {
  it("reports clamps, prunes, and hidden-side resets explicitly", () => {
    const manifest = parse();
    const stored = valueState(manifest, {
      face_fullness: 9,
      eye_spacing_left_offset: 0.4,
      stale_old_dial: 0.7,
    });
    const result = reconcileAppearanceDialValues(manifest, stored);
    expect(result.incompatible).toBe(false);
    expect(result.values.face_fullness).toBe(1);
    expect(result.clampedIds).toEqual(["face_fullness"]);
    expect(result.prunedIds).toEqual(["stale_old_dial"]);
    expect(result.resetIds).toEqual(["eye_spacing_left_offset"]);
    expect(result.values.eye_spacing_left_offset).toBe(0);
  });

  it("blocks definition/neutral drift instead of silently reinterpreting values", () => {
    const manifest = parse();
    const stored = valueState(manifest, { face_fullness: 0.8 });
    stored.definitionSha256 = HASH_F;
    stored.neutralRecipeSha256 = HASH_A;
    const result = reconcileAppearanceDialValues(manifest, stored);
    expect(result.incompatible).toBe(true);
    expect(result.incompatibilityReasons).toEqual([
      "definition mismatch",
      "neutral recipe mismatch",
    ]);
    expect(result.values.face_fullness).toBe(0);
    expect(result.resetIds).toContain("face_fullness");
    expect(() => resolveAppearanceDialState(manifest, stored)).toThrow(
      "cannot resolve incompatible appearance dial state",
    );
  });

  it("applies offsets only while unlocked and relocking resets both sides", () => {
    const manifest = parse();
    const locked = valueState(manifest, {
      eye_spacing: 0.5,
      eye_spacing_left_offset: 0.2,
      eye_spacing_right_offset: -0.1,
    });
    const lockedState = resolveAppearanceDialState(manifest, locked);
    expect(lockedState.influences.get("eye_left")).toBeCloseTo(0.5);
    expect(lockedState.influences.get("eye_right")).toBeCloseTo(0.5);

    const unlocked = valueState(manifest, locked.values, ["eye_spacing"]);
    const unlockedState = resolveAppearanceDialState(manifest, unlocked);
    expect(unlockedState.influences.get("eye_left")).toBeCloseTo(0.7);
    expect(unlockedState.influences.get("eye_right")).toBeCloseTo(0.4);

    const relocked = relockAppearanceDialSides(
      manifest,
      unlocked,
      "eye_spacing",
    );
    expect(relocked.unlockedDialIds).toEqual([]);
    expect(relocked.values.eye_spacing_left_offset).toBe(0);
    expect(relocked.values.eye_spacing_right_offset).toBe(0);
  });

  it("prunes invalid unlock ids and compares the whole versioned envelope", () => {
    const manifest = parse();
    const a = valueState(manifest, { face_fullness: 0.2 }, ["eye_spacing"]);
    const b = valueState(manifest, { face_fullness: 0.2 }, ["eye_spacing"]);
    expect(appearanceDialValuesEqual(a, b)).toBe(true);
    b.definitionSha256 = HASH_F;
    expect(appearanceDialValuesEqual(a, b)).toBe(false);

    const stale = valueState(manifest, {}, ["face_fullness", "missing"]);
    const result = reconcileAppearanceDialValues(manifest, stale);
    expect(result.prunedUnlockIds).toEqual(["face_fullness", "missing"]);

    const duplicate = valueState(manifest, {}, ["eye_spacing", "eye_spacing"]);
    expect(
      reconcileAppearanceDialValues(manifest, duplicate).incompatible,
    ).toBe(true);
  });
});

describe("complete resolver reset state", () => {
  it("returns explicit zero entries for every target, bone, and follower input", () => {
    const manifest = parse();
    const state = resolveAppearanceDialState(manifest, null);
    expect([...state.influences.keys()].sort()).toEqual([
      "eye_left",
      "eye_right",
      "face_fullness",
      "head_forward",
    ]);
    expect([...state.influences.values()].every((value) => value === 0)).toBe(
      true,
    );
    expect(state.jointOffsets.get("Head")).toEqual([0, 0, 0]);
    expect(
      state.followerInputs.get("head-assets")?.get("target:head_forward"),
    ).toBe(0);
    expect(state.followerState.nodeTransforms[0]).toEqual(
      expect.objectContaining({
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }),
    );
    expect(state.followerState.morphs[0].weight).toBe(0);
    expect(state.rootScale).toBe(1);
    expect(state.soleOffsetY).toBe(0);
  });

  it("resolves nonzero state and then produces a complete reset state", () => {
    const manifest = parse();
    const active = resolveAppearanceDialState(
      manifest,
      valueState(manifest, { head_projection: 0.5 }),
    );
    expect(active.influences.get("head_forward")).toBeCloseTo(0.5);
    expect(active.jointOffsets.get("Head")).toEqual([0, 0, 0.1]);
    expect(
      active.followerInputs.get("head-assets")?.get("target:head_forward"),
    ).toBeCloseTo(0.5);

    const reset = resolveAppearanceDialState(manifest, valueState(manifest));
    expect(reset.influences.get("head_forward")).toBe(0);
    expect(reset.jointOffsets.get("Head")).toEqual([0, 0, 0]);
    expect(
      reset.followerInputs.get("head-assets")?.get("target:head_forward"),
    ).toBe(0);
    expect(reset.followerState.nodeTransforms[0].translation).toEqual([
      0, 0, 0,
    ]);
    expect(reset.followerState.morphs[0].weight).toBe(0);
  });
});

describe("side ownership and strict structural validation", () => {
  it("rejects cross-wired or unrelated side offsets", () => {
    const cross = buildManifest();
    cross.appearanceDials.dials[2].symmetry.left.members[0].target =
      "eye_right";
    expect(() => parseAppearanceDialsManifest(cross)).toThrow(
      "invalid left offset ownership",
    );

    const unrelated = buildManifest();
    unrelated.appearanceDials.dials[2].symmetry.left.members[0].target =
      "face_fullness";
    expect(() => parseAppearanceDialsManifest(unrelated)).toThrow(
      "invalid left offset ownership",
    );
  });

  it("rejects duplicate members, cyclic/cross-surface regions, and unsafe root scale", () => {
    const duplicate = buildManifest();
    duplicate.appearanceDials.dials[0].members.push(
      duplicate.appearanceDials.dials[0].members[0],
    );
    expect(() => parseAppearanceDialsManifest(duplicate)).toThrow(
      "repeats target",
    );

    const cycle = buildManifest();
    cycle.appearanceDials.regions[1].parentId = "eyes";
    expect(() => parseAppearanceDialsManifest(cycle)).toThrow(
      "hierarchy contains a cycle",
    );

    const crossSurface = buildManifest();
    crossSurface.appearanceDials.regions[1].parentId = "body";
    expect(() => parseAppearanceDialsManifest(crossSurface)).toThrow(
      "has an invalid parent",
    );

    const scale = buildManifest();
    scale.appearanceDials.dials[3].scalePerUnit = 2;
    expect(() => parseAppearanceDialsManifest(scale)).toThrow(
      "collapse or invert",
    );

    const zeroScale = buildManifest();
    zeroScale.appearanceDials.dials[3].scalePerUnit = 0;
    expect(() => parseAppearanceDialsManifest(zeroScale)).toThrow(
      "requires an effective scalePerUnit",
    );

    const overflowScale = buildManifest();
    overflowScale.appearanceDials.dials[3].range = [-Number.MIN_VALUE, 2];
    overflowScale.appearanceDials.dials[3].step = 1;
    overflowScale.appearanceDials.dials[3].scalePerUnit = Number.MAX_VALUE;
    expect(() => parseAppearanceDialsManifest(overflowScale)).toThrow(
      "produces a non-finite endpoint scale",
    );

    const outOfBounds = buildManifest();
    outOfBounds.appearanceDials.dials[0].members[0].track[2][1] = 9;
    expect(() => parseAppearanceDialsManifest(outOfBounds)).toThrow(
      "exceeds its influence bounds",
    );
  });

  it("requires body and head-face regions plus at least one dial on each surface", () => {
    const bodyRegionsOnly = buildManifest();
    for (const region of bodyRegionsOnly.appearanceDials.regions) {
      region.surface = "body";
    }
    expect(() => parseAppearanceDialsManifest(bodyRegionsOnly)).toThrow(
      "requires at least one head-face region",
    );

    const headRegionsOnly = buildManifest();
    for (const region of headRegionsOnly.appearanceDials.regions) {
      region.surface = "head-face";
    }
    expect(() => parseAppearanceDialsManifest(headRegionsOnly)).toThrow(
      "requires at least one body region",
    );

    const bodyDialsOnly = buildManifest();
    for (const dial of bodyDialsOnly.appearanceDials.dials) {
      dial.region = "body";
    }
    expect(() => parseAppearanceDialsManifest(bodyDialsOnly)).toThrow(
      "requires at least one dial on the head-face surface",
    );

    const headDialsOnly = buildManifest();
    for (const dial of headDialsOnly.appearanceDials.dials) {
      dial.region = "head";
    }
    expect(() => parseAppearanceDialsManifest(headDialsOnly)).toThrow(
      "requires at least one dial on the body surface",
    );
  });
});

describe("track range, effective-change, and finite-output guards", () => {
  it("rejects partial or constant main and side member tracks", () => {
    const partialMain = buildManifest();
    partialMain.appearanceDials.dials[0].members[0].track = [
      [-0.5, -0.5],
      [0, 0],
      [0.5, 0.5],
    ];
    expect(() => parseAppearanceDialsManifest(partialMain)).toThrow(
      "does not cover its declared input range",
    );

    const constantMain = buildManifest();
    constantMain.appearanceDials.dials[0].members[0].track = [
      [-1, 0],
      [0, 0],
      [1, 0],
    ];
    expect(() => parseAppearanceDialsManifest(constantMain)).toThrow(
      "does not produce an effective change",
    );

    const partialSide = buildManifest();
    partialSide.appearanceDials.dials[2].symmetry.left.members[0].track = [
      [-0.25, -0.25],
      [0, 0],
      [0.25, 0.25],
    ];
    expect(() => parseAppearanceDialsManifest(partialSide)).toThrow(
      "eye_spacing:left target eye_left does not cover its declared input range",
    );

    const constantSide = buildManifest();
    constantSide.appearanceDials.dials[2].symmetry.left.members[0].track = [
      [-0.5, 0],
      [0, 0],
      [0.5, 0],
    ];
    expect(() => parseAppearanceDialsManifest(constantSide)).toThrow(
      "eye_spacing:left target eye_left does not produce an effective change",
    );

    const unsafeInterpolation = buildManifest();
    unsafeInterpolation.appearanceDials.dials[0].members[0].track = [
      [-Number.MAX_VALUE, -1],
      [Number.MAX_VALUE, 1],
    ];
    expect(() => parseAppearanceDialsManifest(unsafeInterpolation)).toThrow(
      "has a malformed target member",
    );
  });

  it("fails loudly before or after arithmetic overflow can reach runtime transforms", () => {
    const morphOverflow = buildManifest();
    const faceTarget = morphOverflow.appearanceDials.targets.face_fullness;
    faceTarget.combine = "sum-clamp";
    faceTarget.influenceMin = -Number.MAX_VALUE;
    faceTarget.influenceMax = Number.MAX_VALUE;
    const overflowTrack = [
      [-1, -Number.MAX_VALUE],
      [0, 0],
      [1, Number.MAX_VALUE],
    ];
    morphOverflow.appearanceDials.dials[0].members[0].track = overflowTrack;
    morphOverflow.appearanceDials.dials.push({
      ...morphOverflow.appearanceDials.dials[0],
      id: "face_fullness_second",
      order: 99,
      members: [{ target: "face_fullness", track: overflowTrack }],
    });
    const morphManifest = parse(morphOverflow);
    expect(() =>
      resolveAppearanceDialState(
        morphManifest,
        valueState(morphManifest, {
          face_fullness: 1,
          face_fullness_second: 1,
        }),
      ),
    ).toThrow("non-finite morph influence");

    const rootManifest = parse();
    const rootDial = rootManifest.dials.find(
      (dial) => dial.id === "overall_height",
    )!;
    rootDial.range = [-1, 2];
    rootDial.scalePerUnit = Number.MAX_VALUE;
    expect(() =>
      resolveAppearanceDialState(
        rootManifest,
        valueState(rootManifest, { overall_height: 2 }),
      ),
    ).toThrow("root scale resolved a non-finite transform");

    const jointOverflow = buildManifest();
    jointOverflow.appearanceDials.targets.head_forward.influenceMin = -2;
    jointOverflow.appearanceDials.targets.head_forward.influenceMax = 2;
    jointOverflow.appearanceDials.dials[1].members[0].track = [
      [-1, -2],
      [0, 0],
      [1, 2],
    ];
    jointOverflow.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[0].samples = followerSamples().map(
      (sample, index) => ({
        ...sample,
        input: index === 0 ? -2 : index === 2 ? 2 : 0,
      }),
    );
    jointOverflow.appearanceDials.followers[
      "head-assets"
    ].drivers[0].channels[1].samples = [
      [-2, -1],
      [0, 0],
      [2, 1],
    ];
    jointOverflow.appearanceDials.jointFollow.deltas.head_forward.Head = [
      Number.MAX_VALUE,
      0,
      0,
    ];
    const jointManifest = parse(jointOverflow);
    expect(() =>
      resolveAppearanceDialState(
        jointManifest,
        valueState(jointManifest, { head_projection: 1 }),
      ),
    ).toThrow("joint Head resolved a non-finite transform");

    const soleOverflow = buildManifest();
    soleOverflow.appearanceDials.targets.face_fullness.influenceMin = -2;
    soleOverflow.appearanceDials.targets.face_fullness.influenceMax = 2;
    soleOverflow.appearanceDials.targets.face_fullness.soleDeltaY =
      Number.MAX_VALUE;
    soleOverflow.appearanceDials.dials[0].members[0].track = [
      [-1, -2],
      [0, 0],
      [1, 2],
    ];
    const soleManifest = parse(soleOverflow);
    expect(() =>
      resolveAppearanceDialState(
        soleManifest,
        valueState(soleManifest, { face_fullness: 1 }),
      ),
    ).toThrow("sole offset resolved a non-finite transform");
  });
});

function buildMacroManifest() {
  const raw = buildManifest();
  const fixture = macroEngineFixture as any;
  const cornerTargets = new Map<string, string>();
  fixture.corners.forEach((corner: any, index: number) => {
    const targetId = `macro_target_${index}`;
    cornerTargets.set(corner.key, targetId);
    raw.appearanceDials.targets[targetId] = target(corner.key, {
      bindings: [{ node: "body", morph: corner.key }],
      influenceMin: -10,
      influenceMax: 10,
      provenance: provenance(targetId),
    });
  });

  const baseline = fixture.baselineState as Record<
    AppearanceDialMacroAxis,
    number
  >;
  const axes: AppearanceDialMacroAxis[] = [
    "muscle",
    "weight",
    "cupsize",
    "firmness",
  ];
  for (const [index, axis] of axes.entries()) {
    raw.appearanceDials.dials.push({
      id: `macro_${axis}`,
      label: axis,
      region: "body",
      tier: "core",
      order: 10 + index,
      description: `MPFB ${axis} macro.`,
      keywords: ["macro", axis],
      kind: "macro-axis",
      axis,
      axisTrack: [
        [-1, baseline[axis] - 1],
        [0, baseline[axis]],
        [1, baseline[axis] + 1],
      ],
      range: [-1, 1],
      default: 0,
      step: 0.01,
    });
  }
  raw.appearanceDials.macroEngine = {
    formula: "mpfb-macro-product/v1",
    cutoff: fixture.cutoff,
    baselineState: { ...fixture.baselineState },
    dims: JSON.parse(JSON.stringify(fixture.dims)),
    corners: fixture.corners.map((corner: any, index: number) => ({
      target: cornerTargets.get(corner.key),
      family: `macro_family_${index}`,
      comps: { ...corner.comps },
      fixedFactor: corner.fixedFactor,
      baselineWeight: corner.baselineWeight,
    })),
  };
  return { raw, cornerTargets };
}

describe("shared MPFB macro parity and hostile validation", () => {
  it("replays the complete exporter-generated MPFB ground-truth fixture through v2", () => {
    const { raw, cornerTargets } = buildMacroManifest();
    const manifest = parse(raw);
    const fixture = macroEngineFixture as any;
    const parity = macroParityFixture as any;
    expect(parity.samples.length).toBeGreaterThan(80);
    for (const sample of parity.samples) {
      const storedValues: Record<string, number> = {};
      for (const axis of ["muscle", "weight", "cupsize", "firmness"] as const) {
        storedValues[`macro_${axis}`] =
          sample.dials[axis] - fixture.baselineState[axis];
      }
      const state = resolveAppearanceDialState(
        manifest,
        valueState(manifest, storedValues),
      );
      for (const corner of fixture.corners) {
        const targetId = cornerTargets.get(corner.key)!;
        const absolute =
          (state.influences.get(targetId) ?? 0) + corner.baselineWeight;
        expect(
          Math.abs(absolute - (sample.corners[corner.key] ?? 0)),
          `${corner.key} at ${JSON.stringify(sample.dials)}`,
        ).toBeLessThan(2e-3);
      }
    }
  });

  it("rejects duplicate corner targets, duplicate axes, unknown components, and baseline drift", () => {
    const duplicateCorner = buildMacroManifest().raw;
    duplicateCorner.appearanceDials.macroEngine.corners[1].target =
      duplicateCorner.appearanceDials.macroEngine.corners[0].target;
    expect(() => parseAppearanceDialsManifest(duplicateCorner)).toThrow(
      "macro target",
      "declared more than once",
    );

    const duplicateAxis = buildMacroManifest().raw;
    duplicateAxis.appearanceDials.dials.push({
      ...duplicateAxis.appearanceDials.dials.find(
        (dial: any) => dial.id === "macro_weight",
      ),
      id: "macro_weight_duplicate",
    });
    expect(() => parseAppearanceDialsManifest(duplicateAxis)).toThrow(
      "macro axis weight has multiple dials",
    );

    const missingAxis = buildMacroManifest().raw;
    missingAxis.appearanceDials.dials =
      missingAxis.appearanceDials.dials.filter(
        (dial: any) => dial.id !== "macro_firmness",
      );
    expect(() => parseAppearanceDialsManifest(missingAxis)).toThrow(
      "requires exactly one dial for every axis; missing: firmness",
    );

    const component = buildMacroManifest().raw;
    component.appearanceDials.macroEngine.corners[0].comps.weight =
      "not-a-component";
    expect(() => parseAppearanceDialsManifest(component)).toThrow(
      "unknown weight component",
    );

    const baseline = buildMacroManifest().raw;
    baseline.appearanceDials.macroEngine.corners[0].baselineWeight += 0.1;
    expect(() => parseAppearanceDialsManifest(baseline)).toThrow(
      "baselineWeight drifted",
    );
  });

  it("rejects partial and constant macro-axis tracks", () => {
    const partial = buildMacroManifest().raw;
    const partialWeight = partial.appearanceDials.dials.find(
      (dial: any) => dial.id === "macro_weight",
    );
    const weightBaseline = partial.appearanceDials.macroEngine.baselineState
      .weight as number;
    partialWeight.axisTrack = [
      [-0.5, weightBaseline - 0.5],
      [0, weightBaseline],
      [0.5, weightBaseline + 0.5],
    ];
    expect(() => parseAppearanceDialsManifest(partial)).toThrow(
      "macro dial macro_weight does not cover its declared input range",
    );

    const constant = buildMacroManifest().raw;
    const constantWeight = constant.appearanceDials.dials.find(
      (dial: any) => dial.id === "macro_weight",
    );
    const constantBaseline = constant.appearanceDials.macroEngine.baselineState
      .weight as number;
    constantWeight.axisTrack = [
      [-1, constantBaseline],
      [0, constantBaseline],
      [1, constantBaseline],
    ];
    expect(() => parseAppearanceDialsManifest(constant)).toThrow(
      "macro dial macro_weight does not produce an effective change",
    );
  });
});
