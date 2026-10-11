// du — disk usage: bytes per directory. -s total only, -h human sizes.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";
import { human, sizeOf } from "../lib/size";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const summary = args.includes("-s");
  const fmt = args.includes("-h") ? human : String;
  const paths = args.filter((a) => !a.startsWith("-"));
  let status = 0;
  for (const path of paths.length ? paths : ["."]) {
    try {
      const report = summary ? undefined : async (dir: string, bytes: number) => print(os, 1, `${fmt(bytes)}\t${dir}\n`);
      const total = await sizeOf(os, path, report);
      if (summary) await print(os, 1, `${fmt(total)}\t${path}\n`);
    } catch (error) {
      await print(os, 2, `du: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
