import { bootWorker, type RealmAppModule } from "./boot";

/**
 * user-worker-host's programs: the CLI interpreter (#!/ProgramFiles/node) and
 * the one that runs an installed app's Spotlight commands (jscommand).
 */
bootWorker({
  "../runtime/jsrun.ts": () => import("./jsrun") as Promise<RealmAppModule>,
  "../runtime/jscommand.ts": () => import("./jscommand") as Promise<RealmAppModule>,
});
