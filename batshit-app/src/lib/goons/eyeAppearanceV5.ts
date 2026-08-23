import {
  LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "./socketEyeArtworkProjection";

export const EYE_APPEARANCE_V5_SCHEMA_VERSION = "eye-appearance/v5" as const;
export const EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION =
  "eye-appearance-state/v5" as const;

export const EYE_APPEARANCE_V5_CONTROL_IDS = [
  "iris_size",
  "pupil_size",
  "iris_horizontal_position",
  "iris_vertical_position",
] as const;

export type EyeAppearanceV5ControlId =
  (typeof EYE_APPEARANCE_V5_CONTROL_IDS)[number];

export const EYE_APPEARANCE_V5_BASELINES = {
  irisNeutralRadiusMeters: 0.0081,
  pupilNeutralRadiusRatio: 0.49,
  neutralHorizontalTravelFraction: -0.5,
  neutralVerticalTravelFraction: -0.7,
} as const;

export const EYE_APPEARANCE_V5_SIZE_RANGE = {
  minimum: 0.5,
  maximum: 1.5,
  default: 1,
} as const;

export type EyeAppearanceStateV5 = {
  schemaVersion: typeof EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION;
  definitionSha256: string;
  irisSize: number;
  pupilSize: number;
  irisHorizontalPosition: number;
  irisVerticalPosition: number;
};

export type EyeAppearanceV5ControlDefinition = {
  id: EyeAppearanceV5ControlId;
  label: string;
  description: string;
  minimum: number;
  maximum: number;
  step: number;
  default: number;
  unit:
    | "neutral-multiplier"
    | "iris-relative-multiplier"
    | "neutral-travel-fraction";
  linkedBilateral: true;
  bilateralLaw: "linked-same-value" | "mirrored-convergence-divergence";
  perEyeOverridesAllowed: false;
  runtimeClampingAllowed: false;
  geometrySemantics: string;
};

export type EyeAppearanceV5RuntimeSideBinding = {
  physicalEyeNode: string;
  irisNeutralRadiusMeters: typeof EYE_APPEARANCE_V5_BASELINES.irisNeutralRadiusMeters;
  pupilNeutralRadiusRatio: typeof EYE_APPEARANCE_V5_BASELINES.pupilNeutralRadiusRatio;
  neutralPlacement: {
    horizontalTravelFraction: typeof EYE_APPEARANCE_V5_BASELINES.neutralHorizontalTravelFraction;
    verticalTravelFraction: typeof EYE_APPEARANCE_V5_BASELINES.neutralVerticalTravelFraction;
  };
  irisHorizontalTravelMeters: number;
  irisVerticalTravelMeters: number;
  edgeSoftnessMeters: number;
  artworkMappings: {
    sclera: typeof SOCKET_EYE_SCLERA_PROJECTION_CONTRACT;
    iris:
      | typeof LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
      | typeof SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
      | typeof SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    pupil:
      | typeof LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
      | typeof SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
      | typeof SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    highlight:
      | typeof LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
      | typeof SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  };
  cornea: {
    roughness: number;
    clearcoat: number;
    clearcoatRoughness: number;
  };
};

export type EyeAppearanceDefinitionV5 = {
  schemaVersion: typeof EYE_APPEARANCE_V5_SCHEMA_VERSION;
  stateSchemaVersion: typeof EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION;
  status: "product-export-approved";
  productExportApproved: true;
  definitionSha256: string;
  dependencies: {
    socketEyeSurface: {
      schemaVersion: "socket-eye-surface/v2";
      definitionSha256: string;
    };
    eyeApertureSeam: {
      schemaVersion: "eye-aperture-seam/v2";
      definitionSha256: string;
    };
  };
  ownership: string;
  zeroLaw: string;
  symmetryLaw: string;
  compositionOrder: [
    "sclera",
    "scleraArtwork",
    "iris",
    "pupil",
    "highlight",
    "cornea",
  ];
  solidColorDefaults: {
    iris: [number, number, number, number];
    pupil: [number, number, number, number];
    sclera: [number, number, number, number];
  };
  runtimeBindings: {
    coordinateSpace: "physical-eye-sphere";
    left: EyeAppearanceV5RuntimeSideBinding;
    right: EyeAppearanceV5RuntimeSideBinding;
    geometryEvidence: {
      acceptedGlbSha256: string;
      socketSurfaceSha256: string;
      apertureSeamSha256: string;
    };
  };
  controls: [
    EyeAppearanceV5ControlDefinition,
    EyeAppearanceV5ControlDefinition,
    EyeAppearanceV5ControlDefinition,
    EyeAppearanceV5ControlDefinition,
  ];
  rangeEvidence: {
    schemaVersion: string;
    sha256: string;
    canonicalSha256: string;
  };
};

export type EyeAppearanceV5Reconciliation = {
  state: EyeAppearanceStateV5 | null;
  incompatible: boolean;
  reason?: string;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMPOSITION_ORDER = [
  "sclera",
  "scleraArtwork",
  "iris",
  "pupil",
  "highlight",
  "cornea",
] as const;

function fail(message: string): never {
  throw new Error(`[${EYE_APPEARANCE_V5_SCHEMA_VERSION}] ${message}`);
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
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function text(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function finite(value: unknown, context: string) {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${context} must be finite`);
  return value;
}

function positive(value: unknown, context: string) {
  const parsed = finite(value, context);
  if (parsed <= 0) fail(`${context} must be greater than zero`);
  return parsed;
}

function unit(value: unknown, context: string) {
  const parsed = finite(value, context);
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`);
  return parsed;
}

function hash(value: unknown, context: string) {
  const parsed = text(value, context);
  if (!HASH_PATTERN.test(parsed))
    fail(`${context} must be a lowercase SHA-256`);
  return parsed;
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  context: string,
): T {
  if (value !== expected) fail(`${context} must be ${expected}`);
  return expected;
}

function rgba(
  value: unknown,
  context: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4)
    fail(`${context} must contain four channels`);
  return value.map((channel, index) =>
    unit(channel, `${context}[${index}]`),
  ) as [number, number, number, number];
}

function dependency<T extends "socket-eye-surface/v2" | "eye-aperture-seam/v2">(
  value: unknown,
  schemaVersion: T,
  context: string,
) {
  const source = record(value, context);
  exactKeys(source, ["schemaVersion", "definitionSha256"], context);
  return {
    schemaVersion: literal(
      source.schemaVersion,
      schemaVersion,
      `${context}.schemaVersion`,
    ),
    definitionSha256: hash(
      source.definitionSha256,
      `${context}.definitionSha256`,
    ),
  };
}

function runtimeSide(
  value: unknown,
  context: string,
): EyeAppearanceV5RuntimeSideBinding {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "physicalEyeNode",
      "irisNeutralRadiusMeters",
      "pupilNeutralRadiusRatio",
      "neutralPlacement",
      "irisHorizontalTravelMeters",
      "irisVerticalTravelMeters",
      "edgeSoftnessMeters",
      "artworkMappings",
      "cornea",
    ],
    context,
  );
  const neutral = record(
    source.neutralPlacement,
    `${context}.neutralPlacement`,
  );
  exactKeys(
    neutral,
    ["horizontalTravelFraction", "verticalTravelFraction"],
    `${context}.neutralPlacement`,
  );
  const mappings = record(source.artworkMappings, `${context}.artworkMappings`);
  exactKeys(
    mappings,
    ["sclera", "iris", "pupil", "highlight"],
    `${context}.artworkMappings`,
  );
  const cornea = record(source.cornea, `${context}.cornea`);
  exactKeys(
    cornea,
    ["roughness", "clearcoat", "clearcoatRoughness"],
    `${context}.cornea`,
  );
  const edgeSoftnessMeters = positive(
    source.edgeSoftnessMeters,
    `${context}.edgeSoftnessMeters`,
  );
  if (
    edgeSoftnessMeters >=
    EYE_APPEARANCE_V5_BASELINES.irisNeutralRadiusMeters *
      EYE_APPEARANCE_V5_BASELINES.pupilNeutralRadiusRatio
  ) {
    fail(
      `${context}.edgeSoftnessMeters must stay below the neutral pupil radius`,
    );
  }
  return {
    physicalEyeNode: text(source.physicalEyeNode, `${context}.physicalEyeNode`),
    irisNeutralRadiusMeters: literal(
      source.irisNeutralRadiusMeters,
      EYE_APPEARANCE_V5_BASELINES.irisNeutralRadiusMeters,
      `${context}.irisNeutralRadiusMeters`,
    ),
    pupilNeutralRadiusRatio: literal(
      source.pupilNeutralRadiusRatio,
      EYE_APPEARANCE_V5_BASELINES.pupilNeutralRadiusRatio,
      `${context}.pupilNeutralRadiusRatio`,
    ),
    neutralPlacement: {
      horizontalTravelFraction: literal(
        neutral.horizontalTravelFraction,
        EYE_APPEARANCE_V5_BASELINES.neutralHorizontalTravelFraction,
        `${context}.neutralPlacement.horizontalTravelFraction`,
      ),
      verticalTravelFraction: literal(
        neutral.verticalTravelFraction,
        EYE_APPEARANCE_V5_BASELINES.neutralVerticalTravelFraction,
        `${context}.neutralPlacement.verticalTravelFraction`,
      ),
    },
    irisHorizontalTravelMeters: positive(
      source.irisHorizontalTravelMeters,
      `${context}.irisHorizontalTravelMeters`,
    ),
    irisVerticalTravelMeters: positive(
      source.irisVerticalTravelMeters,
      `${context}.irisVerticalTravelMeters`,
    ),
    edgeSoftnessMeters,
    artworkMappings: {
      sclera: literal(
        mappings.sclera,
        SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
        `${context}.artworkMappings.sclera`,
      ),
      iris: projectionLiteral(
        mappings.iris,
        [
          LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
        ],
        `${context}.artworkMappings.iris`,
      ),
      pupil: projectionLiteral(
        mappings.pupil,
        [
          LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
          SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
        ],
        `${context}.artworkMappings.pupil`,
      ),
      highlight: projectionLiteral(
        mappings.highlight,
        [
          LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
          SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
        ],
        `${context}.artworkMappings.highlight`,
      ),
    },
    cornea: {
      roughness: unit(cornea.roughness, `${context}.cornea.roughness`),
      clearcoat: unit(cornea.clearcoat, `${context}.cornea.clearcoat`),
      clearcoatRoughness: unit(
        cornea.clearcoatRoughness,
        `${context}.cornea.clearcoatRoughness`,
      ),
    },
  };
}

function projectionLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${context} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function socketProjectionMode(
  binding: EyeAppearanceV5RuntimeSideBinding,
  context: string,
): "legacy" | "corrected" | "corrected-inset" {
  const { iris, pupil, highlight } = binding.artworkMappings;
  const legacy =
    iris === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil === LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight === LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  const corrected =
    iris === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil === SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  const correctedInset =
    iris === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    pupil === SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT &&
    highlight === SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
  if (!legacy && !corrected && !correctedInset) {
    fail(
      `${context}.artworkMappings must declare one complete legacy, corrected edge-to-edge, or corrected inset socket-eye projection suite`,
    );
  }
  return correctedInset ? "corrected-inset" : corrected ? "corrected" : "legacy";
}

function expectedControl(id: EyeAppearanceV5ControlId) {
  if (id === "iris_size") {
    return {
      ...EYE_APPEARANCE_V5_SIZE_RANGE,
      unit: "neutral-multiplier" as const,
    };
  }
  if (id === "pupil_size") {
    return {
      ...EYE_APPEARANCE_V5_SIZE_RANGE,
      unit: "iris-relative-multiplier" as const,
    };
  }
  return {
    minimum: -1,
    maximum: 1,
    default: 0,
    unit: "neutral-travel-fraction" as const,
  };
}

