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

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AnatomyFitWorkerRequest>) => void) | null;
  postMessage: (value: AnatomyFitWorkerResponse) => void;
};

workerScope.onmessage = (event) => {
  const { id, input } = event.data;
  void computeAnatomyFitRecipeSibling(input)
    .then((sibling) => workerScope.postMessage({ id, ok: true, sibling }))
    .catch((error: unknown) =>
      workerScope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
};
