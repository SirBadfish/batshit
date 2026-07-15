import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  readEyeAppearanceControl,
  reconcileEyeAppearanceState,
  resolveEyeAppearanceRuntimeControlValue,
  updateEyeAppearanceControl,
} from "./eyeAppearance";

function loadDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "static/goons/eye-appearance/v1/eye-appearance-v1.json",
      ),
      "utf8",
    ),
  );
}

describe("eye-appearance/v1", () => {
  it("parses the actual canonical definition and exact runtime bindings", () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition());
    expect(definition.definitionSha256).toBe(
			"893524d10fb17a1523242508e58b195e17a149bd5b6cafda763264c5a1a66cfb",
    );
    expect(definition.runtimeBindings.left.eyeBone).toBe("mixamorigLeftEye");
    expect(definition.runtimeBindings.right.horizontalSign).toBe(-1);
    expect(definition.runtimeBindings.left.eyeHighlightMaterialNodes).toEqual([
      "bs_f1_eye_l_iris",
      "bs_f1_eye_l_pupil",
    ]);
  });

  it("creates exact linked bilateral defaults and exposes all eight controls", () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition());
    const state = createDefaultEyeAppearanceState(definition);
    expect(state).toEqual({
      schemaVersion: "eye-appearance-state/v1",
      definitionSha256: definition.definitionSha256,
      irisSize: 1,
      pupilSize: 1,
      eyeConvergence: 0,
      scleraFit: { scale: 0, tilt: 0, horizontal: 0, vertical: 0, depth: 0 },
    });
    expect(readEyeAppearanceControl(state, "sclera_horizontal_position")).toBe(
      0,
    );
    expect(
      updateEyeAppearanceControl(state, "pupil_size", 1.25).pupilSize,
    ).toBe(1.25);
    expect(
      updateEyeAppearanceControl(state, "eye_convergence", 4.5)
        .eyeConvergence,
    ).toBe(4.5);
    expect(
      resolveEyeAppearanceRuntimeControlValue(
        definition,
        "eye_convergence",
        state.eyeConvergence,
      ),
    ).toBe(4);
  });

  it("updates mounted proxy state without structured-clone failures", () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition());
    const state = createDefaultEyeAppearanceState(definition);
    const mountedProxy = new Proxy(state, {});

    const updated = updateEyeAppearanceControl(
      mountedProxy,
      "sclera_vertical_position",
      0.00025,
    );

    expect(updated.scleraFit.vertical).toBe(0.00025);
    expect(state.scleraFit.vertical).toBe(0);
  });

  it("rejects per-eye state, stale definitions, and out-of-range values without clamping", () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition());
    const state = createDefaultEyeAppearanceState(definition) as any;
    state.left = { irisSize: 1.1 };
    expect(() => parseEyeAppearanceState(definition, state)).toThrow(
      /unsupported fields/,
    );
    delete state.left;
    state.irisSize = 1.351;
    expect(() => parseEyeAppearanceState(definition, state)).toThrow(
      /inside \[0.75, 1.35\]/,
    );
    state.irisSize = 1;
    state.definitionSha256 = "a".repeat(64);
    expect(reconcileEyeAppearanceState(definition, state)).toMatchObject({
      state: null,
      incompatible: true,
    });
  });

  it("rejects control endpoints and defaults that Bits UI cannot represent on the step lattice", () => {
    const unreachableMaximum = loadDefinition();
    const maximumControl = unreachableMaximum.controls.find(
      (control: { id: string }) => control.id === "sclera_horizontal_position",
    );
    maximumControl.maximum += maximumControl.step / 2;
    expect(() => parseEyeAppearanceDefinition(unreachableMaximum)).toThrow(
      /maximum must be reachable from minimum by whole steps/,
    );

    const unreachableDefault = loadDefinition();
    const defaultControl = unreachableDefault.controls.find(
      (control: { id: string }) => control.id === "sclera_horizontal_position",
    );
    defaultControl.default = defaultControl.step / 2;
    expect(() => parseEyeAppearanceDefinition(unreachableDefault)).toThrow(
      /default must be reachable from minimum by whole steps/,
    );
  });
});