function control(
  value: unknown,
  id: EyeAppearanceV5ControlId,
  context: string,
) {
  const source = record(value, context);
  exactKeys(
    source,
    [
      "id",
      "label",
      "description",
      "minimum",
      "maximum",
      "step",
      "default",
      "unit",
      "linkedBilateral",
      "bilateralLaw",
      "perEyeOverridesAllowed",
      "runtimeClampingAllowed",
      "geometrySemantics",
    ],
    context,
  );
  const expected = expectedControl(id);
  literal(source.id, id, `${context}.id`);
  literal(source.minimum, expected.minimum, `${context}.minimum`);
  literal(source.maximum, expected.maximum, `${context}.maximum`);
  literal(source.default, expected.default, `${context}.default`);
  literal(source.unit, expected.unit, `${context}.unit`);
  const bilateralLaw =
    id === "iris_horizontal_position"
      ? ("mirrored-convergence-divergence" as const)
      : ("linked-same-value" as const);
  literal(source.linkedBilateral, true, `${context}.linkedBilateral`);
  literal(source.bilateralLaw, bilateralLaw, `${context}.bilateralLaw`);
  literal(
    source.perEyeOverridesAllowed,
    false,
    `${context}.perEyeOverridesAllowed`,
  );
  literal(
    source.runtimeClampingAllowed,
    false,
    `${context}.runtimeClampingAllowed`,
  );
  const step = positive(source.step, `${context}.step`);
  const spanSteps = (expected.maximum - expected.minimum) / step;
  if (
    Math.abs(spanSteps - Math.round(spanSteps)) >
    Number.EPSILON * 64 * Math.max(1, spanSteps)
  ) {
    fail(`${context}.maximum must be reachable from minimum by whole steps`);
  }
  return {
    id,
    label: text(source.label, `${context}.label`),
    description: text(source.description, `${context}.description`),
    minimum: expected.minimum,
    maximum: expected.maximum,
    step,
    default: expected.default,
    unit: expected.unit,
    linkedBilateral: true as const,
    bilateralLaw,
    perEyeOverridesAllowed: false as const,
    runtimeClampingAllowed: false as const,
    geometrySemantics: text(
      source.geometrySemantics,
      `${context}.geometrySemantics`,
    ),
  };
}

