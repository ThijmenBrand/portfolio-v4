// env — print the environment this process inherited.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  const env = await os.process.env();
  const text = Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join("");
  await os.io.write(1, new TextEncoder().encode(text));
  await os.process.exit(0);
}
