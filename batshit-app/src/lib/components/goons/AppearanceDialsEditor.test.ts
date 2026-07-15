import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AppearanceDialsEditor from "./AppearanceDialsEditor.svelte";
import {
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
} from "$lib/goons/appearanceDials";
import {
  EYE_APPEARANCE_CONTROL_IDS,
  createDefaultEyeAppearanceState,
  readEyeAppearanceControl,
  updateEyeAppearanceControl,
  type EyeAppearanceControlDefinition,
  type EyeAppearanceDefinitionV1,
} from "$lib/goons/eyeAppearance";

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      onfinish: null,
    }),
  });
}

const HASH = "a".repeat(64);

function buildManifest(): AppearanceDialsManifest {
  return {
    contract: APPEARANCE_DIALS_CONTRACT,
    definitionSha256: HASH,
    neutral: { id: "neutral", recipeSha256: HASH },
    productResolution: {
      contract: "batshit-product-resolution/v1",
      catalogSha256: HASH,
      policySha256: HASH,
      resolutionSha256: HASH,
    },
    fitEvidence: {
      contract: "appearance-fit-evidence/v1",
      definitionSha256: HASH,
      modelSha256: HASH,
      scenarioSetSha256: HASH,
      eyeReportSha256: HASH,
      oralReportSha256: HASH,
      facialArtworkDefinitionSha256: HASH,
      facialArtworkContractFileSha256: HASH,
      facialArtworkProofSha256: HASH,
    },
    mappedFaceMorphNames: [],
    nodes: {},
    regions: [
      { id: "body.head", label: "Head", surface: "body", order: 0 },
      { id: "body.neck", label: "Neck", surface: "body", order: 1 },
      { id: "face.brows", label: "Brows", surface: "head-face", order: 0 },
      { id: "face.eyes", label: "Eyes", surface: "head-face", order: 1 },
      { id: "face.cheeks", label: "Cheeks", surface: "head-face", order: 2 },
    ],
    dials: [
      {
        id: "head_size",
        label: "Head Size",
        region: "body.head",
        tier: "core",
        order: 0,
        description: "",
        keywords: [],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
      {
        id: "neck_width",
        label: "Neck Width",
        region: "body.neck",
        tier: "core",
        order: 0,
        description: "",
        keywords: [],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
      {
        id: "brow_height",
        label: "Forehead Tighten",
        region: "face.brows",
        tier: "core",
        order: 0,
        description: "",
        keywords: [],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
      {
        id: "face_fullness",
        label: "Face Fullness",
        region: "face.cheeks",
        tier: "core",
        order: 0,
        description: "",
        keywords: [],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
    ],
    targets: {},
    followers: {},
  };
}

function buildValueState(): AppearanceDialValueState {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: HASH,
    neutralId: "neutral",
    neutralRecipeSha256: HASH,
    values: {},
    unlockedDialIds: [],
  };
}

function buildEyeAppearanceDefinition(): EyeAppearanceDefinitionV1 {
  const controlsById: Record<
    (typeof EYE_APPEARANCE_CONTROL_IDS)[number],
    Omit<EyeAppearanceControlDefinition, "id">
  > = {
    iris_size: {
      label: "Iris Size",
      description: "Scale the fitted iris.",
      minimum: 0.72,
      maximum: 1.28,
      step: 0.01,
      default: 1,
      runtimeNeutralOffset: 0,
      unit: "neutral-multiplier",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Scale the fitted iris.",
    },
    pupil_size: {
      label: "Pupil Size",
      description: "Scale the fitted pupil.",
      minimum: 0.55,
      maximum: 1.45,
      step: 0.01,
      default: 1,
      runtimeNeutralOffset: 0,
      unit: "neutral-multiplier",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Scale the fitted pupil.",
    },
    eye_convergence: {
      label: "Eye Convergence (Gaze)",
      description: "Adjust gaze distance toward a nearer or farther focus.",
      minimum: -10,
      maximum: 8,
      step: 0.1,
      default: 0,
      runtimeNeutralOffset: 4,
      unit: "degrees",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Rotate both fitted eyes around their pivots.",
    },
    sclera_scale: {
      label: "Sclera Scale",
      description: "Scale the complete fitted eye assembly.",
      minimum: -0.2,
      maximum: 0.2,
      step: 0.005,
      default: 0,
      runtimeNeutralOffset: 0,
      unit: "post-fit-multiplier-offset",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Scale the complete fitted eye assembly.",
    },
    sclera_tilt: {
      label: "Sclera Tilt",
      description: "Tilt the complete fitted eye assembly.",
      minimum: -7,
      maximum: 7,
      step: 0.1,
      default: 0,
      runtimeNeutralOffset: 0,
      unit: "degrees",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Tilt the complete fitted eye assembly.",
    },
    sclera_horizontal_position: {
      label: "Sclera Horizontal Position",
      description: "Move both eyes horizontally.",
      minimum: -0.0028,
      maximum: 0.0028,
      step: 0.00005,
      default: 0,
      runtimeNeutralOffset: 0,
      unit: "meters",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Move both eyes horizontally.",
    },
    sclera_vertical_position: {
      label: "Sclera Vertical Position",
      description: "Move both eyes vertically.",
      minimum: -0.0027,
      maximum: 0.0027,
      step: 0.00005,
      default: 0,
      runtimeNeutralOffset: 0,
      unit: "meters",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Move both eyes vertically.",
    },
    sclera_depth: {
      label: "Sclera Depth",
      description: "Move both eyes forward or backward.",
      minimum: -0.00145,
      maximum: 0.00145,
      step: 0.000025,
      default: 0,
      runtimeNeutralOffset: 0,
      unit: "meters",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: "Move both eyes forward or backward.",
    },
  };

  return {
    schemaVersion: "eye-appearance/v1",
    stateSchemaVersion: "eye-appearance-state/v1",
    status: "test",
    productExportApproved: false,
    definitionSha256: HASH,
    facialArtworkDependency: {
      schemaVersion: "facial-artwork/v3",
      definitionSha256: HASH,
    },
    ownership: "test",
    zeroLaw: "Zero keeps the fitted result.",
    symmetryLaw: "All physical controls are linked.",
    compositionOrder: ["automatic-fit", "user-offset"],
    completeEyeAssemblyNodes: ["EyeAssembly_L", "EyeAssembly_R"],
    solidColorDefaults: {
      iris: [0.1, 0.5, 0.6, 1],
      pupil: [0.02, 0.02, 0.02, 1],
      sclera: [0.92, 0.9, 0.86, 1],
    },
    controls: EYE_APPEARANCE_CONTROL_IDS.map((id) => ({
      id,
      ...controlsById[id],
    })),
    rangeEvidence: {
      schemaVersion: "test",
      sha256: HASH,
      canonicalSha256: HASH,
    },
  } as EyeAppearanceDefinitionV1;
}

describe("AppearanceDialsEditor", () => {
  it("starts every face region closed and keeps only one level-two region open", async () => {
    const eyeAppearanceDefinition = buildEyeAppearanceDefinition();
    const onEyeAppearanceChange = vi.fn();

    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "head-face",
      onChange: vi.fn(),
      eyeAppearanceDefinition,
      eyeAppearanceState: createDefaultEyeAppearanceState(
        eyeAppearanceDefinition,
      ),
      onEyeAppearanceChange,
    });

    expect(onEyeAppearanceChange).not.toHaveBeenCalled();
    const brows = screen.getByRole("button", { name: /Brows/ });
    const eyes = screen.getByRole("button", { name: /Eyes/ });
    const cheeks = screen.getByRole("button", { name: /Cheeks/ });

    expect(brows).toHaveAttribute("aria-expanded", "false");
    expect(eyes).toHaveAttribute("aria-expanded", "false");
    expect(cheeks).toHaveAttribute("aria-expanded", "false");
    for (const trigger of [brows, eyes, cheeks]) {
      expect(trigger).toHaveClass(
        "flex",
        "w-full",
        "items-center",
        "justify-between",
        "text-left",
      );
    }
    expect(screen.queryByRole("slider", { name: "Sclera Scale" })).not.toBeInTheDocument();

    await fireEvent.click(eyes);

    expect(screen.getByText("Sclera Fit")).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Eye Convergence (Gaze)" })).not.toBeInTheDocument();
    const expectedRanges: Record<string, [string, string]> = {
      "Sclera Scale": ["-0.2", "0.2"],
      "Sclera Tilt": ["-7", "7"],
      "Sclera Horizontal Position": ["-0.0028", "0.0028"],
      "Sclera Vertical Position": ["-0.0027", "0.0027"],
      "Sclera Depth": ["-0.00145", "0.00145"],
    };
    for (const label of [
      "Sclera Scale",
      "Sclera Tilt",
      "Sclera Horizontal Position",
      "Sclera Vertical Position",
      "Sclera Depth",
    ]) {
      const slider = screen.getByRole("slider", { name: label });
      expect(slider).toHaveAttribute("aria-valuemin", expectedRanges[label][0]);
      expect(slider).toHaveAttribute("aria-valuemax", expectedRanges[label][1]);
    }
    expect(onEyeAppearanceChange).not.toHaveBeenCalled();

    await fireEvent.click(brows);
    expect(brows).toHaveAttribute("aria-expanded", "true");
    expect(eyes).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the reorganized Head controls only on Body Appearance", async () => {
    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "body",
      onChange: vi.fn(),
    });

    expect(screen.getByRole("button", { name: /Head/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Neck/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Brows/ })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Head/ }));
    expect(screen.getByRole("slider", { name: "Head Size" })).toBeInTheDocument();
  });

  it("resets only the Sclera Fit controls and preserves Eye Contact convergence", async () => {
    const eyeAppearanceDefinition = buildEyeAppearanceDefinition();
    let eyeAppearanceState = createDefaultEyeAppearanceState(eyeAppearanceDefinition);
    eyeAppearanceState = updateEyeAppearanceControl(
      eyeAppearanceState,
      "eye_convergence",
      2,
    );
    eyeAppearanceState = updateEyeAppearanceControl(
      eyeAppearanceState,
      "sclera_scale",
      0.1,
    );
    const onEyeAppearanceChange = vi.fn();

    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "head-face",
      onChange: vi.fn(),
      eyeAppearanceDefinition,
      eyeAppearanceState,
      onEyeAppearanceChange,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Reset Eyes" }));

    expect(onEyeAppearanceChange).toHaveBeenCalledTimes(1);
    const nextState = onEyeAppearanceChange.mock.calls[0][0];
    expect(readEyeAppearanceControl(nextState, "sclera_scale")).toBe(0);
    expect(readEyeAppearanceControl(nextState, "eye_convergence")).toBe(2);
  });
});
