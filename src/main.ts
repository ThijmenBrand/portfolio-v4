import { WindowManager } from "./kernel/windows";
import { ProcessManager } from "./kernel/processes";
import Desktop from "./gui/desktop";
import { KernelCore } from "./kernel/core";
import { registry } from "./apps/registry";
import "./globals.css";

async function boot() {
  const screen = document.querySelector<HTMLElement>("#screen");
  if (!screen) {
    throw new Error("Screen element not found");
  }

  const windowManager = new WindowManager(screen);
  const processManager = new ProcessManager();
  const kernel = new KernelCore(windowManager, processManager);
  const desktop = new Desktop(kernel, registry, screen);

  desktop.render();
}

boot().catch((error) => {
  console.error("Failed to boot the system:", error);
});
