import { KernelCore } from "./kernel/core";
import "./globals.css";

async function boot() {
  const screen = document.querySelector<HTMLElement>("#screen");
  if (!screen) {
    throw new Error("Screen element not found");
  }

  const kernel = new KernelCore(screen);
  kernel.boot();
}

boot().catch((error) => {
  console.error("Failed to boot the system:", error);
});
