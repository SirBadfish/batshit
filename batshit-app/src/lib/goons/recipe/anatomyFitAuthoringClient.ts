import type { RecipeSiblingStateRecord } from "./recipeContracts";
import type { AnatomyFitAuthoringInput } from "./anatomyFitAuthoring";

type AnatomyFitWorkerResponse =
  | { id: string; ok: true; sibling: RecipeSiblingStateRecord | null }
  | { id: string; ok: false; error: string };

function abortError() {
  return new DOMException("Anatomy Fit computation was canceled.", "AbortError");
}

function workerSafeInput(input: AnatomyFitAuthoringInput): AnatomyFitAuthoringInput {
  const { modelBytes, ...jsonInput } = input;
  // Svelte 5 state is a live Proxy, which Safari/WKWebView correctly rejects
  // at the structured-clone boundary used by Worker.postMessage. Anatomy Fit's
  // non-binary input is already a strict JSON contract, so snapshot the whole
  // payload here—the one shared Worker client—rather than relying on every UI
  // caller to discover and unwrap individual reactive descendants.
  const snapshot = JSON.parse(JSON.stringify(jsonInput)) as Omit<
    AnatomyFitAuthoringInput,
    "modelBytes"
  >;
  return { ...snapshot, modelBytes };
}

/** Run final-geometry fitting off the UI thread; cancellation terminates the worker. */
export function computeAnatomyFitRecipeSiblingInWorker(
  input: AnatomyFitAuthoringInput,
  signal?: AbortSignal,
): Promise<RecipeSiblingStateRecord | null> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("Anatomy Fit requires browser Worker support."));
  }
  const worker = new Worker(
    new URL("./anatomyFitAuthoring.worker.ts", import.meta.url),
    { type: "module", name: "batshit-anatomy-fit" },
  );
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Anatomy Fit Worker failed."));
    };
    worker.onmessage = (event: MessageEvent<AnatomyFitWorkerResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.ok) resolve(event.data.sibling);
      else reject(new Error(event.data.error));
    };
    const snapshot = workerSafeInput(input);
    const buffer = snapshot.modelBytes.buffer;
    if (buffer instanceof ArrayBuffer) worker.postMessage({ id, input: snapshot }, [buffer]);
    else worker.postMessage({ id, input: snapshot });
  });
}
