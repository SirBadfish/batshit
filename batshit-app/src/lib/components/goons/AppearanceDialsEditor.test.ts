import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AppearanceDialsEditor from "./AppearanceDialsEditor.svelte";
import {
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
} from "$lib/goons/appearanceDials";

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
      { id: "face.mouth-lips", label: "Mouth & Lips", surface: "head-face", order: 3 },
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
      {
        id: "eye_corner_smoothing",
        label: "Eye Corner Smoothing",
        region: "face.eyes",
        tier: "advanced",
        order: 1,
        description: "",
        keywords: [],
        kind: "root-scale",
        range: [-2.5, 0.5],
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

describe("AppearanceDialsEditor", () => {
  it("shows the complete dial catalog without a tier filter and keeps only one face region open", async () => {
    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "head-face",
      onChange: vi.fn(),
    });

    expect(screen.queryByRole("group", { name: "Dial detail level" })).not.toBeInTheDocument();
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
    await fireEvent.click(eyes);

    expect(screen.getByRole("slider", { name: "Eye Corner Smoothing" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Eye Convergence (Gaze)" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sclera Fit")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Sclera Scale" })).not.toBeInTheDocument();

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

  it("searches ordinary dials and embedded regional controls as one complete catalog", async () => {
    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "head-face",
      onChange: vi.fn(),
      regionContentIds: ["face.mouth-lips"],
      regionContentControlCounts: { "face.mouth-lips": 5 },
      regionContentSearchText: {
        "face.mouth-lips": "Teeth Color Teeth Brightness Teeth Shine Gum Color Tongue Color",
      },
    });

    const search = screen.getByRole("searchbox", { name: "Search Face Appearance" });
    await fireEvent.input(search, { target: { value: "forehead tighten" } });
    expect(screen.getByRole("button", { name: /Brows/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mouth & Lips/ })).not.toBeInTheDocument();

    await fireEvent.input(search, { target: { value: "teeth brightness" } });
    expect(screen.getByRole("button", { name: /^Mouth & Lips/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Brows/ })).not.toBeInTheDocument();

    await fireEvent.input(search, { target: { value: "not a real face control" } });
    expect(screen.getByText("No face dials match this filter.")).toBeInTheDocument();
  });

  it("reports and resets every changed embedded control in a region", async () => {
    const onChange = vi.fn();
    const onResetRegionContent = vi.fn();

    render(AppearanceDialsEditor, {
      manifest: buildManifest(),
      valueState: buildValueState(),
      surface: "head-face",
      onChange,
      regionContentIds: ["face.mouth-lips"],
      regionContentControlCounts: { "face.mouth-lips": 5 },
      regionContentChangedCounts: { "face.mouth-lips": 5 },
      onResetRegionContent,
    });

    const mouth = screen.getByRole("button", { name: /^Mouth & Lips/ });
    expect(mouth).toHaveAttribute("type", "button");
    expect(mouth).toHaveAttribute("aria-expanded", "false");
    expect(mouth).toHaveTextContent("5 changed");
    expect(screen.getByRole("button", { name: /Reset Dials/ })).toHaveTextContent("(5)");

    await fireEvent.click(screen.getByRole("button", { name: "Reset Mouth & Lips" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onResetRegionContent).toHaveBeenCalledWith("face.mouth-lips");
  });

  it("keeps feminine and masculine style descriptors visible in the same catalog", async () => {
    const manifest = buildManifest();
    manifest.dials.push(
      {
        id: "feminine_brow_shape",
        label: "Feminine Brow Shape",
        region: "face.brows",
        tier: "detail",
        order: 1,
        description: "A style description, never an access restriction.",
        keywords: ["feminine", "brow"],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
      {
        id: "masculine_brow_shape",
        label: "Masculine Brow Shape",
        region: "face.brows",
        tier: "detail",
        order: 2,
        description: "A style description, never an access restriction.",
        keywords: ["masculine", "brow"],
        kind: "root-scale",
        range: [-1, 1],
        default: 0,
        step: 0.01,
        scalePerUnit: 0.1,
      },
    );

    render(AppearanceDialsEditor, {
      manifest,
      valueState: buildValueState(),
      surface: "head-face",
      onChange: vi.fn(),
    });

    await fireEvent.click(screen.getByRole("button", { name: /Brows/ }));
    expect(screen.getByRole("slider", { name: "Feminine Brow Shape" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Masculine Brow Shape" })).toBeInTheDocument();
  });
});
