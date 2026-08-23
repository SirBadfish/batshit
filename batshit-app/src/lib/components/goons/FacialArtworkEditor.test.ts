import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FacialArtworkEditor from "./FacialArtworkEditor.svelte";
import { downloadBlob } from "$lib/utils/download";
import { buildFacialArtworkV6DefinitionFixture } from "$lib/goons/__fixtures__/facialArtworkV6";
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  resolveFacialArtworkTemplateVariant,
  type FacialArtworkDefinition,
  type FacialArtworkRoleId,
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
  type EyeAppearanceDefinition,
} from "$lib/goons/eyeAppearance";
import {
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "$lib/goons/socketEyeArtworkProjection";

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

if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.animate !== "function"
) {
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

function buildFacialArtworkDefinition(): FacialArtworkDefinition {
  return buildFacialArtworkV6DefinitionFixture();
}

function buildEyeAppearanceDefinition(): EyeAppearanceDefinition {
  const labels: Record<(typeof EYE_APPEARANCE_CONTROL_IDS)[number], string> = {
    iris_size: "Iris Size",
    pupil_size: "Pupil Size",
    iris_horizontal_position: "Iris Horizontal Position",
    iris_vertical_position: "Iris Vertical Position",
  };
  const controls = EYE_APPEARANCE_CONTROL_IDS.map((id) => {
    const sizeRange =
      id === "iris_size" || id === "pupil_size"
        ? { minimum: 0.5, maximum: 1.5, default: 1 }
        : { minimum: -1, maximum: 1, default: 0 };
    return {
      id,
      label: labels[id],
      description: `${labels[id]} test description`,
      ...sizeRange,
      step: 0.01,
      unit:
        id === "pupil_size"
          ? "iris-relative-multiplier"
          : id === "iris_vertical_position" || id === "iris_horizontal_position"
            ? "neutral-travel-fraction"
            : "neutral-multiplier",
      linkedBilateral: true,
      bilateralLaw:
        id === "iris_horizontal_position"
          ? "mirrored-convergence-divergence"
          : "linked-same-value",
      perEyeOverridesAllowed: false,
      runtimeClampingAllowed: false,
      geometrySemantics: `${labels[id]} test control`,
    };
  }) as EyeAppearanceControlDefinition[];

  return {
    schemaVersion: "eye-appearance/v5",
    stateSchemaVersion: "eye-appearance-state/v5",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: HASH,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: HASH,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: HASH,
      },
    },
    ownership: "test",
    zeroLaw: "One keeps the package-authored iris and pupil size.",
    symmetryLaw: "Iris and pupil controls are linked bilaterally.",
    compositionOrder: [
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ],
    solidColorDefaults: {
      iris: [0.1, 0.5, 0.6, 1],
      pupil: [0.02, 0.02, 0.02, 1],
      sclera: [0.92, 0.9, 0.86, 1],
    },
    runtimeBindings: {
      coordinateSpace: "physical-eye-sphere",
      left: {
        physicalEyeNode: "bs_f1_eye_l_physical",
        irisNeutralRadiusMeters: 0.0081,
        pupilNeutralRadiusRatio: 0.49,
        neutralPlacement: {
          horizontalTravelFraction: -0.5,
          verticalTravelFraction: -0.7,
        },
        irisHorizontalTravelMeters: 0.003,
        irisVerticalTravelMeters: 0.003,
        edgeSoftnessMeters: 0.0002,
        artworkMappings: {
          sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
          iris: "sphere-tangent-radial",
          pupil: "sphere-tangent-radial",
          highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
        },
        cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
      },
      right: {
        physicalEyeNode: "bs_f1_eye_r_physical",
        irisNeutralRadiusMeters: 0.0081,
        pupilNeutralRadiusRatio: 0.49,
        neutralPlacement: {
          horizontalTravelFraction: -0.5,
          verticalTravelFraction: -0.7,
        },
        irisHorizontalTravelMeters: 0.003,
        irisVerticalTravelMeters: 0.003,
        edgeSoftnessMeters: 0.0002,
        artworkMappings: {
          sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
          iris: "sphere-tangent-radial",
          pupil: "sphere-tangent-radial",
          highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
        },
        cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
      },
      geometryEvidence: {
        acceptedGlbSha256: HASH,
        socketSurfaceSha256: HASH,
        apertureSeamSha256: HASH,
      },
    },
    controls: controls as EyeAppearanceDefinition["controls"],
    rangeEvidence: {
      schemaVersion: "test",
      sha256: HASH,
      canonicalSha256: HASH,
    },
  } as EyeAppearanceDefinition;
}

