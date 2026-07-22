export const EYE_APPEARANCE_SCHEMA_VERSION = "eye-appearance/v3" as const;
export const EYE_APPEARANCE_STATE_SCHEMA_VERSION =
  "eye-appearance-state/v3" as const;

export const EYE_APPEARANCE_CONTROL_IDS = [
  "iris_size",
  "pupil_size",
  "iris_vertical_position",
] as const;

export type EyeAppearanceControlId =
  (typeof EYE_APPEARANCE_CONTROL_IDS)[number];

export type EyeAppearanceStateV3 = {
  schemaVersion: typeof EYE_APPEARANCE_STATE_SCHEMA_VERSION;
  definitionSha256: string;
  irisSize: number;
  pupilSize: number;
  irisVerticalPosition: number;
};

export type EyeAppearanceControlDefinition = {
  id: EyeAppearanceControlId;
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
  perEyeOverridesAllowed: false;
  runtimeClampingAllowed: false;
  geometrySemantics: string;
};

export type EyeAppearanceDefinitionDependency = {
  schemaVersion: "socket-eye-surface/v1" | "eye-aperture-seam/v1";
  definitionSha256: string;
};

export type EyeAppearanceRuntimeSideBinding = {
  compositeCapNode: string;
  irisNeutralRadiusMeters: number;
  pupilNeutralRadiusRatio: number;
  irisVerticalTravelMeters: number;
  edgeSoftnessMeters: number;
  artworkMappings: {
    sclera: "gaze-linked-carrier";
    iris: "radial-carrier";
    pupil: "radial-carrier";
    highlight: "iris-space";
  };
  cornea: {
    roughness: number;
    clearcoat: number;
    clearcoatRoughness: number;
  };
};

export type EyeAppearanceDefinitionV3 = {
  schemaVersion: typeof EYE_APPEARANCE_SCHEMA_VERSION;
  stateSchemaVersion: typeof EYE_APPEARANCE_STATE_SCHEMA_VERSION;
  status: "product-export-approved";
  productExportApproved: true;
  definitionSha256: string;
  dependencies: {
    socketEyeSurface: EyeAppearanceDefinitionDependency & {
      schemaVersion: "socket-eye-surface/v1";
    };
    eyeApertureSeam: EyeAppearanceDefinitionDependency & {
      schemaVersion: "eye-aperture-seam/v1";
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
    coordinateSpace: "socket-eye-surface";
    left: EyeAppearanceRuntimeSideBinding;
    right: EyeAppearanceRuntimeSideBinding;
    geometryEvidence: {
      acceptedGlbSha256: string;
      socketSurfaceSha256: string;
      apertureSeamSha256: string;
    };
  };
  controls: [
    EyeAppearanceControlDefinition,
    EyeAppearanceControlDefinition,
    EyeAppearanceControlDefinition,
  ];
  rangeEvidence: {
    schemaVersion: string;
    sha256: string;
    canonicalSha256: string;
  };
};

export type EyeAppearanceReconciliation = {
  state: EyeAppearanceStateV3 | null;
  incompatible: boolean;
  reason?: string;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_ID_SET = new Set<string>(EYE_APPEARANCE_CONTROL_IDS);
const COMPOSITION_ORDER = [
  "sclera",
  "scleraArtwork",
  "iris",
  "pupil",
  "highlight",
  "cornea",
] as const;

function fail(message: string): never {
  throw new Error(`[eye-appearance/v3] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
) {
  const accepted = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !accepted.has(key));
  if (extra.length > 0) {
    fail(`${context} contains unsupported fields: ${extra.join(", ")}`);
  }
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} must be finite`);
  }
  return value;
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context);
  if (parsed <= 0) fail(`${context} must be greater than zero`);
  return parsed;
}

function unitInterval(value: unknown, context: string): number {
  const parsed = finite(value, context);
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`);
  return parsed;
}

function hash(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`);
  return parsed;
}

