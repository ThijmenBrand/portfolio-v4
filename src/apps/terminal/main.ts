import type { KernelInterface } from "../../kernel/types";

export function main(os: KernelInterface): void {
  const handle = os.windows.create({
    title: "Terminal",
    width: 600,
    height: 400,
    minWidth: 300,
    minHeight: 200,
    maxWidth: 1200,
    maxHeight: 800,
  });
  handle.onCloseRequest(() => {
    handle.close();
  });
  handle.setTitle("Terminal");
  handle.body.innerHTML = "<h1>Welcome to the Terminal</h1>";
  console.log("Terminal app loaded");
}
