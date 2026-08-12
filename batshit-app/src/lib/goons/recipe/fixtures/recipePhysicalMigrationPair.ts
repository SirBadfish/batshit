import {
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  type AppearanceDialValueState,
} from "../../appearanceDials.contracts";
import {
  createRecipeComponentMapBundle,
  createRecipeExecutableComponentMap,
  type RecipeComponentMapBundle,
} from "../componentMapContracts";
import {
  createRecipeSourceIdentity,
  type RecipeSourceIdentity,
} from "../packageMetadata";
import { canonicalRecipeSha256, sha256Hex } from "../recipeCanonical";
import {
  GOON_RECIPE_STATE_CONTRACT,
  recipeStateSnapshotSha256,
  type RecipeSource,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "../recipeContracts";
import { deriveRecipeSourceProjectionHashes } from "../sourcePackageProjections";
import {
  RECIPE_STRICT_TOLERANCE_PROFILE,
  RECIPE_UPDATE_PROOF_CONTRACT,
  buildRecipeUpdateDirectEdgeKey,
  recipeUpdateEdgeSha256,
  type RecipeBehaviorKind,
  type RecipeControlIdentity,
  type RecipeControlUpdatePlan,
  type RecipeSiblingSurface,
  type RecipeSiblingSubplan,
  type RecipeUpdateEdge,
} from "../updateContracts";

export const RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT =
  "recipe-physical-migration-fixture/v1" as const;

type JsonRecord = Record<string, unknown>;

export type RecipePhysicalMigrationFixture = {
  contract: typeof RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT;
  source: {
    recipeSource: RecipeSource;
    packageBytes: Uint8Array;
    glbBytes: Uint8Array;
    manifestBytes: Uint8Array;
    avatarManifest: JsonRecord;
    identity: RecipeSourceIdentity;
  };
  target: {
    recipeSource: RecipeSource;
    packageBytes: Uint8Array;
    glbBytes: Uint8Array;
    manifestBytes: Uint8Array;
    avatarManifest: JsonRecord;
    identity: RecipeSourceIdentity;
  };
  edge: RecipeUpdateEdge;
  componentMapBundle: RecipeComponentMapBundle;
  sourceState: RecipeStateSnapshot;
  siblingInputs: Record<
    RecipeSiblingSurface,
    {
      sourceStateId: string | null;
      targetStateId: string | null;
      targetDefinition: {
        contract: string;
        definitionSha256: string;
      } | null;
    }
  >;
  fixtureSha256: string;
};

export type RecipePhysicalMigrationFixtureOptions = {
  siblingSubplans?: RecipeSiblingSubplan[];
  sourceSiblings?: RecipeSiblingStateRecord[];
  siblingInputs?: RecipePhysicalMigrationFixture["siblingInputs"];
  runtimeMorphName?: string;
  /** Add the strict runtime performance contract used by manual UI fixtures. */
  runtimePreviewCompatible?: boolean;
  /** Override only for isolated product-policy smoke; defaults preserve the frozen R2 oracle. */
  baseId?: string;
  fitFamily?: string;
  /** Use the canonical Head Size id so generic Hair-import smoke can share this isolated fixture. */
  hairImportCompatible?: boolean;
};

const ZERO_SHA256 = "0".repeat(64);
const ENCODER = new TextEncoder();

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function makeGlb(gltf: JsonRecord, binary: Uint8Array): Uint8Array {
  const json = ENCODER.encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicStoredZip(
  entries: Array<{ name: string; bytes: Uint8Array }>,
): Uint8Array {
  const prepared = entries.map((entry) => ({
    ...entry,
    nameBytes: ENCODER.encode(entry.name),
    crc: crc32(entry.bytes),
  }));
  const localBytes = prepared.reduce(
    (sum, entry) =>
      sum + 30 + entry.nameBytes.byteLength + entry.bytes.byteLength,
    0,
  );
  const centralBytes = prepared.reduce(
    (sum, entry) => sum + 46 + entry.nameBytes.byteLength,
    0,
  );
  const output = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(output.buffer);
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0x22, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.bytes.byteLength, true);
    view.setUint32(offset + 22, entry.bytes.byteLength, true);
    view.setUint16(offset + 26, entry.nameBytes.byteLength, true);
    output.set(entry.nameBytes, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.nameBytes.byteLength);
    offset += 30 + entry.nameBytes.byteLength + entry.bytes.byteLength;
  }
  const centralOffset = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0x22, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.bytes.byteLength, true);
    view.setUint32(offset + 24, entry.bytes.byteLength, true);
    view.setUint16(offset + 28, entry.nameBytes.byteLength, true);
    view.setUint32(offset + 42, offsets[index]!, true);
    output.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.byteLength;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralBytes, true);
  view.setUint32(offset + 16, centralOffset, true);
  return output;
}

