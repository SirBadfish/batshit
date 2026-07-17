import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FacialArtworkEditor from "./FacialArtworkEditor.svelte";
import { downloadBlob } from "$lib/utils/download";
import {
  FACIAL_ARTWORK_ROLE_IDS,
  createDefaultFacialArtworkState,
  type FacialArtworkDefinitionV3,
  type FacialArtworkRoleDefinition,
} from "$lib/goons/facialArtwork";
import { setFacialArtworkRoleMode } from "$lib/goons/facialArtwork.editor";
import {
  createDefaultFacialArtworkUploadCreditDraft,
  type FacialArtworkUploadCreditDraft,
} from "$lib/goons/facialArtwork.provenance";
import {
  EYE_APPEARANCE_CONTROL_IDS,
  createDefaultEyeAppearanceState,
  type EyeAppearanceControlDefinition,
  type EyeAppearanceDefinitionV1,
} from "$lib/goons/eyeAppearance";

vi.mock("$lib/utils/download", () => ({
  downloadBlob: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

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

function buildFacialArtworkDefinition(): FacialArtworkDefinitionV3 {
  const roleDefinitions = FACIAL_ARTWORK_ROLE_IDS.map((id) => {
    const mapping =
      id === "sclera"
        ? "longitude"
        : id === "iris" || id === "pupil" || id === "eye_highlight"
          ? "radial"
          : "planar";
    const baseColor =
      id === "iris"
        ? [0.1, 0.5, 0.6]
        : id === "pupil"
          ? [0.02, 0.02, 0.02]
          : id === "sclera"
            ? [0.92, 0.9, 0.86]
            : null;
    return {
      id,
      template: `${id}_template`,
      ownership:
        id === "eye_highlight"
          ? "lit-overlay"
          : id === "brows" || id === "lashes_eye_outline"
            ? "canvas"
            : "lit-surface",
      mapping,
      target: {
        left: { runtimeNodes: [`${id}_left`], mirrorU: false, mirrorV: false },
        right: {
          runtimeNodes: [`${id}_right`],
          mirrorU: id === "lashes_eye_outline",
          mirrorV: false,
        },
      },
      defaultEyeState: {
        visible: baseColor !== null,
        baseColor,
        artwork: null,
      },
      defaultMode: "shared",
      bounds:
        mapping === "longitude"
          ? { longitudeDegrees: [-180, 180] }
          : {
              translateU: [-1, 1],
              translateV: [-1, 1],
              scale: [0.25, 4],
              rotationDegrees: [-180, 180],
            },
    } as FacialArtworkRoleDefinition;
  });

  return {
    schemaVersion: "facial-artwork/v3",
    stateSchemaVersion: "facial-artwork-state/v3",
    productExportApproved: false,
    definitionSha256: HASH,
    templateSet: { id: "test", version: "2.0.0" },
    templates: FACIAL_ARTWORK_ROLE_IDS.map((id) => ({
      id: `${id}_template`,
      version: "2.0.0",
      dimensions: [1024, 1024],
      guide: {
        path: `goons/facial-artwork/v3/${id}/guide-left.png`,
        sha256: HASH,
      },
      safePaintMask: {
        path: `goons/facial-artwork/v3/${id}/mask-left.png`,
        sha256: HASH,
      },
      transparentBlank: {
        path: `goons/facial-artwork/v3/${id}/blank.png`,
        sha256: HASH,
      },
      canonicalOrientation:
        id === "brows" || id === "lashes_eye_outline"
          ? ("anatomical-left" as const)
          : ("orientation-neutral" as const),
      transformOriginUv: [0.39, 0.5] as [number, number],
      ...(id === "brows" || id === "lashes_eye_outline"
        ? {
            mirroredHorizontalVariant: {
              orientation: "anatomical-right" as const,
              label: "Goon's Right Eye (viewer's left)",
              guide: {
                path: `goons/facial-artwork/v3/${id}/guide-right.png`,
                sha256: HASH,
              },
              safePaintMask: {
                path: `goons/facial-artwork/v3/${id}/mask-right.png`,
                sha256: HASH,
              },
            },
          }
        : {}),
      ...(id === "lashes_eye_outline"
        ? {
            orientationReference: {
              path: "goons/facial-artwork/v3/lashes_eye_outline/open-eye-reference.png",
              sha256: HASH,
            },
          }
        : {}),
    })),
    roles: roleDefinitions,
  };
}

function buildEyeAppearanceDefinition(): EyeAppearanceDefinitionV1 {
  const labels: Record<(typeof EYE_APPEARANCE_CONTROL_IDS)[number], string> = {
    iris_size: "Iris Size",
    pupil_size: "Pupil Size",
    eye_convergence: "Eye Convergence (Gaze)",
    sclera_scale: "Sclera Scale",
    sclera_tilt: "Sclera Tilt",
    sclera_horizontal_position: "Sclera Horizontal Position",
    sclera_vertical_position: "Sclera Vertical Position",
    sclera_depth: "Sclera Depth",
  };
  const controls = EYE_APPEARANCE_CONTROL_IDS.map((id) => {
    const sizeRange =
      id === "iris_size"
        ? { minimum: 0.65, maximum: 1.35, default: 1 }
        : id === "pupil_size"
          ? { minimum: 0, maximum: 2, default: 1 }
          : { minimum: -1, maximum: 1, default: 0 };
    return {
      id,
      label: labels[id],
      description: `${labels[id]} test description`,
      ...sizeRange,
      step: 0.01,
      runtimeNeutralOffset: id === "eye_convergence" ? 4 : 0,
      unit: id === "pupil_size" ? "iris-relative-multiplier" : "post-fit-multiplier-offset",
      linkedBilateral: true,
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: `${labels[id]} test control`,
    };
  }) as EyeAppearanceControlDefinition[];

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
    controls,
    rangeEvidence: {
      schemaVersion: "test",
      sha256: HASH,
      canonicalSha256: HASH,
    },
  } as EyeAppearanceDefinitionV1;
}

function renderEditor(
  options: {
    scope?: "brows" | "eyes";
    lashesPerEye?: boolean;
    creditDraft?: FacialArtworkUploadCreditDraft;
  } = {},
) {
  const definition = buildFacialArtworkDefinition();
  const eyeAppearanceDefinition = buildEyeAppearanceDefinition();
  let valueState = createDefaultFacialArtworkState(definition);
  if (options.lashesPerEye) {
    valueState = setFacialArtworkRoleMode(
      valueState,
      "lashes_eye_outline",
      "per-eye",
    );
  }
  const onCreditDraftChange = vi.fn();
  const props = {
    scope: options.scope ?? ("eyes" as const),
    definition,
    eyeAppearanceDefinition,
    valueState,
    eyeAppearanceState: createDefaultEyeAppearanceState(
      eyeAppearanceDefinition,
    ),
    ownerDisplayName: "Josh",
    creditDraft: options.creditDraft ?? createDefaultFacialArtworkUploadCreditDraft(),
    onCreditDraftChange,
    onChange: vi.fn(),
    onEyeAppearanceChange: vi.fn(),
    onUpload: vi.fn(),
  };
  const view = render(FacialArtworkEditor, props);
  return { ...view, props, onCreditDraftChange };
}

describe("FacialArtworkEditor", () => {
  it("uses the shared Select for upload credit and keeps brow artwork closed initially", async () => {
    renderEditor({ scope: "brows" });

    expect(screen.getByRole("button", { name: "Source" })).toHaveTextContent("My artwork");
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute(
      "data-slot",
      "select-trigger",
    );
    expect(screen.getByText("Credited to")).toBeInTheDocument();
    expect(screen.getByText("Josh")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "About Artwork Credit Confirmation" }),
    ).toBeInTheDocument();
    const browArtwork = screen.getByRole("button", { name: "Brow Artwork" });
    expect(browArtwork).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Upload PNG" })).not.toBeInTheDocument();

    await fireEvent.click(browArtwork);
    expect(screen.getByRole("button", { name: "Upload PNG" })).toBeEnabled();
    expect(screen.queryByLabelText("Artist or source")).not.toBeInTheDocument();
  });

  it("requires explicit attribution and permission only for external artwork", async () => {
    let creditDraft: FacialArtworkUploadCreditDraft = {
      sourceKind: "approved-external",
      externalAuthor: "",
      externalLicense: "",
      externalRightsConfirmed: false,
    };
    const editor = renderEditor({ scope: "brows", creditDraft });

    await fireEvent.click(screen.getByRole("button", { name: "Brow Artwork" }));

    expect(screen.getByRole("button", { name: "Upload PNG" })).toBeDisabled();
    await fireEvent.input(screen.getByLabelText("Artist or source"), {
      target: { value: "Example Artist" },
    });
    creditDraft = editor.onCreditDraftChange.mock.calls.at(-1)?.[0] as FacialArtworkUploadCreditDraft;
    await editor.rerender({ ...editor.props, creditDraft });
    await fireEvent.input(screen.getByLabelText("License or permission note"), {
      target: { value: "Licensed with permission" },
    });
    creditDraft = editor.onCreditDraftChange.mock.calls.at(-1)?.[0] as FacialArtworkUploadCreditDraft;
    await editor.rerender({ ...editor.props, creditDraft });
    await fireEvent.click(
      screen.getByLabelText("I confirm I have permission to use this artwork."),
    );
    creditDraft = editor.onCreditDraftChange.mock.calls.at(-1)?.[0] as FacialArtworkUploadCreditDraft;
    await editor.rerender({ ...editor.props, creditDraft });
    expect(screen.getByRole("button", { name: "Upload PNG" })).toBeEnabled();
  });

  it("uses five separate eye artwork accordions, all closed by default and one open at a time", async () => {
    renderEditor();

    for (const label of [
      "Lash & Outline Artwork",
      "Iris Artwork",
      "Pupil Artwork",
      "Eye Highlight Artwork",
      "Sclera Artwork",
    ]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    expect(screen.getByText("0 changed")).toHaveAttribute("aria-live", "polite");

    const iris = screen.getByRole("button", { name: /^Iris Artwork/ });
    const pupil = screen.getByRole("button", { name: /^Pupil Artwork/ });
    await fireEvent.click(iris);
    expect(iris).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(pupil);
    expect(iris).toHaveAttribute("aria-expanded", "false");
    expect(pupil).toHaveAttribute("aria-expanded", "true");
  });

  it("uses the shared segmented toggle and keeps guidance behind the info icon", async () => {
    renderEditor();

    const headerInfo = screen.getByRole("button", { name: "About Lash & Outline Artwork" });
    expect(headerInfo).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /^Lash & Outline Artwork/ }));
    expect(screen.getByRole("radio", { name: "Same for both" })).toHaveAttribute(
      "data-state",
      "on",
    );
    expect(screen.getByRole("radio", { name: "Customize each eye" })).toBeInTheDocument();
    expect(screen.queryByText(/Canonical Goon Left artwork mirrors/)).not.toBeInTheDocument();
    const panel = screen.getByRole("region", { name: /Lash & Outline Artwork/ });
    expect(within(panel).queryByText("Lash & Outline Artwork")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "About Lash & Outline Artwork" })).not.toBeInTheDocument();
  });

  it("switches the one human Template by anatomical side and keeps machine assets hidden", async () => {
    renderEditor({ scope: "eyes", lashesPerEye: true });
    await fireEvent.click(
      screen.getByRole("button", { name: "Lash & Outline Artwork" }),
    );

    const panel = screen.getByRole("region", { name: /Lash & Outline Artwork/ });
    expect(
      within(panel).getByRole("link", {
        name: /Goon's Left Eye \(viewer's right\) Template/,
      }),
    ).toHaveAttribute(
      "href",
      "/goons/facial-artwork/v3/lashes_eye_outline/guide-left.png",
    );
    expect(within(panel).queryByText(/pink is forbidden/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Lash & Outline Artwork" })).toBeInTheDocument();
    expect(within(panel).queryByText("Lash & Outline Artwork")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: /Mask/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: /Blank/ })).not.toBeInTheDocument();

    await fireEvent.click(
      within(panel).getByRole("radio", {
        name: "Goon's Right Eye (viewer's left)",
      }),
    );

    expect(
      within(panel).getByRole("link", {
        name: /Goon's Right Eye \(viewer's left\) Template/,
      }),
    ).toHaveAttribute(
      "href",
      "/goons/facial-artwork/v3/lashes_eye_outline/guide-right.png",
    );
  });

  it("saves the orientation-aware Template through the cross-platform helper without navigating", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(blob),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(downloadBlob).mockResolvedValue({
      completed: true,
      native: true,
      canceled: false,
    });

    renderEditor({ scope: "eyes", lashesPerEye: true });
    await fireEvent.click(
      screen.getByRole("button", { name: "Lash & Outline Artwork" }),
    );
    const panel = screen.getByRole("region", { name: /Lash & Outline Artwork/ });
    const leftTemplate = within(panel).getByRole("link", {
      name: /Goon's Left Eye \(viewer's right\) Template/,
    });
    await fireEvent.click(leftTemplate);

    await waitFor(() =>
      expect(downloadBlob).toHaveBeenCalledWith(
        blob,
        "template-guide-left.png",
        expect.objectContaining({ mimeType: "image/png", title: "Save Lash & Outline Artwork Template" }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/goons/facial-artwork/v3/lashes_eye_outline/guide-left.png",
    );

    await fireEvent.click(
      within(panel).getByRole("radio", {
        name: "Goon's Right Eye (viewer's left)",
      }),
    );
    await fireEvent.click(
      within(panel).getByRole("link", {
        name: /Goon's Right Eye \(viewer's left\) Template/,
      }),
    );
    await waitFor(() =>
      expect(downloadBlob).toHaveBeenLastCalledWith(
        blob,
        "template-guide-right.png",
        expect.objectContaining({ mimeType: "image/png" }),
      ),
    );
  });

  it("shows a template download failure instead of navigating away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    renderEditor();

    await fireEvent.click(screen.getByRole("button", { name: /^Lash & Outline Artwork/ }));
    await fireEvent.click(screen.getByRole("link", { name: /Template/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save template: Download failed (503).",
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("keeps Iris and Pupil separate with independent artwork symmetry and linked physical sizes", async () => {
    renderEditor();

    await fireEvent.click(screen.getByRole("button", { name: /^Iris Artwork/ }));
    const irisPanel = screen.getByRole("region", { name: /^Iris Artwork/ });
    expect(within(irisPanel).getByRole("slider", { name: "Iris Size" })).toBeInTheDocument();
    expect(within(irisPanel).getByRole("radio", { name: "Customize each eye" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /^Pupil Artwork/ }));
    const pupilPanel = screen.getByRole("region", { name: /^Pupil Artwork/ });
    expect(within(pupilPanel).getByRole("radio", { name: "Customize each eye" })).toBeInTheDocument();
    const pupilSlider = within(pupilPanel).getByRole("slider", { name: "Pupil Size" });
    expect(pupilSlider).toHaveAttribute("aria-valuemin", "0");
    expect(pupilSlider).toHaveAttribute("aria-valuemax", "2");
  });

  it("keeps Sclera focused on surface artwork while geometry lives in Appearance Dials", async () => {
    renderEditor();
    await fireEvent.click(screen.getByRole("button", { name: /^Sclera Artwork/ }));

    const panel = screen.getByRole("region", { name: /^Sclera Artwork/ });
    expect(within(panel).queryByText("Surface")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Sclera Fit")).not.toBeInTheDocument();
    for (const label of [
      "Sclera Scale",
      "Sclera Tilt",
      "Sclera Horizontal Position",
      "Sclera Vertical Position",
      "Sclera Depth",
    ]) {
      expect(within(panel).queryByText(label)).not.toBeInTheDocument();
    }
    expect(
      within(panel).queryByText("Artwork Horizontal Position"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByText("Artwork Vertical Position"),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByText("Artwork Scale")).not.toBeInTheDocument();
  });
});
