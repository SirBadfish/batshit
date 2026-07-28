import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnatomyFitAuthoringInput } from "./anatomyFitAuthoring";
import { computeAnatomyFitRecipeSiblingInWorker } from "./anatomyFitAuthoringClient";

class CloneProbeWorker {
  static latest: CloneProbeWorker | null = null;

  onerror: ((event: { message?: string }) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly terminate = vi.fn();
  request: { id: string; input: AnatomyFitAuthoringInput } | null = null;

  constructor() {
    CloneProbeWorker.latest = this;
  }

  postMessage(
    request: { id: string; input: AnatomyFitAuthoringInput },
    transfer: Transferable[] = [],
  ) {
    this.request = request;
    structuredClone(request, { transfer });
    queueMicrotask(() => {
      this.onmessage?.({
        data: { id: request.id, ok: true, sibling: null },
      } as MessageEvent);
    });
  }
}

function proxiedInput(): AnatomyFitAuthoringInput {
  const source = new Proxy(
    {
      contract: "recipe-source/v1",
      schemaVersion: 1,
      baseId: "batshit-base-f-v1",
    },
    {},
  );
  const appearanceDials = new Proxy(
    {
      contract: "appearance-dial-values/v2",
      definitionSha256: "a".repeat(64),
      neutralId: "neutral",
      neutralRecipeSha256: "b".repeat(64),
      values: { eye_size: -1, eye_spacing: -1 },
      unlockedDialIds: [],
    },
    {},
  );
  return {
    manifest: { anatomyFit: null },
    modelBytes: new Uint8Array([1, 2, 3]),
    source,
    appearanceDials,
    previousSibling: null,
  } as unknown as AnatomyFitAuthoringInput;
}

afterEach(() => {
  vi.unstubAllGlobals();
  CloneProbeWorker.latest = null;
});

describe("Anatomy Fit authoring Worker client", () => {
  it("snapshots reactive JSON descendants before the Worker structured-clone boundary", async () => {
    vi.stubGlobal("Worker", CloneProbeWorker);
    const input = proxiedInput();

    expect(() => structuredClone({ input })).toThrow();
    await expect(computeAnatomyFitRecipeSiblingInWorker(input)).resolves.toBeNull();

    expect(CloneProbeWorker.latest?.request?.input.source).toEqual({
      contract: "recipe-source/v1",
      schemaVersion: 1,
      baseId: "batshit-base-f-v1",
    });
    expect(CloneProbeWorker.latest?.request?.input.source).not.toBe(input.source);
    expect(
      CloneProbeWorker.latest?.request?.input.appearanceDials.values,
    ).toEqual({ eye_size: -1, eye_spacing: -1 });
    expect(CloneProbeWorker.latest?.terminate).toHaveBeenCalledOnce();
  });
});
