import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode } from "../../bin/lib/input";
import { extOf, IMAGE_TYPES } from "../../utils/filetypes";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";
import "./preview.css";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 32;
const STEP = 1.25;

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export async function main(os: AppInterface, args: string[] = []): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Preview" });
  void handle.onCloseRequest(() => void os.process.exit(0));

  let path: string | undefined = args[0];
  if (!path) {
    // Launched on its own: ask which image to show (the picker needs our window to sit on).
    try {
      path = (await os.dialog.open({ kind: "file", title: "Open Image" })) ?? undefined;
    } catch (error) {
      return fail(`Couldn't open the file picker (${errorCode(error)}).`);
    }
    if (!path) return void os.process.exit(0);
  }

  const name = path.slice(path.lastIndexOf("/") + 1);
  void handle.setTitle(name);
  if (!IMAGE_TYPES[extOf(path)]) return fail(`${name} isn't an image Preview can show.`);

  try {
    const bytes = await os.fs.readFile(path);
    const img = document.createElement("img");
    img.alt = name;
    img.draggable = false;
    img.onerror = () => fail(`${name} isn't a valid image.`);
    img.onload = () => viewer(img);
    img.src = URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[extOf(path)] }));
  } catch (error) {
    fail(`Couldn't open ${name} (${errorCode(error)}).`);
  }
}

function viewer(img: HTMLImageElement): void {
  // zoom is relative to "fit in window"; x/y is the pan offset in screen pixels.
  let zoom = 1;
  let turn = 0;
  let x = 0;
  let y = 0;

  const bar = document.createElement("div");
  bar.className = "toolbar";
  const button = (label: string, icon: string, action: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.title = b.ariaLabel = label;
    b.innerHTML = icon;
    b.addEventListener("click", action);
    return b;
  };
  const pct = button("Fit to window (0)", "", () => reset());
  pct.className = "pct";
  bar.append(
    button("Rotate left (Shift+R)", svg('<path d="M3 3v3.5h3.5"/><path d="M3.4 6.5a5 5 0 1 1 .6 4.5"/>'), () => rotate(-1)),
    button("Rotate right (R)", svg('<path d="M13 3v3.5H9.5"/><path d="M12.6 6.5a5 5 0 1 0-.6 4.5"/>'), () => rotate(1)),
    button("Zoom out (−)", svg('<path d="M4 8h8"/>'), () => zoomBy(1 / STEP)),
    pct,
    button("Zoom in (+)", svg('<path d="M4 8h8M8 4v8"/>'), () => zoomBy(STEP)),
  );
  document.body.replaceChildren(img, bar);

  /** Extra scale so a 90°-turned image still fits the window. */
  const fit = (): number =>
    turn % 2 ? Math.min(1, innerWidth / img.clientHeight, innerHeight / img.clientWidth) : 1;

  function render(): void {
    const scale = zoom * fit();
    img.style.transform = `translate(${x}px, ${y}px) rotate(${turn * 90}deg) scale(${scale})`;
    pct.textContent = `${Math.round((img.clientWidth * scale * 100) / img.naturalWidth)}%`;
  }

  function reset(): void {
    zoom = 1;
    x = y = 0;
    render();
  }

  function rotate(dir: number): void {
    turn = (turn + dir + 4) % 4;
    // Keep the same spot centred: rotate the pan offset with the image.
    [x, y] = dir > 0 ? [-y, x] : [y, -x];
    render();
  }

  /** Zoom by `factor`, keeping the point under (mx, my) — window coords — still. */
  function zoomBy(factor: number, mx = innerWidth / 2, my = innerHeight / 2): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const k = next / zoom;
    const cx = mx - innerWidth / 2;
    const cy = my - innerHeight / 2;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    zoom = next;
    render();
  }

  addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send big ones.
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
    },
    { passive: false },
  );

  img.addEventListener("dblclick", (e) => (zoom === 1 ? zoomBy(2, e.clientX, e.clientY) : reset()));

  img.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    img.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (m: PointerEvent): void => {
      x += m.clientX - lastX;
      y += m.clientY - lastY;
      lastX = m.clientX;
      lastY = m.clientY;
      render();
    };
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerup", () => img.removeEventListener("pointermove", move), { once: true });
  });

  addEventListener("keydown", (e) => {
    if (e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP);
    else if (e.key === "0") reset();
    else if (e.key.toLowerCase() === "r") rotate(e.shiftKey ? -1 : 1);
    else return;
    e.preventDefault();
  });

  addEventListener("resize", render);
  render();
}

function fail(message: string): void {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  document.body.replaceChildren(p);
}