export function parseEyeAppearanceDefinitionV5(
  value: unknown,
): EyeAppearanceDefinitionV5 {
  const source = record(value, "definition");
  exactKeys(
    source,
    [
      "schemaVersion",
      "stateSchemaVersion",
      "status",
      "productExportApproved",
      "definitionSha256",
      "dependencies",
      "ownership",
      "zeroLaw",
      "symmetryLaw",
      "compositionOrder",
      "solidColorDefaults",
      "runtimeBindings",
      "controls",
      "rangeEvidence",
    ],
    "definition",
  );
  literal(
    source.schemaVersion,
    EYE_APPEARANCE_V5_SCHEMA_VERSION,
    "definition.schemaVersion",
  );
  literal(
    source.stateSchemaVersion,
    EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION,
    "definition.stateSchemaVersion",
  );
  literal(source.status, "product-export-approved", "definition.status");
  literal(
    source.productExportApproved,
    true,
    "definition.productExportApproved",
  );
  const compositionOrder = source.compositionOrder;
  if (
    !Array.isArray(compositionOrder) ||
    compositionOrder.length !== COMPOSITION_ORDER.length ||
    COMPOSITION_ORDER.some((entry, index) => compositionOrder[index] !== entry)
  ) {
    fail("definition.compositionOrder must declare the exact six-layer order");
  }
  const dependencies = record(source.dependencies, "definition.dependencies");
  exactKeys(
    dependencies,
    ["socketEyeSurface", "eyeApertureSeam"],
    "definition.dependencies",
  );
  const colors = record(
    source.solidColorDefaults,
    "definition.solidColorDefaults",
  );
  exactKeys(
    colors,
    ["iris", "pupil", "sclera"],
    "definition.solidColorDefaults",
  );
  const runtime = record(source.runtimeBindings, "definition.runtimeBindings");
  exactKeys(
    runtime,
    ["coordinateSpace", "left", "right", "geometryEvidence"],
    "definition.runtimeBindings",
  );
  literal(
    runtime.coordinateSpace,
    "physical-eye-sphere",
    "definition.runtimeBindings.coordinateSpace",
  );
  const evidence = record(
    runtime.geometryEvidence,
    "definition.runtimeBindings.geometryEvidence",
  );
  exactKeys(
    evidence,
    ["acceptedGlbSha256", "socketSurfaceSha256", "apertureSeamSha256"],
    "definition.runtimeBindings.geometryEvidence",
  );
  const controlValues = source.controls;
  if (!Array.isArray(controlValues) || controlValues.length !== 4) {
    fail("definition.controls must contain exactly four controls");
  }
  const controls = EYE_APPEARANCE_V5_CONTROL_IDS.map((id, index) =>
    control(controlValues[index], id, `definition.controls[${index}]`),
  ) as EyeAppearanceDefinitionV5["controls"];
  const rangeEvidence = record(
    source.rangeEvidence,
    "definition.rangeEvidence",
  );
  exactKeys(
    rangeEvidence,
    ["schemaVersion", "sha256", "canonicalSha256"],
    "definition.rangeEvidence",
  );
  const left = runtimeSide(runtime.left, "definition.runtimeBindings.left");
  const right = runtimeSide(runtime.right, "definition.runtimeBindings.right");
  if (left.physicalEyeNode === right.physicalEyeNode) {
    fail("definition runtime physical-eye nodes must be unique per side");
  }
  const leftProjectionMode = socketProjectionMode(
    left,
    "definition.runtimeBindings.left",
  );
  const rightProjectionMode = socketProjectionMode(
    right,
    "definition.runtimeBindings.right",
  );
  if (leftProjectionMode !== rightProjectionMode) {
    fail(
      "definition runtime sides must use the same socket-eye projection suite",
    );
  }
  return {
    schemaVersion: EYE_APPEARANCE_V5_SCHEMA_VERSION,
    stateSchemaVersion: EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION,
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: hash(
      source.definitionSha256,
      "definition.definitionSha256",
    ),
    dependencies: {
      socketEyeSurface: dependency(
        dependencies.socketEyeSurface,
        "socket-eye-surface/v2",
        "definition.dependencies.socketEyeSurface",
      ),
      eyeApertureSeam: dependency(
        dependencies.eyeApertureSeam,
        "eye-aperture-seam/v2",
        "definition.dependencies.eyeApertureSeam",
      ),
    },
    ownership: text(source.ownership, "definition.ownership"),
    zeroLaw: text(source.zeroLaw, "definition.zeroLaw"),
    symmetryLaw: text(source.symmetryLaw, "definition.symmetryLaw"),
    compositionOrder: [...COMPOSITION_ORDER],
    solidColorDefaults: {
      iris: rgba(colors.iris, "definition.solidColorDefaults.iris"),
      pupil: rgba(colors.pupil, "definition.solidColorDefaults.pupil"),
      sclera: rgba(colors.sclera, "definition.solidColorDefaults.sclera"),
    },
    runtimeBindings: {
      coordinateSpace: "physical-eye-sphere",
      left,
      right,
      geometryEvidence: {
        acceptedGlbSha256: hash(
          evidence.acceptedGlbSha256,
          "definition.runtimeBindings.geometryEvidence.acceptedGlbSha256",
        ),
        socketSurfaceSha256: hash(
          evidence.socketSurfaceSha256,
          "definition.runtimeBindings.geometryEvidence.socketSurfaceSha256",
        ),
        apertureSeamSha256: hash(
          evidence.apertureSeamSha256,
          "definition.runtimeBindings.geometryEvidence.apertureSeamSha256",
        ),
      },
    },
    controls,
    rangeEvidence: {
      schemaVersion: text(
        rangeEvidence.schemaVersion,
        "definition.rangeEvidence.schemaVersion",
      ),
      sha256: hash(rangeEvidence.sha256, "definition.rangeEvidence.sha256"),
      canonicalSha256: hash(
        rangeEvidence.canonicalSha256,
        "definition.rangeEvidence.canonicalSha256",
      ),
    },
  };
}

