// The CLI interpreter's worker (#!/ProgramFiles/node), as a URL.
import workerUrl from "./user-worker-entry.ts?worker&url";
import { hostWorker } from "./worker-frame";

hostWorker(workerUrl);