class FixtureAccessors {
  readonly bytes: number[] = [];
  readonly bufferViews: JsonRecord[] = [];
  readonly accessors: JsonRecord[] = [];

  floatVec3(values: number[]): number {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0);
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const bufferView = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.bytes.length,
      byteLength: payload.byteLength,
    });
    this.bytes.push(...payload);
    const count = values.length / 3;
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count,
      type: "VEC3",
      min: [0, 1, 2].map((component) =>
        Math.min(
          ...Array.from(
            { length: count },
            (_, row) => values[row * 3 + component]!,
          ),
        ),
      ),
      max: [0, 1, 2].map((component) =>
        Math.max(
          ...Array.from(
            { length: count },
            (_, row) => values[row * 3 + component]!,
          ),
        ),
      ),
    });
    return accessor;
  }
}

const MORPH_NAMES = [
  "affine_shape",
  "complex_shape",
  "keep_shape",
  "new_shape",
  "piecewise_shape",
  "removed_shape",
] as const;
function morphDelta(scale: number, slot: number, vertexCount = 3): number[] {
  const values = new Array(vertexCount * 3).fill(0) as number[];
  values[(slot % 3) * 3 + (slot % 2)] = scale;
  return values;
}

function physicalGlb(
  version: "source" | "target",
  runtimeMorphName?: string,
  hairImportCompatible = false,
): Uint8Array {
  const accessors = new FixtureAccessors();
  const bodyPositions = hairImportCompatible
    ? [
        -0.3, 1.3, -0.2, 0.3, 1.3, -0.2, -0.3, 1.68, 0.2, 0.3, 1.3, -0.2,
        0.3, 1.68, 0.2, -0.3, 1.68, 0.2,
      ]
    : [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const basePosition = accessors.floatVec3(bodyPositions);
  const morphNames = [
    ...MORPH_NAMES,
    ...(runtimeMorphName ? [runtimeMorphName] : []),
  ];
  const morphs = morphNames.map((name, index) =>
    accessors.floatVec3(morphDelta(0.1, index, bodyPositions.length / 3)),
  );
  const binary = Uint8Array.from(accessors.bytes);
  return makeGlb(
    {
      asset: {
        version: "2.0",
        generator: `SA-090 R2 physical fixture ${version}`,
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: accessors.bufferViews,
      accessors: accessors.accessors,
      nodes: [
        { name: "FixtureRoot", children: [1, 2, 3, 4] },
        { name: "Body", mesh: 0 },
        {
          name: "HeadAnchor",
          ...(hairImportCompatible ? { translation: [0, 1.48, 0] } : {}),
        },
        { name: "HipsAnchor" },
        { name: "FeetAnchor" },
      ],
      meshes: [
        {
          name: "FixtureBody",
          extras: { targetNames: morphNames },
          weights: morphNames.map(() => 0),
          primitives: [
            {
              attributes: { POSITION: basePosition },
              targets: morphs.map((POSITION) => ({ POSITION })),
            },
          ],
        },
      ],
    },
    binary,
  );
}

function targetDefinition(morph: string, componentId: string) {
  return {
    usages: ["identity"],
    runtimeRetention: "recipe-only",
    side: "none",
    bindings: [{ node: "body", morph }],
    baselineValue: 0,
    influenceMin: -1,
    influenceMax: 1,
    combine: componentId === "component.complex" ? "sum-clamp" : "exclusive",
    impact: "surface",
    provenance: {
      catalogId: `sa090.r2.${morph}`,
      componentId,
      license: "CC0-1.0",
      reviewStatus: "approved",
      contentSha256: ZERO_SHA256,
    },
  };
}

function dial(
  id: string,
  target: string,
  order: number,
  options: {
    range?: [number, number];
    track?: Array<[number, number]>;
  } = {},
) {
  return {
    id,
    label: id,
    region: id === "keep_control" || id === "head_size" ? "head" : "body",
    tier: "core",
    order,
    description: `SA-090 R2 fixture control ${id}.`,
    keywords: [id],
    kind: "tracks",
    range: options.range ?? [-1, 1],
    default: 0,
    step: 0.01,
    members: [
      {
        target,
        track: options.track ?? [
          [-1, -1],
          [0, 0],
          [1, 1],
        ],
      },
    ],
  };
}

function appearanceManifest(
  version: "source" | "target",
  runtimeMorphName?: string,
  runtimePreviewCompatible = false,
  baseId = "sa090-r2-physical-fixture",
  fitFamily = "sa090-r2-physical-fixture.v1",
  keepControlId = "keep_control",
): JsonRecord {
  const source = version === "source";
  const targets: JsonRecord = {
    affine_target: targetDefinition("affine_shape", "component.affine"),
    complex_target: targetDefinition("complex_shape", "component.complex"),
    keep_target: targetDefinition("keep_shape", "component.keep"),
    piecewise_target: targetDefinition(
      "piecewise_shape",
      "component.piecewise",
    ),
    ...(source
      ? {
          removed_target: targetDefinition(
            "removed_shape",
            "component.removed",
          ),
        }
      : {
          new_target: targetDefinition("new_shape", "component.new"),
        }),
  };
  const dials = [
    dial(
      "affine_control",
      "affine_target",
      0,
      source
        ? {
            range: [-2 / 3, 2 / 3],
            track: [
              [-2 / 3, -1],
              [0, 0],
              [2 / 3, 1],
            ],
          }
        : {},
    ),
    dial("complex_a", "complex_target", 1),
    dial("complex_b", "complex_target", 2),
    dial(keepControlId, "keep_target", 3),
    dial(
      "piecewise_control",
      "piecewise_target",
      4,
      source
        ? {
            track: [
              [-1, -1],
              [0, 0],
              [0.4, 0.6],
              [1, 1],
            ],
          }
        : {},
    ),
    source
      ? dial("removed_control", "removed_target", 5)
      : dial("new_control", "new_target", 5),
  ].sort((left, right) => compareText(left.id, right.id));
  const definitionSha256 = source ? "1".repeat(64) : "2".repeat(64);
  const neutralRecipeSha256 = source ? "3".repeat(64) : "4".repeat(64);
  return {
    rig: {
      baseId,
      fitFamily,
      ...(runtimePreviewCompatible
        ? {
            performance: {
              contract: "batshit-performance-rig/v1",
              space: "node-parent-rest",
              rotation: {
                representation: "rotation-vector",
                units: "radians",
                composition: "ordered-expmap/v1",
              },
              nodes: {
                head: {
                  node: "HeadAnchor",
                  yaw: {
                    axis: [0, 1, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                  pitch: {
                    axis: [1, 0, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                },
                neck: {
                  node: "HipsAnchor",
                  yaw: {
                    axis: [0, 1, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                  pitch: {
                    axis: [1, 0, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                },
                leftEye: {
                  node: "FeetAnchor",
                  yaw: {
                    axis: [0, 1, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                  pitch: {
                    axis: [1, 0, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                },
                rightEye: {
                  node: "Body",
                  yaw: {
                    axis: [0, 1, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                  pitch: {
                    axis: [1, 0, 0],
                    sign: 1,
                    rangeDegrees: { negative: 1, positive: 1 },
                  },
                },
              },
              look: {
                headYawShares: { head: 0.5, neck: 0.5 },
                headPitchShares: { head: 0.5, neck: 0.5 },
                eyeYawMode: "asymmetric-in-out",
                eyePitchMode: "asymmetric-up-down",
              },
              targetTransforms: {
                fixture: {
                  node: "FixtureRoot",
                  combine: "translation-sum-rotation-vector-sum/v1",
                  channels: {
                    fixture_runtime_driver: {
                      translation: [0, 0, 0],
                      rotationVector: [0.01, 0, 0],
                    },
                  },
                },
              },
            },
          }
        : {}),
    },
    stage: {
      anchors: {
        head: "HeadAnchor",
        hips: "HipsAnchor",
        feet: "FeetAnchor",
      },
    },
    appearanceDials: {
      contract: APPEARANCE_DIALS_CONTRACT,
      definitionSha256,
      neutral: {
        id: source ? "sa090-r2-neutral.v1" : "sa090-r2-neutral.v2",
        recipeSha256: neutralRecipeSha256,
      },
      productResolution: {
        contract: APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
        catalogSha256: "5".repeat(64),
        policySha256: "6".repeat(64),
        resolutionSha256: source ? "7".repeat(64) : "8".repeat(64),
      },
      fitEvidence: {
        contract: APPEARANCE_FIT_EVIDENCE_CONTRACT,
        definitionSha256,
        modelSha256: source ? "9".repeat(64) : "a".repeat(64),
        scenarioSetSha256: "b".repeat(64),
        eyeReportSha256: "c".repeat(64),
        oralReportSha256: "d".repeat(64),
        facialArtworkDefinitionSha256: "e".repeat(64),
        facialArtworkContractFileSha256: "f".repeat(64),
        facialArtworkProofSha256: "0".repeat(64),
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
      },
      regions: [
        { id: "body", label: "Body", surface: "body", order: 0 },
        { id: "head", label: "Head", surface: "head-face", order: 0 },
      ],
      dials,
      targets,
      followers: {},
    },
    ...(runtimeMorphName
      ? { face: { expressions: { blink: runtimeMorphName } } }
      : {}),
  };
}

async function sourcePackageDraft(
  version: "source" | "target",
  runtimeMorphName?: string,
  runtimePreviewCompatible = false,
  baseId = "sa090-r2-physical-fixture",
  fitFamily = "sa090-r2-physical-fixture.v1",
  keepControlId = "keep_control",
  hairImportCompatible = false,
) {
  const glbBytes = physicalGlb(version, runtimeMorphName, hairImportCompatible);
  const avatarManifest = appearanceManifest(
    version,
    runtimeMorphName,
    runtimePreviewCompatible,
    baseId,
    fitFamily,
    keepControlId,
  );
  const appearance = avatarManifest.appearanceDials as JsonRecord;
  const neutral = appearance.neutral as JsonRecord;
  let projectionHashes = await deriveRecipeSourceProjectionHashes(
    avatarManifest,
    glbBytes,
  );
  const identity = await createRecipeSourceIdentity(
    {
      baseId,
      fitFamily,
      modelSha256: await sha256Hex(glbBytes),
      definitionSha256: appearance.definitionSha256 as string,
      neutralId: neutral.id as string,
      neutralRecipeSha256: neutral.recipeSha256 as string,
      ...projectionHashes,
    },
    avatarManifest,
  );
  avatarManifest.recipeSource = identity;
  return { glbBytes, avatarManifest, identity };
}

async function finalizeSourcePackage(
  version: "source" | "target",
  draft: Awaited<ReturnType<typeof sourcePackageDraft>>,
  edges: RecipeUpdateEdge[],
) {
  const { glbBytes, avatarManifest, identity } = draft;
  avatarManifest.recipeUpdates = {
    contract: "recipe-updates/v1",
    schemaVersion: 1,
    edges,
  };
  const manifestBytes = ENCODER.encode(JSON.stringify(avatarManifest));
  const packageBytes = deterministicStoredZip([
    { name: "avatar.glb", bytes: glbBytes },
    { name: "avatar.json", bytes: manifestBytes },
  ]);
  const recipeSource: RecipeSource = {
    package: {
      ref: `fixture://${version}/avatar.bgoon`,
      sha256: await sha256Hex(packageBytes),
    },
    model: {
      ref: `fixture://${version}/avatar.glb`,
      sha256: await sha256Hex(glbBytes),
    },
    manifest: {
      ref: `fixture://${version}/avatar.json`,
      sha256: await sha256Hex(manifestBytes),
    },
    identities: identity,
  };
  return {
    recipeSource,
    packageBytes,
    glbBytes,
    manifestBytes,
    avatarManifest,
    identity,
  };
}

async function controlIdentity(
  id: string,
  variant: "source" | "target" | "shared",
): Promise<RecipeControlIdentity> {
  const digest = (suffix: string) =>
    canonicalRecipeSha256({
      contract: "recipe-physical-migration-control-identity/v1",
      id,
      variant,
      suffix,
    });
  return {
    presentationSha256: await digest("presentation"),
    mappingSha256: await digest("mapping"),
    basisSha256: await digest("basis"),
    behaviorSha256: await digest("behavior"),
    componentSha256: await digest("component"),
  };
}

async function updateEdge(
  from: RecipeSourceIdentity,
  to: RecipeSourceIdentity,
  siblingSubplans?: RecipeSiblingSubplan[],
  keepControlId = "keep_control",
): Promise<RecipeUpdateEdge> {
  const fromIds = [
    "affine_control",
    "complex_a",
    "complex_b",
    keepControlId,
    "piecewise_control",
    "removed_control",
  ].sort(compareText);
  const toIds = [
    "affine_control",
    "complex_a",
    "complex_b",
    keepControlId,
    "new_control",
    "piecewise_control",
  ].sort(compareText);
  const allIds = [...new Set([...fromIds, ...toIds])].sort(compareText);
  const sharedKeep = await controlIdentity(keepControlId, "shared");
  const sharedComplexB = await controlIdentity("complex_b", "shared");
  const componentById: Record<string, string> = {
    affine_control: "component.affine",
    complex_a: "component.complex",
    complex_b: "component.complex",
    [keepControlId]: "component.keep",
    new_control: "component.new",
    piecewise_control: "component.piecewise",
    removed_control: "component.removed",
  };
  const actionById: Record<string, RecipeControlUpdatePlan["action"]> = {
    affine_control: "affine",
    complex_a: "affine",
    complex_b: "keep",
    [keepControlId]: "keep",
    new_control: "new",
    piecewise_control: "piecewise",
    removed_control: "removed",
  };
  const controls = await Promise.all(
    allIds.map(async (id): Promise<RecipeControlUpdatePlan> => {
      const action = actionById[id]!;
      const shared =
        id === keepControlId
          ? sharedKeep
          : id === "complex_b"
            ? sharedComplexB
            : null;
      const fromIdentity = fromIds.includes(id)
        ? (shared ?? (await controlIdentity(id, "source")))
        : null;
      const toIdentity = toIds.includes(id)
        ? (shared ?? (await controlIdentity(id, "target")))
        : null;
      return {
        id,
        controlKind: "dial",
        action,
        componentId: componentById[id]!,
        behaviorKinds:
          id === "complex_a" || id === "complex_b"
            ? (["track", "shared-clamp"] satisfies RecipeBehaviorKind[])
            : ["track"],
        from: fromIdentity,
        to: toIdentity,
        mapping:
          id === "affine_control"
            ? {
                kind: "affine",
                scale: 1.5,
                offset: 0,
                proofSha256: await canonicalRecipeSha256({ id, map: 1.5 }),
              }
            : id === "complex_a"
              ? {
                  kind: "affine",
                  scale: 1,
                  offset: 0,
                  proofSha256: await canonicalRecipeSha256({ id, map: 1 }),
                }
              : id === "piecewise_control"
                ? {
                    kind: "piecewise",
                    points: [
                      [-1, -1],
                      [0, 0],
                      [0.4, 0.6],
                      [1, 1],
                    ],
                    proofSha256: await canonicalRecipeSha256({
                      id,
                      map: "piecewise",
                    }),
                  }
                : null,
        reason: `SA-090 R2 fixture ${action} case for ${id}.`,
        proofSha256: await canonicalRecipeSha256({ id, action }),
      };
    }),
  );
  controls.sort((left, right) => compareText(left.id, right.id));
  const fixtureSha256 = await canonicalRecipeSha256({
    contract: RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT,
    from,
    to,
    cases: allIds,
  });
  const directEdgeKey = buildRecipeUpdateDirectEdgeKey(from, to);
  const provisional: RecipeUpdateEdge = {
    id: "sa090-r2-physical-fixture.v1-to-v2",
    directEdgeKey,
    from,
    to,
    stableIdLedger: {
      fromIds,
      toIds,
      entries: allIds.map((id) => ({
        id,
        fromKind: fromIds.includes(id) ? "dial" : null,
        toKind: toIds.includes(id) ? "dial" : null,
      })),
    },
    controls,
    aliases: [],
    siblingSubplans:
      siblingSubplans ??
      ["facialArtwork", "eyeAppearance", "oralAppearance"].map((surface) => ({
        surface: surface as RecipeSiblingSurface,
        fromContract: null,
        toContract: null,
        action: "not-present" as const,
        reason: `${surface} is absent from both physical fixture packages.`,
        proofSha256: ZERO_SHA256,
      })),
    warnings: [],
    proof: {
      contract: RECIPE_UPDATE_PROOF_CONTRACT,
      toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
      scalarTolerance: 1e-7,
      positionToleranceMeters: 1e-6,
      scaleTolerance: 1e-6,
      quaternionToleranceRadians: 1e-6,
      maximumMeasuredError: 0,
      fixtureSha256,
      componentProofSha256: await canonicalRecipeSha256({
        fixtureSha256,
        kind: "components",
      }),
      wholeRecipeProofSha256: await canonicalRecipeSha256({
        fixtureSha256,
        kind: "whole",
      }),
    },
    edgeSha256: ZERO_SHA256,
  };
  provisional.edgeSha256 = await recipeUpdateEdgeSha256(provisional);
  return provisional;
}

async function componentMaps(
  edge: RecipeUpdateEdge,
): Promise<RecipeComponentMapBundle> {
  const map = await createRecipeExecutableComponentMap({
    mapId: "map.sa090-r2.component-complex",
    componentId: "component.complex",
    sourceControlIds: ["complex_a", "complex_b"],
    targetControlIds: ["complex_a", "complex_b"],
    sourceUnlockDialIds: [],
    targetUnlockDialIds: [],
    branches: [
      {
        branchId: "all",
        sourceDomain: [
          {
            controlId: "complex_a",
            minimum: -1,
            maximum: 1,
            minimumInclusive: true,
            maximumInclusive: true,
          },
          {
            controlId: "complex_b",
            minimum: -1,
            maximum: 1,
            minimumInclusive: true,
            maximumInclusive: true,
          },
        ],
        sourceUnlockState: [],
        outputs: [
          {
            controlId: "complex_a",
            constant: 0,
            terms: [{ sourceControlId: "complex_a", coefficient: 1 }],
          },
          {
            controlId: "complex_b",
            constant: 0,
            terms: [{ sourceControlId: "complex_b", coefficient: 1 }],
          },
        ],
        targetUnlockState: [],
      },
    ],
    auditedFixtureSha256: edge.proof.fixtureSha256,
    authoredPhysicalEvidenceSha256: await canonicalRecipeSha256({
      edge: edge.edgeSha256,
      proof: "physical-equivalence",
    }),
  });
  return createRecipeComponentMapBundle({
    contract: "recipe-component-maps/v1",
    schemaVersion: 1,
    directEdgeKey: edge.directEdgeKey,
    edgeSha256: edge.edgeSha256,
    fromSource: edge.from,
    toSource: edge.to,
    maps: [map],
  });
}

async function fixtureSourceState(
  identity: RecipeSourceIdentity,
  siblings: RecipeSiblingStateRecord[] = [],
  keepControlId = "keep_control",
): Promise<RecipeStateSnapshot> {
  const appearanceDials: AppearanceDialValueState = {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: identity.definitionSha256,
    neutralId: identity.neutralId,
    neutralRecipeSha256: identity.neutralRecipeSha256,
    values: {
      affine_control: 0.4,
      complex_a: 0.2,
      complex_b: -0.1,
      [keepControlId]: 0.2,
      piecewise_control: 0.4,
      removed_control: 0,
    },
    unlockedDialIds: [],
  };
  const snapshot: RecipeStateSnapshot = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: ZERO_SHA256,
    appearanceDials,
    siblings: structuredClone(siblings).sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
  snapshot.stateSha256 = await recipeStateSnapshotSha256(snapshot);
  return snapshot;
}

/** Build the isolated R2-D physical fixture without touching frozen R1 data. */
export async function createRecipePhysicalMigrationFixture(
  options: RecipePhysicalMigrationFixtureOptions = {},
): Promise<RecipePhysicalMigrationFixture> {
  return (async () => {
    const keepControlId = options.hairImportCompatible
      ? "head_size"
      : "keep_control";
    const [sourceDraft, targetDraft] = await Promise.all([
      sourcePackageDraft(
        "source",
        options.runtimeMorphName,
        options.runtimePreviewCompatible,
        options.baseId,
        options.fitFamily,
        keepControlId,
        options.hairImportCompatible,
      ),
      sourcePackageDraft(
        "target",
        options.runtimeMorphName,
        options.runtimePreviewCompatible,
        options.baseId,
        options.fitFamily,
        keepControlId,
        options.hairImportCompatible,
      ),
    ]);
    const edge = await updateEdge(
      sourceDraft.identity,
      targetDraft.identity,
      options.siblingSubplans,
      keepControlId,
    );
    const [source, target] = await Promise.all([
      finalizeSourcePackage("source", sourceDraft, []),
      finalizeSourcePackage("target", targetDraft, [edge]),
    ]);
    const componentMapBundle = await componentMaps(edge);
    let sourceState = await fixtureSourceState(
      source.identity,
      options.sourceSiblings,
      keepControlId,
    );
    const siblingInputs = options.siblingInputs ?? {
      facialArtwork: {
        sourceStateId: null,
        targetStateId: null,
        targetDefinition: null,
      },
      eyeAppearance: {
        sourceStateId: null,
        targetStateId: null,
        targetDefinition: null,
      },
      oralAppearance: {
        sourceStateId: null,
        targetStateId: null,
        targetDefinition: null,
      },
    };
    const fixtureSha256 = await canonicalRecipeSha256({
      contract: RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT,
      source: source.recipeSource,
      target: target.recipeSource,
      edgeSha256: edge.edgeSha256,
      componentMapBundleSha256: componentMapBundle.bundleSha256,
      sourceStateSha256: sourceState.stateSha256,
      siblingInputs,
    });
    return {
      contract: RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT,
      source,
      target,
      edge,
      componentMapBundle,
      sourceState,
      siblingInputs,
      fixtureSha256,
    };
  })();
}