export function resolveEyeAppearanceV5SocketProjectionMode(
  definition: EyeAppearanceDefinitionV5,
): "legacy" | "corrected" | "corrected-inset" {
  const left = socketProjectionMode(
    definition.runtimeBindings.left,
    "definition.runtimeBindings.left",
  );
  const right = socketProjectionMode(
    definition.runtimeBindings.right,
    "definition.runtimeBindings.right",
  );
  if (left !== right) {
    fail(
      "definition runtime sides must use the same socket-eye projection suite",
    );
  }
  return left;
}

function controlById(
  definition: EyeAppearanceDefinitionV5,
  id: EyeAppearanceV5ControlId,
) {
  const result = definition.controls.find((entry) => entry.id === id);
  if (!result) fail(`definition is missing ${id}`);
  return result;
}

function boundedState(
  definition: EyeAppearanceDefinitionV5,
  id: EyeAppearanceV5ControlId,
  value: unknown,
  context: string,
) {
  const parsed = finite(value, context);
  const bounds = controlById(definition, id);
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    fail(`${context} must be inside [${bounds.minimum}, ${bounds.maximum}]`);
  }
  return parsed;
}

export function createDefaultEyeAppearanceStateV5(
  definition: EyeAppearanceDefinitionV5,
): EyeAppearanceStateV5 {
  return {
    schemaVersion: EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: controlById(definition, "iris_size").default,
    pupilSize: controlById(definition, "pupil_size").default,
    irisHorizontalPosition: controlById(definition, "iris_horizontal_position")
      .default,
    irisVerticalPosition: controlById(definition, "iris_vertical_position")
      .default,
  };
}

