import "./globals.css";
import { createKernel } from "./kernel/core";

function boot() {
  const screen = document.querySelector<HTMLElement>("#screen");
  if (!screen) {
    throw new Error("Screen element not found");
  }

  const kernel = createKernel(screen);
  kernel.boot();
}

boot();