function rgba(
  value: unknown,
  context: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    fail(`${context} must contain four channels`);
  }
  return value.map((channel, index) =>
    unitInterval(channel, `${context}[${index}]`),
  ) as [number, number, number, number];
}

function parseDependency<
  T extends "socket-eye-surface/v1" | "eye-aperture-seam/v1",
>(value: unknown, schemaVersion: T, context: string) {
  const source = record(value, context);
  rejectUnknownKeys(source, ["schemaVersion", "definitionSha256"], context);
  if (source.schemaVersion !== schemaVersion) {
    fail(`${context}.schemaVersion must be ${schemaVersion}`);
  }
  return {
    schemaVersion,
    definitionSha256: hash(
      source.definitionSha256,
      `${context}.definitionSha256`,
    ),
  };
}

function parseCompositionOrder(
  value: unknown,
): EyeAppearanceDefinitionV3["compositionOrder"] {
  if (!Array.isArray(value) || value.length !== COMPOSITION_ORDER.length) {
    fail("definition.compositionOrder must declare all six material layers");
  }
  for (const [index, expected] of COMPOSITION_ORDER.entries()) {
    if (value[index] !== expected) {
      fail(`definition.compositionOrder[${index}] must be ${expected}`);
    }
  }
  return [...COMPOSITION_ORDER];
}

function parseRuntimeSide(
  value: unknown,
  context: string,
): EyeAppearanceRuntimeSideBinding {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    [
      "compositeCapNode",
      "irisNeutralRadiusMeters",
      "pupilNeutralRadiusRatio",
      "irisVerticalTravelMeters",
      "edgeSoftnessMeters",
      "artworkMappings",
      "cornea",
    ],
    context,
  );
  const artworkMappings = record(
    source.artworkMappings,
    `${context}.artworkMappings`,
  );
  rejectUnknownKeys(
    artworkMappings,
    ["sclera", "iris", "pupil", "highlight"],
    `${context}.artworkMappings`,
  );
  const expectedMappings = {
    sclera: "gaze-linked-carrier",
    iris: "radial-carrier",
    pupil: "radial-carrier",
    highlight: "iris-space",
  } as const;
  for (const [key, expected] of Object.entries(expectedMappings)) {
    if (artworkMappings[key] !== expected) {
      fail(`${context}.artworkMappings.${key} must be ${expected}`);
    }
  }
  const cornea = record(source.cornea, `${context}.cornea`);
  rejectUnknownKeys(
    cornea,
    ["roughness", "clearcoat", "clearcoatRoughness"],
    `${context}.cornea`,
  );
  const pupilNeutralRadiusRatio = positive(
    source.pupilNeutralRadiusRatio,
    `${context}.pupilNeutralRadiusRatio`,
  );
  if (pupilNeutralRadiusRatio >= 1) {
    fail(`${context}.pupilNeutralRadiusRatio must stay below one`);
  }
  const irisNeutralRadiusMeters = positive(
    source.irisNeutralRadiusMeters,
    `${context}.irisNeutralRadiusMeters`,
  );
  const irisVerticalTravelMeters = positive(
    source.irisVerticalTravelMeters,
    `${context}.irisVerticalTravelMeters`,
  );
  const edgeSoftnessMeters = positive(
    source.edgeSoftnessMeters,
    `${context}.edgeSoftnessMeters`,
  );
  if (edgeSoftnessMeters >= irisNeutralRadiusMeters * pupilNeutralRadiusRatio) {
    fail(`${context}.edgeSoftnessMeters must stay below the neutral pupil radius`);
  }
  return {
    compositeCapNode: stringValue(
      source.compositeCapNode,
      `${context}.compositeCapNode`,
    ),
    irisNeutralRadiusMeters,
    pupilNeutralRadiusRatio,
    irisVerticalTravelMeters,
    edgeSoftnessMeters,
    artworkMappings: expectedMappings,
    cornea: {
      roughness: unitInterval(cornea.roughness, `${context}.cornea.roughness`),
      clearcoat: unitInterval(cornea.clearcoat, `${context}.cornea.clearcoat`),
      clearcoatRoughness: unitInterval(
        cornea.clearcoatRoughness,
        `${context}.cornea.clearcoatRoughness`,
      ),
    },
  };
}

