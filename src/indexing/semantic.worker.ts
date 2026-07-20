/// <reference lib="webworker" />
import { createSemanticWorkerHandler, type SemanticWorkerRequest } from "./semantic-worker-provider";
import { transformersSemanticLoader } from "./semantic-transformers-loader";

const worker = self as DedicatedWorkerGlobalScope;
const handle = createSemanticWorkerHandler(transformersSemanticLoader, (message) => worker.postMessage(message));

worker.addEventListener("message", (event: MessageEvent<SemanticWorkerRequest>) => {
  void handle(event.data);
});
