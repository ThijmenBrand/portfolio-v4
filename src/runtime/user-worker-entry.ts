import { bootWorker, type RealmAppModule } from "./boot";

/** user-worker-host's one program: the CLI interpreter (#!/ProgramFiles/node). */
bootWorker({
  "../runtime/jsrun.ts": () => import("./jsrun") as Promise<RealmAppModule>,
});
