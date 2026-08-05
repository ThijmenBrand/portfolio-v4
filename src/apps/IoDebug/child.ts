import type { KernelInterface } from "../../kernel/syscalls/api";

/**
 * Inheritance probe for IoDebug.
 *
 * Writes its first argument to fd 3, which it never opened — the descriptor
 * arrives from the parent through FdTable.inheritFrom at spawn. Because the
 * OPEN FILE DESCRIPTION is shared rather than copied, this write advances the
 * parent's offset too, which is the property the test actually checks.
 *
 * If fd 3 was not inherited, os.io.write throws EBADF, faultProcess terminates
 * this process at site "main", and the parent sees a file missing the "a".
 */
export async function main(os: KernelInterface, args: string[]): Promise<void> {
  await os.io.write(3, new TextEncoder().encode(args[0] ?? "?"));
  os.process.exit(0);
}
