import type { RealmAppModule } from "./boot";
import { bootFrame } from "./frame";
import "../ui/theme.css";
import "../ui/kit.css";

/**
 * user-app-host's one app: the GUI interpreter (#!/ProgramFiles/jsapp),
 * which loads the program from the VFS. The theme and kit CSS come along,
 * so user apps look native by default. Key matches binfmt `entry` + ".ts".
 */
bootFrame({
  "../runtime/jsapp.ts": () => import("./jsapp") as Promise<RealmAppModule>,
});
