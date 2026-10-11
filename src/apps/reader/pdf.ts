import { AnnotationEditorType, getDocument, PDFDateString, type PageViewport, type RenderTask } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
// @ts-expect-error pdfjs-dist ships no types for the worker module
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs";
import { errorCode } from "../../bin/lib/input";
import { human } from "../../bin/lib/size";
import type { Bytes } from "../../kernel/types";

const PT = 96 / 72; // CSS px per PDF point at 100%
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const STEP = 1.25;
const MAX_PIXELS = 16e6; // Safari refuses bigger canvases

type Point = [number, number]; // PDF user space, so ink and hits survive zoom and rotation
type Stroke = { color: string; width: number; points: Point[] };
type Hit = { page: number; from: Point; to: Point };

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

export type Host = { write(bytes: Bytes): Promise<void>; setTitle(title: string): void };

export async function showPdf(data: Uint8Array, name: string, host: Host): Promise<void> {
  const size = data.byteLength; // read it first: getDocument detaches the buffer
  // ponytail: app realms have worker-src 'none', so pdf.js parses on the main thread and big
  // PDFs stall the UI; allow worker-src 'self' for app-host in vite.config.ts realmCsp() if that bites.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;
  const pdf = await getDocument({ data }).promise;
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));

  let turn = 0;
  let pen = false;
  let color = "#ff3b30";
  let views: PageViewport[] = [];
  const ink: Stroke[][] = pages.map(() => []);
  const drawn: number[] = []; // page of each stroke, newest last, for undo
  let hits: Hit[] = [];
  let current = -1;
  let query = "";
  let texts: TextItem[][] | null = null;

  const scroller = el("div", "pages");
  const sheets = pages.map((_, i) => {
    const sheet = { box: el("div", "page"), paper: el("canvas", "paper"), overlay: el("canvas", "ink") };
    sheet.box.append(sheet.paper, sheet.overlay);
    scroller.append(sheet.box);
    sheet.overlay.addEventListener("pointerdown", (e) => draw(i, e));
    return sheet;
  });

  // 100% zoom is the PDF's real size; open at "fit width" (capped at 150%) instead.
  const fitWidth = (): number => {
    const v = pages[0].getViewport({ scale: PT });
    return Math.min(1.5, (scroller.clientWidth - 32) / v.width);
  };

  // ---- toolbar ----
  const bar = el("div", "bar");
  const button = (label: string, icon: string, action: () => void): HTMLButtonElement => {
    const b = el("button");
    b.title = b.ariaLabel = label;
    b.innerHTML = icon;
    b.addEventListener("click", action);
    return b;
  };
  const pct = button("Fit width (0)", "", () => setZoom(fitWidth()));
  pct.className = "pct";
  const penButton = button("Draw (D)", svg('<path d="M10.5 3.5l2 2L6 12H4v-2z"/><path d="M9 5l2 2"/>'), () => togglePen());
  const swatch = el("input");
  swatch.type = "color";
  swatch.value = color;
  swatch.title = swatch.ariaLabel = "Ink colour";
  swatch.addEventListener("input", () => (color = swatch.value));
  const find = el("input", "find");
  find.type = "search";
  find.placeholder = "Search";
  find.ariaLabel = "Search document";
  const count = el("span", "count");
  const status = el("span", "status");
  status.role = "status";
  bar.append(
    button("Zoom out (−)", svg('<path d="M4 8h8"/>'), () => setZoom(zoom / STEP)),
    pct,
    button("Zoom in (+)", svg('<path d="M4 8h8M8 4v8"/>'), () => setZoom(zoom * STEP)),
    el("span", "sep"),
    button("Rotate left (Shift+R)", svg('<path d="M3 3v3.5h3.5"/><path d="M3.4 6.5a5 5 0 1 1 .6 4.5"/>'), () => rotate(-1)),
    button("Rotate right (R)", svg('<path d="M13 3v3.5H9.5"/><path d="M12.6 6.5a5 5 0 1 0-.6 4.5"/>'), () => rotate(1)),
    el("span", "sep"),
    penButton,
    swatch,
    button("Undo (⌘Z)", svg('<path d="M5 3L2.5 5.5 5 8"/><path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H7"/>'), undo),
    button("Clear drawing", svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>'), clearInk),
    button("Save drawing into the PDF (⌘S)", svg('<path d="M3 3h8l2 2v8H3z"/><path d="M5.5 3v3h4V3M5.5 13V9.5h5V13"/>'), () => void save()),
    status,
    el("span", "spacer"),
    find,
    count,
    button("Previous match (Shift+Enter)", svg('<path d="M4 10l4-4 4 4"/>'), () => step(-1)),
    button("Next match (Enter)", svg('<path d="M4 6l4 4 4-4"/>'), () => step(1)),
    el("span", "sep"),
    button("File info (I)", svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5V11M8 5.2v.1"/>'), () => void showInfo()),
  );

  document.body.classList.add("pdf");
  document.body.replaceChildren(bar, scroller);
  let zoom = fitWidth();

  // ---- zoom, rotate, render ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  function layout(): void {
    views = pages.map((p) => p.getViewport({ scale: zoom * PT, rotation: (p.rotate + turn * 90) % 360 }));
    const dpr = devicePixelRatio || 1;
    sheets.forEach((s, i) => {
      s.box.style.width = `${views[i].width}px`;
      s.box.style.height = `${views[i].height}px`;
      s.overlay.width = Math.round(views[i].width * dpr);
      s.overlay.height = Math.round(views[i].height * dpr);
      paint(i);
    });
    pct.textContent = `${Math.round(zoom * 100)}%`;
    // The old bitmaps stretch to the new size at once; sharp ones replace them when zooming settles.
    clearTimeout(timer);
    timer = setTimeout(() => void renderAll(), 150);
  }

  let generation = 0;
  let task: RenderTask | null = null;
  // ponytail: renders every page at every zoom; virtualise with an IntersectionObserver if long PDFs eat memory.
  async function renderAll(): Promise<void> {
    const mine = ++generation;
    task?.cancel();
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    const distance = (i: number): number => Math.abs(sheets[i].box.offsetTop + sheets[i].box.offsetHeight / 2 - middle);
    const order = sheets.map((_, i) => i).sort((a, b) => distance(a) - distance(b)); // visible pages first
    for (const i of order) {
      const base = pages[i].getViewport({ scale: 1, rotation: views[i].rotation });
      const scale = Math.min(zoom * PT * (devicePixelRatio || 1), Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const viewport = pages[i].getViewport({ scale, rotation: views[i].rotation });
      const canvas = el("canvas", "paper");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = pages[i].render({ canvas, viewport });
      try {
        await task.promise;
      } catch {
        if (mine !== generation) return; // cancelled by a newer zoom
        continue; // a broken page keeps its old bitmap
      }
      if (mine !== generation) return;
      sheets[i].paper.replaceWith(canvas);
      sheets[i].paper = canvas;
    }
  }

  function setZoom(next: number): void {
    next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    // Keep the centre of the view in place.
    const k = next / zoom;
    const cx = scroller.scrollLeft + scroller.clientWidth / 2;
    const cy = scroller.scrollTop + scroller.clientHeight / 2;
    zoom = next;
    layout();
    scroller.scrollLeft = cx * k - scroller.clientWidth / 2;
    scroller.scrollTop = cy * k - scroller.clientHeight / 2;
  }

  function rotate(dir: number): void {
    turn = (turn + dir + 4) % 4;
    layout();
  }

  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls; pinch arrives as ctrl+wheel
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01));
    },
    { passive: false },
  );

  // ---- overlay: search highlights + ink ----
  function paint(i: number): void {
    const { overlay } = sheets[i];
    const v = views[i];
    const ctx = overlay.getContext("2d")!;
    const dpr = overlay.width / v.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    hits.forEach((hit, n) => {
      if (hit.page !== i) return;
      const [x1, y1] = v.convertToViewportPoint(...hit.from);
      const [x2, y2] = v.convertToViewportPoint(...hit.to);
      ctx.fillStyle = n === current ? "rgba(255, 140, 0, 0.55)" : "rgba(255, 220, 0, 0.4)";
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    });
    ctx.lineCap = ctx.lineJoin = "round";
    for (const stroke of ink[i]) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * zoom * PT;
      ctx.beginPath();
      for (const [k, [x, y]] of stroke.points.entries()) {
        const [vx, vy] = v.convertToViewportPoint(x, y);
        if (k) ctx.lineTo(vx, vy);
        else ctx.moveTo(vx, vy), ctx.lineTo(vx, vy); // a tap still leaves a dot
      }
      ctx.stroke();
    }
  }

  function draw(i: number, e: PointerEvent): void {
    if (!pen || e.button !== 0) return;
    const overlay = sheets[i].overlay;
    overlay.setPointerCapture(e.pointerId);
    const at = (m: PointerEvent): Point => views[i].convertToPdfPoint(m.offsetX, m.offsetY) as Point;
    const stroke: Stroke = { color, width: 2, points: [at(e)] };
    ink[i].push(stroke);
    drawn.push(i);
    changed();
    paint(i);
    const move = (m: PointerEvent): void => {
      for (const c of m.getCoalescedEvents?.() ?? [m]) stroke.points.push(at(c));
      paint(i);
    };
    overlay.addEventListener("pointermove", move);
    overlay.addEventListener("pointerup", () => overlay.removeEventListener("pointermove", move), { once: true });
  }

  function togglePen(): void {
    pen = !pen;
    penButton.ariaPressed = String(pen);
    document.body.classList.toggle("pen", pen);
  }

  function undo(): void {
    const i = drawn.pop();
    if (i === undefined) return;
    ink[i].pop();
    changed();
    paint(i);
  }

  function clearInk(): void {
    if (!drawn.length) return;
    for (const strokes of ink) strokes.length = 0;
    drawn.length = 0;
    changed();
    sheets.forEach((_, i) => paint(i));
  }

  // ---- save ----
  let dirty = false;
  function changed(): void {
    if (!dirty) host.setTitle(`${name} •`);
    dirty = true;
  }

  // Every save starts from the file as it was opened plus all current strokes, so saving
  // twice doesn't duplicate ink, and undo before a re-save removes a stroke from the file.
  let saving = false;
  async function save(): Promise<void> {
    if (saving || !dirty) return;
    saving = true;
    const keys: string[] = [];
    ink.forEach((strokes, pageIndex) =>
      strokes.forEach((stroke, n) => {
        const key = `pdfjs_internal_editor_reader_${pageIndex}_${n}`; // pdf.js's prefix for new annotations
        keys.push(key);
        pdf.annotationStorage.setValue(key, inkAnnotation(stroke, pageIndex));
      }),
    );
    status.textContent = "Saving…";
    try {
      await host.write(new Uint8Array(await pdf.saveDocument()));
      dirty = false;
      host.setTitle(name);
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = `Couldn't save (${errorCode(error)})`;
    } finally {
      // Out again at once: pdf.js would also paint stored annotations onto the page canvas.
      for (const key of keys) pdf.annotationStorage.remove(key);
      saving = false;
      setTimeout(() => status.textContent === "Saved" && (status.textContent = ""), 2000);
    }
  }

  // ---- search ----
  async function search(next: string): Promise<void> {
    query = next;
    texts ??= await Promise.all(
      pages.map(async (p) => (await p.getTextContent()).items.filter((it): it is TextItem => "str" in it)),
    );
    hits = [];
    const q = query.toLowerCase();
    // ponytail: matches within one text run and assumes horizontal text; matches split across runs are missed.
    if (q) {
      texts.forEach((items, page) => {
        for (const item of items) {
          const s = item.str.toLowerCase();
          const per = item.width / item.str.length;
          const [, , c, d, x, y] = item.transform;
          const height = Math.hypot(c, d);
          for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + q.length)) {
            const left = x + per * at;
            hits.push({ page, from: [left, y - 0.25 * height], to: [left + per * q.length, y + 0.9 * height] });
          }
        }
      });
    }
    current = hits.length ? 0 : -1;
    sheets.forEach((_, i) => paint(i));
    reveal();
  }

  function step(dir: number): void {
    if (find.value !== query) return void search(find.value);
    if (!hits.length) return;
    const was = hits[current].page;
    current = (current + dir + hits.length) % hits.length;
    paint(was);
    paint(hits[current].page);
    reveal();
  }

  function reveal(): void {
    count.textContent = !query ? "" : hits.length ? `${current + 1}/${hits.length}` : "No matches";
    const hit = hits[current];
    if (!hit) return;
    const box = sheets[hit.page].box;
    const [x, y] = views[hit.page].convertToViewportPoint(...hit.from);
    scroller.scrollTo({
      left: box.offsetLeft + x - scroller.clientWidth / 2,
      top: box.offsetTop + y - scroller.clientHeight / 2,
      behavior: "smooth",
    });
  }

  find.addEventListener("keydown", (e) => {
    if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
    else if (e.key === "Escape") (find.value = ""), void search(""), find.blur();
    else return;
    e.preventDefault();
  });
  find.addEventListener("search", () => {
    if (!find.value) void search(""); // the field's clear button
  });

  // ---- file info ----
  async function showInfo(): Promise<void> {
    const { info } = (await pdf.getMetadata()) as { info: Record<string, unknown> };
    const text = (key: string): string => (typeof info[key] === "string" ? (info[key] as string).trim() : "");
    const date = (key: string): string => PDFDateString.toDateObject(text(key))?.toLocaleString() ?? "";
    const [x1, y1, x2, y2] = pages[0].view;
    const mm = (pt: number): number => Math.round((pt * 25.4) / 72);
    const rows: [string, string][] = [
      ["File", name],
      ["Size", `${human(size)}B`],
      ["Pages", String(pages.length)],
      ["Page size", `${mm(x2 - x1)} × ${mm(y2 - y1)} mm`],
      ["Title", text("Title")],
      ["Author", text("Author")],
      ["Subject", text("Subject")],
      ["Keywords", text("Keywords")],
      ["Created", date("CreationDate")],
      ["Modified", date("ModDate")],
      ["Creator", text("Creator")],
      ["Producer", text("Producer")],
      ["PDF version", text("PDFFormatVersion")],
    ];
    const dialog = el("dialog", "info");
    const list = el("dl");
    for (const [label, value] of rows) {
      if (!value) continue;
      const dt = el("dt");
      const dd = el("dd");
      dt.textContent = label;
      dd.textContent = value; // metadata is untrusted: text only
      list.append(dt, dd);
    }
    const close = el("button");
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    dialog.append(list, close);
    dialog.addEventListener("click", (e) => e.target === dialog && dialog.close()); // backdrop
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---- keys ----
  addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") return void (e.preventDefault(), find.focus(), find.select());
    if (mod && e.key.toLowerCase() === "s") return void (e.preventDefault(), save());
    if (e.target instanceof HTMLInputElement || document.querySelector("dialog[open]")) return;
    if (mod && e.key.toLowerCase() === "z") undo();
    else if (mod || e.altKey) return;
    else if (e.key === "+" || e.key === "=") setZoom(zoom * STEP);
    else if (e.key === "-" || e.key === "_") setZoom(zoom / STEP);
    else if (e.key === "0") setZoom(fitWidth());
    else if (e.key.toLowerCase() === "r") rotate(e.shiftKey ? -1 : 1);
    else if (e.key.toLowerCase() === "d") togglePen();
    else if (e.key.toLowerCase() === "i") void showInfo();
    else return;
    e.preventDefault();
  });

  layout();
  await renderAll();
}

/**
 * A stroke as pdf.js's internal ink-editor format (InkAnnotation.createNewDict in the worker).
 * ponytail: undocumented pdf.js shape, re-check on pdfjs-dist major bumps (the save self-check catches it).
 */
function inkAnnotation({ color, width, points }: Stroke, pageIndex: number) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = width;
  return {
    annotationType: AnnotationEditorType.INK,
    pageIndex,
    color: [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)),
    thickness: width,
    opacity: 1,
    rotation: 0, // points are already in unrotated page space
    rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
    paths: {
      // Appearance stream: 6 numbers per point, NaN control points meaning "straight line to x, y".
      lines: [points.flatMap(([x, y]) => [NaN, NaN, NaN, NaN, x, y])],
      points: [points.flat()], // the /InkList other viewers redraw from
    },
  };
}