function isOnStepLattice(
  value: number,
  minimum: number,
  step: number,
): boolean {
  const stepCount = (value - minimum) / step;
  const tolerance = Math.max(1, Math.abs(stepCount)) * Number.EPSILON * 64;
  return Math.abs(stepCount - Math.round(stepCount)) <= tolerance;
}

function parseControl(
  value: unknown,
  expectedId: EyeAppearanceControlId,
  context: string,
): EyeAppearanceControlDefinition {
  const source = record(value, context);
  rejectUnknownKeys(
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
      "perEyeOverridesAllowed",
      "runtimeClampingAllowed",
      "geometrySemantics",
    ],
    context,
  );
  const id = stringValue(source.id, `${context}.id`);
  if (id !== expectedId || !CONTROL_ID_SET.has(id)) {
    fail(`${context}.id must be ${expectedId}`);
  }
  const minimum = finite(source.minimum, `${context}.minimum`);
  const maximum = finite(source.maximum, `${context}.maximum`);
  const step = finite(source.step, `${context}.step`);
  const defaultValue = finite(source.default, `${context}.default`);
  if (minimum >= maximum) fail(`${context} minimum must be less than maximum`);
  if (step <= 0) fail(`${context}.step must be positive`);
  if (defaultValue < minimum || defaultValue > maximum) {
    fail(`${context}.default must be inside its bounds`);
  }
  if (!isOnStepLattice(maximum, minimum, step)) {
    fail(`${context}.maximum must be reachable from minimum by whole steps`);
  }
  if (!isOnStepLattice(defaultValue, minimum, step)) {
    fail(`${context}.default must be reachable from minimum by whole steps`);
  }
  if (source.linkedBilateral !== true) {
    fail(`${context}.linkedBilateral must be true`);
  }
  if (source.perEyeOverridesAllowed !== false) {
    fail(`${context}.perEyeOverridesAllowed must be false`);
  }
  if (source.runtimeClampingAllowed !== false) {
    fail(`${context}.runtimeClampingAllowed must be false`);
  }
  const expectedUnit =
    expectedId === "iris_size"
      ? "neutral-multiplier"
      : expectedId === "pupil_size"
        ? "iris-relative-multiplier"
        : "neutral-travel-fraction";
  if (source.unit !== expectedUnit) {
    fail(`${context}.unit must be ${expectedUnit}`);
  }
  return {
    id: expectedId,
    label: stringValue(source.label, `${context}.label`),
    description: stringValue(source.description, `${context}.description`),
    minimum,
    maximum,
    step,
    default: defaultValue,
    unit: expectedUnit,
    linkedBilateral: true,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: stringValue(
      source.geometrySemantics,
      `${context}.geometrySemantics`,
    ),
  };
}

