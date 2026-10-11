import type { SystemInterface } from "../../kernel/syscalls/api";
import { logError } from "../../kernel/errors";
import { ACCENTS, LIVE_WALLPAPERS, loadSettings } from "../../utils/settings";

const RAMP = " .:-=+*#%@";
const CELL_W = 10;
const CELL_H = 18;
const FRAME_MS = 1000 / 30;
const BASE = "#07090c";
const TRAIL = 5;
const RIPPLE = 28;

/**
 * Live wallpaper engine: a glowing ASCII field under the desktop that follows the
 * mouse. Draws while settings.wallpaper is a live one, idles otherwise.
 */
export async function main(os: SystemInterface): Promise<void> {
  const root = await os.display.root();
  const doc = root.ownerDocument;
  const win = doc.defaultView!;

  const canvas = doc.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  root.prepend(canvas);
  const ctx = canvas.getContext("2d")!;
  const glyphs = doc.createElement("canvas");
  const g = glyphs.getContext("2d")!;

  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
  let cols = 0;
  let rows = 0;
  let trail = new Float32Array(0);
  let color = ACCENTS.blue;
  let on = false;
  let raf = 0;
  let last = 0;
  let mouseX = -1e4;
  let mouseY = -1e4;
  let moved = false;

  const resize = (): void => {
    const dpr = win.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = root;
    for (const c of [canvas, glyphs]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL_W);
    rows = Math.ceil(h / CELL_H);
    trail = new Float32Array(cols * rows);
    if (on) draw(performance.now());
  };

  const draw = (now: number): void => {
    const t = reduced.matches ? 0 : now / 1000;
    const mx = mouseX / CELL_W;
    const my = mouseY / CELL_H;

    if (moved) {
      moved = false;
      for (let y = Math.max(0, Math.floor(my - TRAIL)); y < Math.min(rows, my + TRAIL); y++) {
        for (let x = Math.max(0, Math.floor(mx - TRAIL)); x < Math.min(cols, mx + TRAIL); x++) {
          const i = y * cols + x;
          trail[i] = Math.max(trail[i], 1 - Math.hypot(x - mx, (y - my) * 1.8) / TRAIL);
        }
      }
    }

    // ponytail: fillText per cell, ~10k calls at 1080p; a glyph atlas + drawImage if 4K stutters.
    g.clearRect(0, 0, cols * CELL_W, rows * CELL_H);
    g.font = `${CELL_H - 4}px ui-monospace, Menlo, Consolas, monospace`;
    g.textBaseline = "top";
    g.fillStyle = color;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const field =
          Math.sin(x * 0.07 + t * 0.5) + Math.sin(y * 0.13 - t * 0.35) + Math.sin((x + y) * 0.04 + t * 0.2);
        const d = Math.hypot(x - mx, (y - my) * 1.8);
        const ripple = d < RIPPLE ? 0.3 * (1 - d / RIPPLE) * Math.sin(d * 0.6 - t * 5) : 0;
        const v = Math.min(1, Math.max(0, 0.28 + 0.11 * field + ripple + trail[i]));
        trail[i] *= 0.93;
        const level = Math.floor(v * (RAMP.length - 1));
        if (level === 0) continue;
        g.globalAlpha = 0.15 + 0.85 * v;
        g.fillText(RAMP[level], x * CELL_W, y * CELL_H);
      }
    }
    g.globalAlpha = 1;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BASE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "lighter";
    ctx.filter = "blur(6px)";
    ctx.drawImage(glyphs, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(glyphs, 0, 0);
  };

  // requestAnimationFrame already stops in hidden tabs.
  const loop = (now: number): void => {
    raf = win.requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    last = now;
    draw(now);
  };

  const start = (): void => {
    win.cancelAnimationFrame(raf);
    if (reduced.matches) draw(performance.now());
    else raf = win.requestAnimationFrame(loop);
  };

  const onMove = (event: PointerEvent): void => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    moved = true;
  };

  const apply = async (): Promise<void> => {
    const settings = await loadSettings(os);
    color = ACCENTS[settings.accent] ?? ACCENTS.blue;
    on = LIVE_WALLPAPERS.has(settings.wallpaper);
    canvas.hidden = !on;
    if (on) start();
    else win.cancelAnimationFrame(raf);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(root);
  doc.addEventListener("pointermove", onMove, { passive: true });
  reduced.addEventListener("change", () => on && start());
  resize();
  await apply();

  await os.process.onSignal("SIGHUP", () => void apply().catch(logError));
  await os.process.onSignal("SIGTERM", () => {
    win.cancelAnimationFrame(raf);
    observer.disconnect();
    doc.removeEventListener("pointermove", onMove);
    canvas.remove();
    void os.process.exit(0);
  });
}
