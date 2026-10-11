import { KernelError } from "../kernel/errors";
import type { AppInterface } from "../kernel/syscalls/api";
import { loadProgram, pipeConsole } from "./jsload";

/**
 * `#!/ProgramFiles/node`: run a JS file from the VFS as a CLI program, in a
 * worker. args[0] is the script (startScript puts it there), the rest are
 * its arguments. stdio is fds 0/1/2 via os.io, like any built-in program.
 */
export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [path, ...rest] = args;
  if (!path) throw new KernelError("EINVAL", "usage: node <file.js> [args...]");
  const flush = pipeConsole(os);
  try {
    const program = await loadProgram((p) => os.fs.readTextFile(p), path);
    await program.main(os, rest);
  } catch (error) {
    // On stderr, not just the kernel's console: that's where the user looks.
    const text = error instanceof Error ? error.message : String(error);
    await flush();
    await os.io.write(2, new TextEncoder().encode(`node: ${path}: ${text}\n`)).catch(() => {});
    await os.process.exit(1);
  }
  // Unlike a GUI app, a CLI program is done when main returns.
  await flush();
  await os.process.exit(0);
}
