import "./globals.css";
import { createKernel } from "./kernel/core";
import { kernelError } from "./kernel/errors";

async function boot() {
  const screen = document.querySelector<HTMLElement>("#screen");
  if (!screen) {
    throw kernelError("ENODEV", "Screen element not found");
  }

  const kernel = createKernel(screen);
  await kernel.boot();
}

boot().catch((err) => {
  console.error("Kernel boot failed:", err);
  const screen = document.querySelector<HTMLElement>("#screen");
  if (screen) {
    screen.innerHTML = "<h1>Kernel boot failed</h1>";
  }
});