export function parseEyeAppearanceDefinition(
  value: unknown,
): EyeAppearanceDefinitionV3 {
  const source = record(value, "definition");
  rejectUnknownKeys(
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
  if (source.schemaVersion !== EYE_APPEARANCE_SCHEMA_VERSION) {
    fail(`definition.schemaVersion must be ${EYE_APPEARANCE_SCHEMA_VERSION}`);
  }
  if (source.stateSchemaVersion !== EYE_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail(
      `definition.stateSchemaVersion must be ${EYE_APPEARANCE_STATE_SCHEMA_VERSION}`,
    );
  }
  if (source.status !== "product-export-approved") {
    fail("definition.status must be product-export-approved");
  }
  if (source.productExportApproved !== true) {
    fail("definition.productExportApproved must be true");
  }

  const dependencies = record(source.dependencies, "definition.dependencies");
  rejectUnknownKeys(
    dependencies,
    ["socketEyeSurface", "eyeApertureSeam"],
    "definition.dependencies",
  );
  const colors = record(
    source.solidColorDefaults,
    "definition.solidColorDefaults",
  );
  rejectUnknownKeys(
    colors,
    ["iris", "pupil", "sclera"],
    "definition.solidColorDefaults",
  );
  const runtimeBindings = record(
    source.runtimeBindings,
    "definition.runtimeBindings",
  );
  rejectUnknownKeys(
    runtimeBindings,
    ["coordinateSpace", "left", "right", "geometryEvidence"],
    "definition.runtimeBindings",
  );
  if (runtimeBindings.coordinateSpace !== "socket-eye-surface") {
    fail("definition.runtimeBindings.coordinateSpace must be socket-eye-surface");
  }
  const geometryEvidence = record(
    runtimeBindings.geometryEvidence,
    "definition.runtimeBindings.geometryEvidence",
  );
  rejectUnknownKeys(
    geometryEvidence,
    ["acceptedGlbSha256", "socketSurfaceSha256", "apertureSeamSha256"],
    "definition.runtimeBindings.geometryEvidence",
  );
  if (!Array.isArray(source.controls) || source.controls.length !== 3) {
    fail(
      "definition.controls must contain exactly Iris Size, Pupil Size, and Iris Vertical Position",
    );
  }
  const controlSources = source.controls;
  const controls = EYE_APPEARANCE_CONTROL_IDS.map((id, index) =>
    parseControl(controlSources[index], id, `definition.controls[${index}]`),
  ) as [
    EyeAppearanceControlDefinition,
    EyeAppearanceControlDefinition,
    EyeAppearanceControlDefinition,
  ];
  const rangeEvidence = record(
    source.rangeEvidence,
    "definition.rangeEvidence",
  );
  rejectUnknownKeys(
    rangeEvidence,
    ["schemaVersion", "sha256", "canonicalSha256"],
    "definition.rangeEvidence",
  );
  const left = parseRuntimeSide(
    runtimeBindings.left,
    "definition.runtimeBindings.left",
  );
  const right = parseRuntimeSide(
    runtimeBindings.right,
    "definition.runtimeBindings.right",
  );
  if (left.compositeCapNode === right.compositeCapNode) {
    fail("definition runtime composite-cap nodes must be unique per side");
  }
  return {
    schemaVersion: EYE_APPEARANCE_SCHEMA_VERSION,
    stateSchemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: hash(
      source.definitionSha256,
      "definition.definitionSha256",
    ),
    dependencies: {
      socketEyeSurface: parseDependency(
        dependencies.socketEyeSurface,
        "socket-eye-surface/v1",
        "definition.dependencies.socketEyeSurface",
      ),
      eyeApertureSeam: parseDependency(
        dependencies.eyeApertureSeam,
        "eye-aperture-seam/v1",
        "definition.dependencies.eyeApertureSeam",
      ),
    },
    ownership: stringValue(source.ownership, "definition.ownership"),
    zeroLaw: stringValue(source.zeroLaw, "definition.zeroLaw"),
    symmetryLaw: stringValue(source.symmetryLaw, "definition.symmetryLaw"),
    compositionOrder: parseCompositionOrder(source.compositionOrder),
    solidColorDefaults: {
      iris: rgba(colors.iris, "definition.solidColorDefaults.iris"),
      pupil: rgba(colors.pupil, "definition.solidColorDefaults.pupil"),
      sclera: rgba(colors.sclera, "definition.solidColorDefaults.sclera"),
    },
    runtimeBindings: {
      coordinateSpace: "socket-eye-surface",
      left,
      right,
      geometryEvidence: {
        acceptedGlbSha256: hash(
          geometryEvidence.acceptedGlbSha256,
          "definition.runtimeBindings.geometryEvidence.acceptedGlbSha256",
        ),
        socketSurfaceSha256: hash(
          geometryEvidence.socketSurfaceSha256,
          "definition.runtimeBindings.geometryEvidence.socketSurfaceSha256",
        ),
        apertureSeamSha256: hash(
          geometryEvidence.apertureSeamSha256,
          "definition.runtimeBindings.geometryEvidence.apertureSeamSha256",
        ),
      },
    },
    controls,
    rangeEvidence: {
      schemaVersion: stringValue(
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

function control(
  definition: EyeAppearanceDefinitionV3,
  id: EyeAppearanceControlId,
) {
  const found = definition.controls.find((entry) => entry.id === id);
  if (!found) fail(`definition is missing ${id}`);
  return found;
}

export function resolveEyeAppearanceRuntimeControlValue(
  definition: EyeAppearanceDefinitionV3,
  id: EyeAppearanceControlId,
  logicalValue: number,
) {
  const parsed = finite(logicalValue, `${id} logical value`);
  const bounds = control(definition, id);
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    fail(`${id} logical value must be inside [${bounds.minimum}, ${bounds.maximum}]`);
  }
  return parsed;
}

function bounded(
  definition: EyeAppearanceDefinitionV3,
  id: EyeAppearanceControlId,
  value: unknown,
  context: string,
) {
  const parsed = finite(value, context);
  const bounds = control(definition, id);
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    fail(`${context} must be inside [${bounds.minimum}, ${bounds.maximum}]`);
  }
  return parsed;
}

export function createDefaultEyeAppearanceState(
  definition: EyeAppearanceDefinitionV3,
): EyeAppearanceStateV3 {
  return {
    schemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: control(definition, "iris_size").default,
    pupilSize: control(definition, "pupil_size").default,
    irisVerticalPosition: control(
      definition,
      "iris_vertical_position",
    ).default,
  };
}

export function parseEyeAppearanceState(
  definition: EyeAppearanceDefinitionV3,
  value: unknown,
): EyeAppearanceStateV3 {
  const source = record(value, "state");
  rejectUnknownKeys(
    source,
    [
      "schemaVersion",
      "definitionSha256",
      "irisSize",
      "pupilSize",
      "irisVerticalPosition",
    ],
    "state",
  );
  if (source.schemaVersion !== EYE_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail(`state.schemaVersion must be ${EYE_APPEARANCE_STATE_SCHEMA_VERSION}`);
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail("state.definitionSha256 does not match this package");
  }
  return {
    schemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: bounded(
      definition,
      "iris_size",
      source.irisSize,
      "state.irisSize",
    ),
    pupilSize: bounded(
      definition,
      "pupil_size",
      source.pupilSize,
      "state.pupilSize",
    ),
    irisVerticalPosition: bounded(
      definition,
      "iris_vertical_position",
      source.irisVerticalPosition,
      "state.irisVerticalPosition",
    ),
  };
}

export function resolveEyeAppearanceState(
  definition: EyeAppearanceDefinitionV3,
  value: EyeAppearanceStateV3 | null | undefined,
) {
  return value
    ? parseEyeAppearanceState(definition, value)
    : createDefaultEyeAppearanceState(definition);
}

export function reconcileEyeAppearanceState(
  definition: EyeAppearanceDefinitionV3,
  value: unknown,
): EyeAppearanceReconciliation {
  if (value == null) return { state: null, incompatible: false };
  try {
    return {
      state: parseEyeAppearanceState(definition, value),
      incompatible: false,
    };
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason:
        error instanceof Error
          ? error.message
          : "Eye Appearance state is incompatible with this package.",
    };
  }
}

export function readEyeAppearanceControl(
  state: EyeAppearanceStateV3,
  id: EyeAppearanceControlId,
) {
  if (id === "iris_size") return state.irisSize;
  if (id === "pupil_size") return state.pupilSize;
  return state.irisVerticalPosition;
}

export function updateEyeAppearanceControl(
  state: EyeAppearanceStateV3,
  id: EyeAppearanceControlId,
  value: number,
): EyeAppearanceStateV3 {
  const next: EyeAppearanceStateV3 = { ...state };
  if (id === "iris_size") next.irisSize = value;
  else if (id === "pupil_size") next.pupilSize = value;
  else next.irisVerticalPosition = value;
  return next;
}