function renderEditor(
  options: {
    scope?: "brows" | "eyes";
    lashesPerEye?: boolean;
    artworkRoles?: FacialArtworkRoleId[];
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
  for (const roleId of options.artworkRoles ?? []) {
    const roleDefinition = definition.roles.find(
      (entry) => entry.id === roleId,
    )!;
    const template = definition.templates.find(
      (entry) => entry.id === roleDefinition.template,
    )!;
    const variant = resolveFacialArtworkTemplateVariant(
      template,
      template.canonicalOrientation,
    );
    const roleState = valueState.roles[roleId];
    if (roleState.mode !== "shared")
      throw new Error("fixture requires shared artwork");
    roleState.shared.visible = true;
    roleState.shared.artwork = createFacialArtworkArtworkLayer(
      definition,
      roleId,
      {
        role: roleId,
        url: `/uploads/${roleId}.png`,
        filename: `${roleId}.png`,
        size: 100,
        mimeType: "image/png",
        sha256: HASH,
        template: {
          id: template.id,
          version: template.version,
          orientation: template.canonicalOrientation,
          guideSha256: variant.guide.sha256,
          maskSha256: variant.safePaintMask.sha256,
        },
        provenance: {
          sourceKind: "user-authored",
          author: "Josh",
          license: "User-owned",
          rightsConfirmed: true,
        },
      },
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
    creditDraft:
      options.creditDraft ?? createDefaultFacialArtworkUploadCreditDraft(),
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

    expect(screen.getByRole("button", { name: "Source" })).toHaveTextContent(
      "My artwork",
    );
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
    expect(
      screen.queryByRole("button", { name: "Upload PNG" }),
    ).not.toBeInTheDocument();

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
    creditDraft = editor.onCreditDraftChange.mock.calls.at(
      -1,
    )?.[0] as FacialArtworkUploadCreditDraft;
    await editor.rerender({ ...editor.props, creditDraft });
    await fireEvent.input(screen.getByLabelText("License or permission note"), {
      target: { value: "Licensed with permission" },
    });
    creditDraft = editor.onCreditDraftChange.mock.calls.at(
      -1,
    )?.[0] as FacialArtworkUploadCreditDraft;
    await editor.rerender({ ...editor.props, creditDraft });
    await fireEvent.click(
      screen.getByLabelText("I confirm I have permission to use this artwork."),
    );
    creditDraft = editor.onCreditDraftChange.mock.calls.at(
      -1,
    )?.[0] as FacialArtworkUploadCreditDraft;
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
      expect(
        screen.getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByText("0 changed")).toHaveAttribute(
      "aria-live",
      "polite",
    );

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

    const headerInfo = screen.getByRole("button", {
      name: "About Lash & Outline Artwork",
    });
    expect(headerInfo).toBeInTheDocument();
    await fireEvent.click(
      screen.getByRole("button", { name: /^Lash & Outline Artwork/ }),
    );
    expect(
      screen.getByRole("radio", { name: "Same for both" }),
    ).toHaveAttribute("data-state", "on");
    expect(
      screen.getByRole("radio", { name: "Customize each eye" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Canonical Goon Left artwork mirrors/),
    ).not.toBeInTheDocument();
    const panel = screen.getByRole("region", {
      name: /Lash & Outline Artwork/,
    });
    expect(
      within(panel).queryByText("Lash & Outline Artwork"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", {
        name: "About Lash & Outline Artwork",
      }),
    ).not.toBeInTheDocument();
  });

  it("switches the one human Template by anatomical side and keeps machine assets hidden", async () => {
    renderEditor({ scope: "eyes", lashesPerEye: true });
    await fireEvent.click(
      screen.getByRole("button", { name: "Lash & Outline Artwork" }),
    );

    const panel = screen.getByRole("region", {
      name: /Lash & Outline Artwork/,
    });
    expect(
      within(panel).getByRole("link", {
        name: /Goon's Left Eye \(viewer's right\) Template/,
      }),
    ).toHaveAttribute(
      "href",
      "/goons/facial-artwork/v6/test-v6/lashes_eye_outline/guide-anatomical-left.png",
    );
    expect(
      within(panel).queryByText(/pink is forbidden/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "About Lash & Outline Artwork" }),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText("Lash & Outline Artwork"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("link", { name: /Mask/ }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("link", { name: /Blank/ }),
    ).not.toBeInTheDocument();

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
      "/goons/facial-artwork/v6/test-v6/lashes_eye_outline/guide-anatomical-right.png",
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
    const panel = screen.getByRole("region", {
      name: /Lash & Outline Artwork/,
    });
    const leftTemplate = within(panel).getByRole("link", {
      name: /Goon's Left Eye \(viewer's right\) Template/,
    });
    await fireEvent.click(leftTemplate);

    await waitFor(() =>
      expect(downloadBlob).toHaveBeenCalledWith(
        blob,
        "template-guide-anatomical-left.png",
        expect.objectContaining({
          mimeType: "image/png",
          title: "Save Lash & Outline Artwork Template",
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/goons/facial-artwork/v6/test-v6/lashes_eye_outline/guide-anatomical-left.png",
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
        "template-guide-anatomical-right.png",
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

    await fireEvent.click(
      screen.getByRole("button", { name: /^Lash & Outline Artwork/ }),
    );
    await fireEvent.click(screen.getByRole("link", { name: /Template/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save template: Download failed (503).",
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("keeps Iris and Pupil artwork separate while exposing the linked physical placement controls", async () => {
    renderEditor();

    await fireEvent.click(
      screen.getByRole("button", { name: /^Iris Artwork/ }),
    );
    const irisPanel = screen.getByRole("region", { name: /^Iris Artwork/ });
    expect(
      within(irisPanel).getByRole("slider", { name: "Iris Size" }),
    ).toBeInTheDocument();
    const horizontalSlider = within(irisPanel).getByRole("slider", {
      name: "Iris Horizontal Position",
    });
    expect(horizontalSlider).toHaveAttribute("aria-valuemin", "-1");
    expect(horizontalSlider).toHaveAttribute("aria-valuemax", "1");
    expect(horizontalSlider).toHaveAttribute("aria-valuenow", "0");
    const verticalSlider = within(irisPanel).getByRole("slider", {
      name: "Iris Vertical Position",
    });
    expect(verticalSlider).toHaveAttribute("aria-valuemin", "-1");
    expect(verticalSlider).toHaveAttribute("aria-valuemax", "1");
    expect(verticalSlider).toHaveAttribute("aria-valuenow", "0");
    expect(
      within(irisPanel).getByRole("radio", { name: "Customize each eye" }),
    ).toBeInTheDocument();

    await fireEvent.click(
      screen.getByRole("button", { name: /^Pupil Artwork/ }),
    );
    const pupilPanel = screen.getByRole("region", { name: /^Pupil Artwork/ });
    expect(
      within(pupilPanel).getByRole("radio", { name: "Customize each eye" }),
    ).toBeInTheDocument();
    const pupilSlider = within(pupilPanel).getByRole("slider", {
      name: "Pupil Size",
    });
    expect(pupilSlider).toHaveAttribute("aria-valuemin", "0.5");
    expect(pupilSlider).toHaveAttribute("aria-valuemax", "1.5");
  });

  it("keeps Sclera focused on surface artwork without retired globe geometry controls", async () => {
    renderEditor();
    await fireEvent.click(
      screen.getByRole("button", { name: /^Sclera Artwork/ }),
    );

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

  it("renders only the transform controls owned by each v6 role definition", async () => {
    const eyeEditor = renderEditor({
      artworkRoles: [
        "lashes_eye_outline",
        "iris",
        "pupil",
        "eye_highlight",
        "sclera",
      ],
    });

    for (const label of ["Iris Artwork", "Pupil Artwork"]) {
      await fireEvent.click(
        screen.getByRole("button", { name: new RegExp(`^${label}`) }),
      );
      const panel = screen.getByRole("region", {
        name: new RegExp(`^${label}`),
      });
      expect(within(panel).getByText("Artwork Rotation")).toBeInTheDocument();
      expect(
        within(panel).queryByText("Artwork Horizontal Position"),
      ).not.toBeInTheDocument();
      expect(
        within(panel).queryByText("Artwork Vertical Position"),
      ).not.toBeInTheDocument();
      expect(
        within(panel).queryByText("Artwork Scale"),
      ).not.toBeInTheDocument();
    }

    for (const label of ["Lash & Outline Artwork", "Eye Highlight Artwork"]) {
      await fireEvent.click(
        screen.getByRole("button", { name: new RegExp(`^${label}`) }),
      );
      const panel = screen.getByRole("region", {
        name: new RegExp(`^${label}`),
      });
      for (const control of [
        "Artwork Horizontal Position",
        "Artwork Vertical Position",
        "Artwork Scale",
        "Artwork Rotation",
      ]) {
        expect(within(panel).getByText(control)).toBeInTheDocument();
      }
    }

    await fireEvent.click(
      screen.getByRole("button", { name: /^Sclera Artwork/ }),
    );
    const scleraPanel = screen.getByRole("region", { name: /^Sclera Artwork/ });
    expect(
      within(scleraPanel).getByText("Artwork Rotation"),
    ).toBeInTheDocument();
    expect(
      within(scleraPanel).queryByText("Artwork Scale"),
    ).not.toBeInTheDocument();

    eyeEditor.unmount();
    renderEditor({ scope: "brows", artworkRoles: ["brows"] });
    await fireEvent.click(
      screen.getByRole("button", { name: /^Brow Artwork/ }),
    );
    const browPanel = screen.getByRole("region", { name: /^Brow Artwork/ });
    for (const control of [
      "Artwork Horizontal Position",
      "Artwork Vertical Position",
      "Artwork Scale",
      "Artwork Rotation",
    ]) {
      expect(within(browPanel).getByText(control)).toBeInTheDocument();
    }
  });
});
