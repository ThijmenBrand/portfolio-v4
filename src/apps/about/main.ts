// about — System Info: OS version, uptime and live process/window counts.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ADMIN_GID, readUsers } from "../../bin/lib/users";
import { opfsAvailable } from "../../kernel/fs/drivers/opfs";
import { OS_NAME, OS_VERSION } from "../../kernel/version";
import { followAccent, loadSettings, wallpaperCSS } from "../../utils/settings";
import { registry } from "../registry";
import aboutHTML from "./about.html?raw";
import "../../ui/theme.css";
import "./about.css";

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "System Info" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = aboutHTML;

  set("os", OS_NAME);
  set("version", `Version ${OS_VERSION}`);
  set("apps", String(registry.length));
  set("storage", opfsAvailable() ? "OPFS (persistent)" : "In-memory");
  set("browser", navigator.userAgent);

  const settings = await loadSettings(os);
  set("theme", `${settings.wallpaper}, ${settings.accent} accent`);
  document.querySelector<HTMLElement>('[data-field="wallpaper-thumb"]')!.style.background =
    await wallpaperCSS(os, settings);

  const { uid } = await os.process.ids();
  const env = await os.process.env();
  const user = (await readUsers(os).catch(() => [])).find((u) => u.uid === uid);
  const role = uid === 0 ? "root" : user?.gid === ADMIN_GID ? "owner" : "user";
  set("user", `${user?.name ?? env.USER ?? "user"} (${role})`);

  const tick = async (): Promise<void> => {
    const [uptime, processes, windows] = await Promise.all([
      os.fs.readTextFile("/proc/uptime"),
      os.process.list(),
      os.windows.list(),
    ]);
    set("uptime", formatUptime(parseFloat(uptime)));
    set("processes", String(processes.length));
    set("windows", String(windows.length));
  };
  await tick();
  setInterval(() => void tick().catch((error) => console.error("[about]", error)), 1000);
}

function set(field: string, text: string): void {
  for (const el of document.querySelectorAll(`[data-field="${field}"]`)) el.textContent = text;
}

/** 3725 -> "1h 2m 5s" */
function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const parts = [[Math.floor(s / 3600), "h"], [Math.floor((s % 3600) / 60), "m"], [s % 60, "s"]] as const;
  return parts.filter(([n], i) => n > 0 || i === 2).map(([n, unit]) => `${n}${unit}`).join(" ");
}
