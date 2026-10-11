// Bundled worker entry, as a URL (Vite compiles it as a module worker).
import workerUrl from "./worker-entry.ts?worker&url";
import { hostWorker } from "./worker-frame";

hostWorker(workerUrl);
