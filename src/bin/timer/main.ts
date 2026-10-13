// timer — a countdown that lives only in the topbar (a macOS-style menu bar extra).
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="9" r="5.5"/><path d="M8 6v3l2 1.5M6.5 1.5h3"/></svg>`;
const PRESETS = [5, 15, 25];

const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export async function main(os: AppInterface, args: string[]): Promise<void> {
  // Daemonize: relaunch detached so the shell gets its prompt back and closing
  // the terminal (SIGHUP to the job's group) doesn't take the icon with it.
  if (args[0] !== "--bg") {
    await os.process.spawn("/ProgramFiles/timer", ["--bg"]);
    await print(os, 1, "timer: running in the top bar\n");
    return os.process.exit(0);
  }
  await os.process.setsid().catch(() => {});

  let end = 0;
  let tick: ReturnType<typeof setInterval> | undefined;

  const menu = () => [
    ...PRESETS.map((m) => ({ id: String(m), label: `${m} minutes` })),
    { separator: true as const },
    { id: "stop", label: "Stop", disabled: !tick },
    { id: "quit", label: "Quit" },
  ];
  const render = (label?: string) =>
    os.display.updateStatusItem(item, { label, menu: menu() }).catch(() => {});

  const stop = (label?: string) => {
    clearInterval(tick);
    tick = undefined;
    void render(label);
  };

  const item = await os.display.addStatusItem(
    { icon: ICON, title: "Timer", menu: menu() },
    (id) => {
      if (id === "quit") return void os.process.exit(0); // kernel frees the icon
      if (id === "stop") return stop();
      const minutes = Number(id);
      if (!PRESETS.includes(minutes)) return;
      end = Date.now() + minutes * 60_000;
      clearInterval(tick);
      tick = setInterval(() => {
        const left = end - Date.now();
        if (left <= 0) stop("done");
        else void render(mmss(left));
      }, 1000);
      void render(mmss(end - Date.now()));
    },
  );
}