export function parseEyeAppearanceStateV5(
  definition: EyeAppearanceDefinitionV5,
  value: unknown,
): EyeAppearanceStateV5 {
  const source = record(value, "state");
  exactKeys(
    source,
    [
      "schemaVersion",
      "definitionSha256",
      "irisSize",
      "pupilSize",
      "irisHorizontalPosition",
      "irisVerticalPosition",
    ],
    "state",
  );
  literal(
    source.schemaVersion,
    EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION,
    "state.schemaVersion",
  );
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail("state.definitionSha256 does not match this package");
  }
  return {
    schemaVersion: EYE_APPEARANCE_V5_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: boundedState(
      definition,
      "iris_size",
      source.irisSize,
      "state.irisSize",
    ),
    pupilSize: boundedState(
      definition,
      "pupil_size",
      source.pupilSize,
      "state.pupilSize",
    ),
    irisHorizontalPosition: boundedState(
      definition,
      "iris_horizontal_position",
      source.irisHorizontalPosition,
      "state.irisHorizontalPosition",
    ),
    irisVerticalPosition: boundedState(
      definition,
      "iris_vertical_position",
      source.irisVerticalPosition,
      "state.irisVerticalPosition",
    ),
  };
}

export function reconcileEyeAppearanceStateV5(
  definition: EyeAppearanceDefinitionV5,
  value: unknown,
): EyeAppearanceV5Reconciliation {
  if (value == null) return { state: null, incompatible: false };
  try {
    return {
      state: parseEyeAppearanceStateV5(definition, value),
      incompatible: false,
    };
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason:
        error instanceof Error
          ? error.message
          : "Eye Appearance v5 state is incompatible with this package.",
    };
  }
}

export function resolveEyeAppearanceRuntimeControlValueV5(
  definition: EyeAppearanceDefinitionV5,
  id: EyeAppearanceV5ControlId,
  logicalValue: number,
) {
  return boundedState(definition, id, logicalValue, `${id} logical value`);
}

export function resolveEyeAppearanceStateV5(
  definition: EyeAppearanceDefinitionV5,
  value: EyeAppearanceStateV5 | null | undefined,
) {
  return value
    ? parseEyeAppearanceStateV5(definition, value)
    : createDefaultEyeAppearanceStateV5(definition);
}

export function readEyeAppearanceControlV5(
  state: EyeAppearanceStateV5,
  id: EyeAppearanceV5ControlId,
) {
  if (id === "iris_size") return state.irisSize;
  if (id === "pupil_size") return state.pupilSize;
  if (id === "iris_horizontal_position") return state.irisHorizontalPosition;
  return state.irisVerticalPosition;
}

export function updateEyeAppearanceControlV5(
  state: EyeAppearanceStateV5,
  id: EyeAppearanceV5ControlId,
  value: number,
): EyeAppearanceStateV5 {
  const next = { ...state };
  if (id === "iris_size") next.irisSize = value;
  else if (id === "pupil_size") next.pupilSize = value;
  else if (id === "iris_horizontal_position")
    next.irisHorizontalPosition = value;
  else next.irisVerticalPosition = value;
  return next;
}
