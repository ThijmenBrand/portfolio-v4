// admin — the owner's private app: a starting point that proves the path
// works (kernel api.fetch -> server -> session check). Private routes live
// under /api/private/ in server/main.ts.
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Admin" });
  void handle.onCloseRequest(() => void os.process.exit(0));

  const status = document.createElement("p");
  status.style.cssText = "margin:16px;font-family:var(--app-sans);color:var(--app-text)";
  status.textContent = "Checking the backend…";
  document.body.append(status);

  try {
    const response = await os.api.fetch("/api/private/ping");
    status.textContent =
      response.status === 200
        ? `Backend OK, signed in as ${(JSON.parse(response.body) as { user: string }).user}.`
        : `Backend says ${response.status}: not signed in.`;
  } catch (error) {
    status.textContent = `Backend unreachable: ${(error as { code?: string }).code ?? "error"}`;
  }
}
