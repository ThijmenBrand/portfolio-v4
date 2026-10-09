// hello — the first iframe app. Runs in <iframe sandbox="allow-scripts"> with
// its own document; every kernel call goes over the wire.
import type { AppInterface } from "../../kernel/syscalls/api";
import "../../ui/theme.css";
import "./hello.css";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export async function main(os: AppInterface): Promise<void> {
  // Claims the window the kernel made for us at exec.
  const win = await os.windows.create({ title: "Hello" });

  const root = el("div");
  root.className = "hello";
  root.append(el("h1", "Hello from an iframe"));

  // --- facts, each one a syscall over the wire ---
  const facts = el("dl");
  const fact = (name: string) => {
    const value = el("dd", "…");
    facts.append(el("dt", name), value);
    return value;
  };
  fact("pid").textContent = String(os.process.pid);
  fact("window").textContent = String(win.id);
  const origin = fact("origin");
  origin.textContent = self.origin; // "null": sandboxed, opaque origin
  const cwd = fact("cwd");
  const home = fact("/home");
  const procs = fact("processes");
  const focused = fact("focused");
  root.append(facts);

  cwd.textContent = await os.process.cwd();
  os.fs
    .readdir("/home")
    .then((entries) => {
      home.textContent = entries.map((e) => e.name).join(", ") || "(empty)";
    })
    .catch((error: { code?: string }) => {
      home.textContent = error.code ?? "error";
    });

  // Process count, refreshed by a LOCAL timer (runs in this iframe, not the kernel).
  const refresh = async () => {
    procs.textContent = String((await os.process.list()).length);
  };
  await refresh();
  await os.timers.setInterval(() => void refresh(), 1000);

  // A callback the kernel invokes across the wire. Unprivileged processes
  // only receive events about themselves, so: our own window gaining focus.
  let focusCount = 0;
  focused.textContent = "0×";
  await os.events.subscribe(["window.focused"], (event) => {
    if (event.windowId !== win.id) return;
    focused.textContent = `${++focusCount}×`;
  });

  // --- buttons ---
  const buttons = el("div");
  buttons.className = "row";

  let clicks = 0;
  const count = el("button", "Count");
  count.onclick = () => {
    clicks++;
    void win.setTitle(`Hello (${clicks})`);
  };

  // Blocks THIS realm for 3s. The rest of the OS should keep running
  // (in Chromium the sandboxed frame is out of process).
  const spin = el("button", "Busy-loop 3s");
  spin.onclick = () => {
    spin.textContent = "Spinning…";
    setTimeout(() => {
      const end = performance.now() + 3000;
      while (performance.now() < end) {
        // deliberately hog the event loop
      }
      spin.textContent = "Busy-loop 3s";
    }, 0);
  };

  buttons.append(count, spin);
  root.append(buttons);

  // --- cooperative close: ✕ asks, the app decides (no confirm(): sandboxed) ---
  const confirm = el("div");
  confirm.className = "confirm";
  confirm.hidden = true;
  const yes = el("button", "Close");
  const no = el("button", "Cancel");
  const confirmRow = el("div");
  confirmRow.className = "row";
  confirmRow.append(yes, no);
  confirm.append(el("p", "Close Hello?"), confirmRow);
  root.append(confirm);

  yes.onclick = () => void win.close(); // last window gone → the kernel ends us
  no.onclick = () => {
    confirm.hidden = true;
  };
  await win.onCloseRequest(() => {
    confirm.hidden = false;
    yes.focus();
  });

  document.body.append(root);
}
