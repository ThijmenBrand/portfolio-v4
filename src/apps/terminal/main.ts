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
    os.process.exit(0);
  });

  handle.setTitle("Terminal");
  handle.body.innerHTML = "<h1>Welcome to the Terminal</h1>";
  const processList = os.process.list();
  const processListElement = document.createElement("ul");
  processList.forEach((proc) => {
    const listItem = document.createElement("li");
    listItem.textContent = `PID: ${proc.pid}, Path: ${proc.path}, Status: ${proc.status}`;
    processListElement.appendChild(listItem);
  });
  handle.body.appendChild(processListElement);
  console.log("Terminal app loaded");
}
