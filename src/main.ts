import "./globals.css";
import { createKernel } from "./kernel/core";
import { kernelError } from "./kernel/errors";

function boot() {
  const screen = document.querySelector<HTMLElement>("#screen");
  if (!screen) {
    throw kernelError("ENODEV", "Screen element not found");
  }

  const kernel = createKernel(screen);
  kernel.boot();
}

boot();
