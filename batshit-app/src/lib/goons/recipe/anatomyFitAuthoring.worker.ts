/// <reference lib="webworker" />

import {
  computeAnatomyFitRecipeSibling,
  type AnatomyFitAuthoringInput,
} from "./anatomyFitAuthoring";

type AnatomyFitWorkerRequest = {
  id: string;
  input: AnatomyFitAuthoringInput;
};

type AnatomyFitWorkerResponse =
  | { id: string; ok: true; sibling: Awaited<ReturnType<typeof computeAnatomyFitRecipeSibling>> }
  | { id: string; ok: false; error: string };

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<AnatomyFitWorkerRequest>) => {
  if (event.origin !== workerScope.origin) {
    throw new Error("Anatomy Fit worker rejected a request from an unexpected origin");
  }
  const request = event.data;
  if (
    !request ||
    typeof request.id !== "string" ||
    request.id.length === 0 ||
    !request.input ||
    typeof request.input !== "object"
  ) {
    throw new Error("Anatomy Fit worker received an invalid request envelope");
  }
  const { id, input } = request;
  void computeAnatomyFitRecipeSibling(input)
    .then((sibling) => workerScope.postMessage({ id, ok: true, sibling }))
    .catch((error: unknown) =>
      workerScope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
});
