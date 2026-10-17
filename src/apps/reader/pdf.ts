import {
  AnnotationEditorType,
  getDocument,
  PDFDateString,
  type PageViewport,
  type PDFDocumentProxy,
  type RenderTask,
  RenderingCancelledException,
} from "pdfjs-dist";
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
const KEEP_PIXELS = 48e6; // page bitmaps kept around off screen, ~190 MB
const THUMB = 120; // CSS px width of a sidebar thumbnail
const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const INKS = [["Red", "#ff3b30"], ["Blue", "#0a6cff"], ["Green", "#1f9d55"], ["Black", "#1c1c1e"]] as const;
const SIZES = [["Fine", 1], ["Medium", 2], ["Thick", 4]] as const; // stroke width in PDF points

type Fit = "width" | "page";
type Point = [number, number]; // PDF user space, so ink and hits survive zoom and rotation
type Stroke = { color: string; width: number; points: Point[] };
type Hit = { page: number; from: Point; to: Point };
type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type Chapter = { row: HTMLElement; page: number; top: number | null; parent: Chapter | null; kids: HTMLElement | null };

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
  const [pages, outline, labels] = await Promise.all([
    Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1))),
    pdf.getOutline().catch(() => null),
    pdf.getPageLabels().catch(() => null),
  ]);

  let turn = 0;
  let pen = false;
  let color: string = INKS[0][1];
  let thickness: number = SIZES[1][1];
  let views: PageViewport[] = [];
  const ink: Stroke[][] = pages.map(() => []);
  const drawn: (number | Stroke[][])[] = []; // newest last, for undo: a stroke's page, or the ink a clear removed
  let hits: Hit[] = [];
  let current = -1;
  let query = "";
  let texts: TextItem[][] | null = null;
  let page = -1; // the one in view, mirrored in the sidebar
  let reading = 0; // where the reading line is in the scrolled pages, to pick the chapter
  let pinned: Chapter | null = null; // the chapter last clicked, current until the user scrolls
  let fit: Fit | null = "width"; // zoom follows the size of the view until zoomed by hand

  const scroller = el("div", "pages");
  scroller.tabIndex = -1; // focused, so Space, arrows and Page Up/Down scroll the pages
  const sheets = pages.map((_, i) => {
    // drawn: the scale and rotation the paper was rendered at, "" while it's blank
    const sheet = { box: el("div", "page"), paper: el("canvas", "paper"), overlay: el("canvas", "ink"), drawn: "" };
    sheet.box.append(sheet.paper, sheet.overlay);
    scroller.append(sheet.box);
    sheet.overlay.addEventListener("pointerdown", (e) => draw(i, e));
    return sheet;
  });

  // 100% zoom is the PDF's real size; open at "fit width" (capped at 150%) instead.
  const fitZoom = (mode: Fit): number => {
    const v = pages[0].getViewport({ scale: PT, rotation: (pages[0].rotate + turn * 90) % 360 });
    const wide = (scroller.clientWidth - 32) / v.width;
    const next = mode === "width" ? Math.min(1.5, wide) : Math.min(wide, (scroller.clientHeight - 32) / v.height);
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  };

  // ---- toolbar: sidebar and page | zoom | markup, search and info ----
  const bar = el("div", "bar");
  const button = (label: string, icon: string, action: () => void, className = ""): HTMLButtonElement => {
    const b = el("button", className);
    b.title = b.ariaLabel = label;
    b.innerHTML = icon;
    b.addEventListener("click", action);
    return b;
  };
  const group = (className: string, ...children: Node[]): HTMLElement => {
    const g = el("div", className);
    g.append(...children);
    return g;
  };
  const labelOf = (i: number): string => labels?.[i] || String(i + 1);

  const sideButton = button("Sidebar (S)", svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/>'), () =>
    toggleSide(),
  );

  const pageField = el("input");
  pageField.ariaLabel = "Page";
  pageField.title = "Go to page";
  pageField.inputMode = "numeric";
  pageField.style.width = `${Math.max(...pages.map((_, i) => labelOf(i).length)) + 1}ch`;
  pageField.addEventListener("focus", () => pageField.select());
  pageField.addEventListener("blur", () => (pageField.value = labelOf(page)));
  pageField.addEventListener("keydown", (e) => {
    if (e.key === "Escape") scroller.focus();
    if (e.key !== "Enter") return;
    const want = pageField.value.trim();
    const byLabel = pages.findIndex((_, i) => labelOf(i).toLowerCase() === want.toLowerCase());
    const i = byLabel >= 0 ? byLabel : Number(want) - 1;
    if (Number.isInteger(i) && pages[i]) (pinned = null), goTo(i);
    scroller.focus();
  });
  const pageCount = el("span", "of");
  pageCount.textContent = `of ${labels ? labelOf(pages.length - 1) : pages.length}`;

  const pct = el("button", "pct");
  pct.title = "Zoom and rotation";
  pct.ariaHasPopup = "menu";
  const viewMenu = el("div", "menu");
  viewMenu.popover = "auto";
  viewMenu.role = "menu";
  pct.popoverTargetElement = viewMenu;

  const penButton = button(
    "Markup (D)",
    svg('<path d="M10.5 3.5l2 2L6 12H4v-2z"/><path d="M9 5l2 2"/>') + "<span>Markup</span>",
    () => togglePen(),
    "labelled",
  );
  const saveButton = button("Save markup into the PDF (⌘S)", "Save", () => void save(), "save");
  const status = el("span", "status");
  status.role = "status";

  const find = el("input");
  find.type = "search";
  find.placeholder = "Search";
  find.ariaLabel = "Search document";
  const count = el("span", "count");
  const glass = el("span", "glass");
  glass.innerHTML = svg('<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>');
  const prevHit = button("Previous match (Shift+Enter)", svg('<path d="M4 10l4-4 4 4"/>'), () => step(-1));
  const nextHit = button("Next match (Enter)", svg('<path d="M4 6l4 4 4-4"/>'), () => step(1));

  bar.append(
    group("start", sideButton, group("field pageno", pageField, pageCount)),
    group(
      "middle",
      button("Zoom out (−)", svg('<path d="M4 8h8"/>'), () => setZoom(zoom / STEP)),
      pct,
      button("Zoom in (+)", svg('<path d="M4 8h8M8 4v8"/>'), () => setZoom(zoom * STEP)),
    ),
    group(
      "end",
      status,
      saveButton,
      penButton,
      group("field search", glass, find, count, prevHit, nextHit),
      button("File info (I)", svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5V11M8 5.2v.1"/>'), () => void showInfo()),
    ),
  );

  // The zoom menu: fits, presets, and rotation, with what's in effect ticked.
  function fillViewMenu(): void {
    const item = (label: string, keys: string, checked: boolean, action: () => void): HTMLButtonElement => {
      const b = el("button");
      b.role = "menuitemcheckbox";
      b.ariaChecked = String(checked);
      b.innerHTML = `${svg('<path d="M3.5 8.5l3 3 6-7"/>')}<span>${label}</span><kbd>${keys}</kbd>`;
      b.addEventListener("click", () => {
        viewMenu.hidePopover();
        action();
      });
      return b;
    };
    const exact = (z: number): boolean => !fit && Math.abs(zoom - z) < 0.005;
    viewMenu.replaceChildren(
      item("Fit width", "0", fit === "width", () => fitTo("width")),
      item("Fit page", "9", fit === "page", () => fitTo("page")),
      el("hr"),
      ...PRESETS.map((z) => item(`${z * 100}%`, z === 1 ? "1" : "", exact(z), () => setZoom(z))),
      el("hr"),
      item("Rotate left", "⇧R", false, () => rotate(-1)),
      item("Rotate right", "R", false, () => rotate(1)),
    );
  }
  viewMenu.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    fillViewMenu();
    const r = pct.getBoundingClientRect();
    viewMenu.style.top = `${r.bottom + 4}px`;
    viewMenu.style.left = `${r.left + r.width / 2}px`;
  });
  viewMenu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "open")
      (viewMenu.querySelector<HTMLElement>("[aria-checked=true]") ?? viewMenu.querySelector("button"))?.focus();
  });
  viewMenu.addEventListener("keydown", (e) => {
    const items = [...viewMenu.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });

  // ---- markup bar: shown while drawing ----
  const markup = el("div", "markup");
  markup.hidden = true;
  markup.ariaLabel = "Markup";
  const pick = (buttons: HTMLElement[], chosen: HTMLElement | null): void => {
    for (const b of buttons) b.ariaPressed = String(b === chosen);
  };
  const inks = INKS.map(([label, value]) => {
    const b = button(`${label} ink`, "", () => {
      color = value;
      pick([...inks, custom], b);
    }, "ink");
    b.style.setProperty("--ink", value);
    return b;
  });
  const custom = el("label", "ink custom");
  custom.title = "Other colour";
  const picker = el("input");
  picker.type = "color";
  picker.value = "#ff9500";
  picker.ariaLabel = "Other ink colour";
  picker.addEventListener("input", () => {
    color = picker.value;
    custom.style.setProperty("--ink", color);
    pick([...inks, custom], custom);
  });
  custom.append(picker);
  pick([...inks, custom], inks[0]);
  const sizes = SIZES.map(([label, width]) => {
    const b = button(`${label} line`, `<i style="--size: ${width * 2 + 1}px"></i>`, () => {
      thickness = width;
      pick(sizes, b);
    }, "size");
    return b;
  });
  pick(sizes, sizes[1]);
  const undoButton = button("Undo (⌘Z)", svg('<path d="M5 3L2.5 5.5 5 8"/><path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H7"/>'), undo);
  const clearButton = button("Clear all markup", svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>'), clearInk);
  const hint = el("span", "hint");
  hint.textContent = "Draw on the page";
  markup.append(
    group("swatches", ...inks, custom),
    el("span", "sep"),
    group("swatches", ...sizes),
    el("span", "sep"),
    undoButton,
    clearButton,
    hint,
    el("span", "spacer"),
    button("Done (Esc)", "Done", () => togglePen(), "done"),
  );

  /** Enables what there's something to do for. */
  function sync(): void {
    undoButton.disabled = !drawn.length;
    clearButton.disabled = !ink.some((strokes) => strokes.length);
    saveButton.hidden = !dirty;
    prevHit.disabled = nextHit.disabled = hits.length < 2;
  }

  // ---- sidebar: page thumbnails and the PDF's outline ----
  const side = el("aside", "side");
  const thumbList = el("div", "thumbs");
  const thumbs = pages.map((_, i) => {
    const thumb = { button: el("button", "thumb"), frame: el("div", "frame"), turn: -1 }; // turn it was drawn at
    const label = el("span");
    label.textContent = labels?.[i] || String(i + 1);
    thumb.button.ariaLabel = `Page ${label.textContent}`;
    thumb.button.append(thumb.frame, label);
    thumb.button.addEventListener("click", () => {
      pinned = null;
      goTo(i);
    });
    thumbList.append(thumb.button);
    return thumb;
  });

  const chapters: Chapter[] = [];
  const outlineList = el("div", "outline");
  if (outline?.length) {
    const tabs = el("div", "tabs");
    tabs.role = "tablist";
    const tab = (label: string, panel: HTMLElement): HTMLButtonElement => {
      const b = el("button");
      b.role = "tab";
      b.textContent = label;
      b.addEventListener("click", () => {
        for (const t of tabs.children) t.ariaSelected = String(t === b);
        thumbList.hidden = panel !== thumbList;
        outlineList.hidden = panel !== outlineList;
        follow();
      });
      tabs.append(b);
      return b;
    };
    const contents = tab("Contents", outlineList);
    tab("Pages", thumbList);
    side.append(tabs, outlineList, thumbList);
    addChapters(outline, outlineList, 0, null);
    contents.click();
  } else side.append(thumbList);

  const view = el("div", "view");
  view.append(side, scroller);
  document.body.classList.add("pdf");
  document.body.replaceChildren(bar, markup, view, viewMenu);
  side.hidden = innerWidth < 640; // a narrow window is better spent on the page
  sideButton.ariaPressed = String(!side.hidden);
  let zoom = fitZoom("width");

  // ---- zoom, rotate, render ----
  // While zooming, the bitmaps stretch to the new size; sharp ones replace them once zooming settles.
  let settling: ReturnType<typeof setTimeout> | undefined;
  function layout(): void {
    views = pages.map((p) => p.getViewport({ scale: zoom * PT, rotation: (p.rotate + turn * 90) % 360 }));
    sheets.forEach((s, i) => {
      s.box.style.width = `${views[i].width}px`;
      s.box.style.height = `${views[i].height}px`;
    });
    pct.innerHTML = `<span>${Math.round(zoom * 100)}%</span>${svg('<path d="M5.5 7l2.5 2.5L10.5 7"/>')}`;
    task?.cancel(); // drawing at the old size
  }

  function settle(): void {
    settling = undefined;
    sheets.forEach((_, i) => paint(i));
    void renderNear();
  }

  /** The resolution page i should be drawn at now, as a key and a viewport. */
  function target(i: number): { key: string; viewport: PageViewport } {
    const { rotation } = views[i];
    const base = pages[i].getViewport({ scale: 1, rotation });
    const scale = Math.min(zoom * PT * (devicePixelRatio || 1), Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    return { key: `${scale}/${rotation}`, viewport: pages[i].getViewport({ scale, rotation }) };
  }

  // Only the pages within a screen of the view are drawn, closest first; scrolling draws the next ones.
  const distance = (i: number): number => {
    const { offsetTop, offsetHeight } = sheets[i].box;
    const top = scroller.scrollTop;
    return Math.max(0, offsetTop - (top + scroller.clientHeight), top - (offsetTop + offsetHeight));
  };
  const nextBlurry = (): number | undefined =>
    sheets
      .map((_, i) => i)
      .filter((i) => distance(i) <= scroller.clientHeight && sheets[i].drawn !== target(i).key)
      .sort((a, b) => distance(a) - distance(b) || Math.abs(a - page) - Math.abs(b - page))[0];

  let task: RenderTask | null = null;
  let rendering = false;
  async function renderNear(): Promise<void> {
    if (rendering) return; // the running loop picks up the change
    rendering = true;
    for (let i; !settling && (i = nextBlurry()) !== undefined; ) {
      const { key, viewport } = target(i);
      const canvas = el("canvas", "paper");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = pages[i].render({ canvas, viewport });
      try {
        await task.promise;
      } catch (error) {
        if (!(error instanceof RenderingCancelledException)) sheets[i].drawn = key; // a broken page keeps its old bitmap
        continue;
      }
      if (target(i).key !== key) continue; // zoomed or rotated meanwhile
      sheets[i].paper.replaceWith(canvas);
      sheets[i].paper = canvas;
      sheets[i].drawn = key;
      evict();
    }
    task = null;
    rendering = false;
  }

  // Far pages give their bitmaps back, farthest first, so a long PDF doesn't hold every page at every zoom.
  function evict(): void {
    const pixels = (i: number): number => sheets[i].paper.width * sheets[i].paper.height;
    let total = sheets.reduce((sum, _, i) => sum + pixels(i), 0);
    const far = sheets
      .map((_, i) => i)
      .filter((i) => pixels(i) && distance(i) > scroller.clientHeight)
      .sort((a, b) => distance(b) - distance(a));
    for (const i of far) {
      if (total <= KEEP_PIXELS) break;
      total -= pixels(i);
      sheets[i].paper.width = sheets[i].paper.height = 0;
      sheets[i].drawn = "";
    }
  }

  function fitTo(mode: Fit): void {
    setZoom(fitZoom(mode));
    fit = mode;
    if (mode === "page" && page >= 0) goTo(page);
  }

  /** Zooms keeping the spot at (x, y) in the view, the middle by default, on the same spot of its page. */
  function setZoom(next: number, x = scroller.clientWidth / 2, y = scroller.clientHeight / 2): void {
    fit = null;
    next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (next === zoom) return;
    const at = pageAt(scroller.scrollTop + y);
    const box = sheets[at].box;
    const fx = (scroller.scrollLeft + x - box.offsetLeft) / views[at].width;
    const fy = (scroller.scrollTop + y - box.offsetTop) / views[at].height;
    zoom = next;
    layout();
    scroller.scrollLeft = box.offsetLeft + fx * views[at].width - x;
    scroller.scrollTop = box.offsetTop + fy * views[at].height - y;
    clearTimeout(settling);
    settling = setTimeout(settle, 150);
  }

  function rotate(dir: number): void {
    turn = (turn + dir + 4) % 4;
    if (fit) zoom = fitZoom(fit);
    layout();
    shapeThumbs();
    if (page >= 0) goTo(page);
    clearTimeout(settling);
    settle();
    void drawThumbs();
  }

  // Opening the sidebar or resizing the window keeps "fit width" or "fit page" fitting.
  new ResizeObserver(() => {
    if (fit && Math.abs(fitZoom(fit) - zoom) > 0.005) fitTo(fit);
  }).observe(scroller);

  // A pinch sends many events a frame: they're added up and applied once per frame, around the pointer.
  let pinch: { factor: number; x: number; y: number } | null = null;
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls; pinch arrives as ctrl+wheel
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      if (!pinch)
        requestAnimationFrame(() => {
          const { factor, x, y } = pinch!;
          pinch = null;
          setZoom(zoom * factor, x, y);
        });
      // A mouse wheel notch is ~100: capped, so ctrl+wheel steps rather than leaps.
      const delta = Math.max(-25, Math.min(25, e.deltaY));
      pinch = { factor: (pinch?.factor ?? 1) * Math.exp(-delta * 0.01), x: e.clientX - r.left, y: e.clientY - r.top };
    },
    { passive: false },
  );

  // ---- sidebar ----
  function toggleSide(): void {
    side.hidden = !side.hidden;
    sideButton.ariaPressed = String(!side.hidden);
    follow();
  }

  /** Where a PDF-space height on page i (from an outline entry; null for its top) is in the scrolled pages. */
  function offsetOf(i: number, top: number | null): number {
    const v = views[i];
    const y = top === null || v.rotation % 180 ? 0 : Math.max(0, v.convertToViewportPoint(0, top)[1]); // sideways, top is a left
    return sheets[i].box.offsetTop + y;
  }

  function goTo(i: number, top: number | null = null): void {
    scroller.scrollTo({ top: offsetOf(i, top) - 16 });
    page = i; // at once, before the scroll is tracked, so pressing → twice turns two pages
  }

  function addChapters(items: OutlineNode[], into: HTMLElement, depth: number, parent: Chapter | null): void {
    for (const item of items) {
      const row = el("div", "row");
      row.style.paddingLeft = `${depth * 12}px`;
      const title = el("button", "title");
      title.textContent = title.title = item.title;
      if (item.bold) title.style.fontWeight = "600";
      if (item.italic) title.style.fontStyle = "italic";
      const chapter: Chapter = { row, page: -1, top: null, parent, kids: null };
      chapters.push(chapter);
      if (item.items.length) {
        const kids = (chapter.kids = el("div"));
        kids.hidden = !((item.count ?? 0) > 0); // the PDF says which entries start open
        const twisty = el("button", "twisty");
        twisty.ariaLabel = "Show subsections";
        twisty.ariaExpanded = String(!kids.hidden);
        twisty.innerHTML = svg('<path d="M6 4l4 4-4 4"/>');
        twisty.addEventListener("click", () => {
          kids.hidden = !kids.hidden;
          twisty.ariaExpanded = String(!kids.hidden);
          follow(false);
        });
        row.append(twisty);
        into.append(row, kids);
        addChapters(item.items, kids, depth + 1, chapter);
      } else {
        row.append(el("span", "twisty"));
        into.append(row);
      }
      row.append(title);
      const target = destination(item.dest);
      void target.then((t) => {
        if (!t) return void (title.disabled = true); // a web link or a broken entry
        chapter.page = t.page;
        chapter.top = t.top;
        follow(false);
      });
      title.addEventListener("click", () =>
        void target.then((t) => {
          if (!t) return;
          pinned = chapter;
          goTo(t.page, t.top);
          follow();
        }),
      );
    }
  }

  async function destination(dest: OutlineNode["dest"]): Promise<{ page: number; top: number | null } | null> {
    try {
      const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!d) return null;
      const [ref, kind, ...args] = d as [unknown, { name: string }, ...(number | null)[]];
      const page = Number.isInteger(ref) ? (ref as number) : await pdf.getPageIndex(ref as never);
      const top = kind?.name === "XYZ" ? args[1] : kind?.name === "FitH" || kind?.name === "FitBH" ? args[0] : null;
      return pages[page] ? { page, top: top ?? null } : null;
    } catch {
      return null;
    }
  }

  // Thumbnails draw lazily as they scroll into the sidebar, closest to the page in view first.
  const near = new Set<number>();
  const watcher = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = thumbs.findIndex((t) => t.button === e.target);
        if (e.isIntersecting) near.add(i);
        else near.delete(i);
      }
      void drawThumbs();
    },
    { root: thumbList, rootMargin: "400px 0px" },
  );
  for (const t of thumbs) watcher.observe(t.button);

  function shapeThumbs(): void {
    thumbs.forEach((t, i) => (t.frame.style.aspectRatio = `${views[i].width} / ${views[i].height}`));
  }

  let drawing = false;
  async function drawThumbs(): Promise<void> {
    if (drawing) return;
    drawing = true;
    const dpr = devicePixelRatio || 1;
    const next = (): number | undefined =>
      [...near].filter((n) => thumbs[n].turn !== turn).sort((a, b) => Math.abs(a - page) - Math.abs(b - page))[0];
    for (let i; (i = next()) !== undefined; ) {
      const at = turn;
      const rotation = views[i].rotation;
      const base = pages[i].getViewport({ scale: 1, rotation });
      const viewport = pages[i].getViewport({ scale: (THUMB * dpr) / base.width, rotation });
      const canvas = el("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      try {
        await pages[i].render({ canvas, viewport }).promise;
      } catch {
        thumbs[i].turn = at; // a broken page stays blank
        continue;
      }
      if (at !== turn) continue; // rotated meanwhile: drawn again next round
      thumbs[i].frame.replaceChildren(canvas);
      thumbs[i].turn = at;
    }
    drawing = false;
  }

  // The page in view is the one under the reading line, near the top of the window but sliding to the
  // bottom over the last screenful, so the chapters there can become current too.
  let tracking = 0;
  const unpin = (): void => void (pinned = null);
  for (const type of ["wheel", "pointerdown", "touchstart"]) scroller.addEventListener(type, unpin, { passive: true });
  addEventListener("keydown", unpin);
  scroller.addEventListener("scroll", () => {
    cancelAnimationFrame(tracking);
    tracking = requestAnimationFrame(() => {
      track();
      void renderNear();
    });
  });
  function pageAt(y: number): number {
    let i = 0;
    while (i < sheets.length - 1 && sheets[i + 1].box.offsetTop <= y) i++;
    return i;
  }

  function track(): void {
    const { scrollTop, clientHeight, scrollHeight } = scroller;
    const line = Math.min(clientHeight / 4, 96);
    const y = scrollTop + Math.max(line, clientHeight - (scrollHeight - clientHeight - scrollTop));
    page = pageAt(y);
    reading = y;
    if (document.activeElement !== pageField) pageField.value = labelOf(page);
    follow();
  }

  /** Marks the page in view, and the chapter it's in, in the sidebar; with reveal, scrolls them into sight. */
  function follow(reveal = true): void {
    for (const t of thumbList.querySelectorAll("[aria-current]")) t.removeAttribute("aria-current");
    for (const r of outlineList.querySelectorAll("[aria-current]")) r.removeAttribute("aria-current");
    if (page < 0) return;
    thumbs[page].button.ariaCurrent = "page";
    // The last chapter starting above the reading line; hidden in a closed parent, that parent.
    let chapter = pinned;
    if (!chapter) {
      let best = -Infinity;
      for (const c of chapters) {
        const at = c.page < 0 ? Infinity : offsetOf(c.page, c.top);
        if (at <= reading && at >= best) (chapter = c), (best = at);
      }
    }
    for (let up = chapter?.parent; up; up = up.parent) if (up.kids?.hidden) chapter = up;
    chapter?.row.setAttribute("aria-current", "true");
    if (side.hidden || !reveal) return;
    const shown = thumbList.hidden ? chapter?.row : thumbs[page].button;
    const list = thumbList.hidden ? outlineList : thumbList;
    if (!shown) return;
    if (shown.offsetTop < list.scrollTop) list.scrollTop = shown.offsetTop - 8;
    else if (shown.offsetTop + shown.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = shown.offsetTop + shown.offsetHeight - list.clientHeight + 8;
  }

  // ---- overlay: search highlights + ink ----
  function paint(i: number): void {
    const { overlay } = sheets[i];
    const v = views[i];
    // Only pages with something on them get a bitmap: one per page at every zoom adds up.
    const used = ink[i].length > 0 || hits.some((hit) => hit.page === i);
    const dpr = devicePixelRatio || 1;
    const [width, height] = used ? [Math.round(v.width * dpr), Math.round(v.height * dpr)] : [0, 0];
    if (overlay.width !== width || overlay.height !== height) [overlay.width, overlay.height] = [width, height];
    if (!used) return;
    const ctx = overlay.getContext("2d")!;
    ctx.setTransform(width / v.width, 0, 0, width / v.width, 0, 0);
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
    const stroke: Stroke = { color, width: thickness, points: [at(e)] };
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
    markup.hidden = !pen;
    document.body.classList.toggle("pen", pen);
  }

  function undo(): void {
    const last = drawn.pop();
    if (last === undefined) return;
    if (typeof last === "number") ink[last].pop();
    else last.forEach((strokes, i) => ink[i].push(...strokes)); // undo a clear
    changed();
    sheets.forEach((_, i) => paint(i));
  }

  // Undoable, so it doesn't ask first.
  function clearInk(): void {
    if (!ink.some((strokes) => strokes.length)) return;
    drawn.push(ink.map((strokes) => strokes.splice(0)));
    changed();
    sheets.forEach((_, i) => paint(i));
  }

  // ---- save ----
  let dirty = false;
  function changed(): void {
    if (!dirty) host.setTitle(`${name} •`);
    dirty = true;
    sync();
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
      sync();
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
  // Glyph widths aren't in the text content, so a match's share of its run is measured in a stand-in font.
  const ruler = el("canvas").getContext("2d")!;
  ruler.font = "100px serif";
  const share = (str: string, upto: number): number => ruler.measureText(str.slice(0, upto)).width / ruler.measureText(str).width;

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
          const [, , c, d, x, y] = item.transform;
          const height = Math.hypot(c, d);
          for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + q.length)) {
            const from = x + item.width * share(item.str, at);
            const to = x + item.width * share(item.str, at + q.length);
            hits.push({ page, from: [from, y - 0.25 * height], to: [to, y + 0.9 * height] });
          }
        }
      });
    }
    // Start from the page in view rather than the top of the document.
    const ahead = hits.findIndex((hit) => hit.page >= page);
    current = hits.length ? Math.max(0, ahead) : -1;
    sheets.forEach((_, i) => paint(i));
    reveal();
    sync();
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
    count.textContent = !query ? "" : hits.length ? `${current + 1} of ${hits.length}` : "No matches";
    count.classList.toggle("none", !!query && !hits.length);
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
    else if (e.key === "Escape") (find.value = ""), void search(""), scroller.focus();
    else return;
    e.preventDefault();
  });
  // Searches as you type, once typing pauses.
  let typing: ReturnType<typeof setTimeout> | undefined;
  find.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => find.value !== query && void search(find.value), find.value ? 250 : 0);
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
    if (e.target instanceof HTMLInputElement || document.querySelector("dialog[open], :popover-open")) return;
    // Left and right turn pages, unless they're needed to scroll a page wider than the view.
    const across = scroller.scrollWidth > scroller.clientWidth;
    if (mod && e.key.toLowerCase() === "z") undo();
    else if (mod || e.altKey) return;
    else if (e.key === "Escape" && pen) togglePen();
    else if (e.key === "ArrowLeft" && !across) (pinned = null), goTo(Math.max(0, page - 1));
    else if (e.key === "ArrowRight" && !across) (pinned = null), goTo(Math.min(pages.length - 1, page + 1));
    else if (e.key === "+" || e.key === "=") setZoom(zoom * STEP);
    else if (e.key === "-" || e.key === "_") setZoom(zoom / STEP);
    else if (e.key === "0") fitTo("width");
    else if (e.key === "9") fitTo("page");
    else if (e.key === "1") setZoom(1);
    else if (e.key.toLowerCase() === "s") toggleSide();
    else if (e.key.toLowerCase() === "r") rotate(e.shiftKey ? -1 : 1);
    else if (e.key.toLowerCase() === "d") togglePen();
    else if (e.key.toLowerCase() === "i") void showInfo();
    else return;
    e.preventDefault();
  });

  layout();
  shapeThumbs();
  sheets.forEach((_, i) => paint(i));
  track();
  sync();
  scroller.focus({ preventScroll: true });
  await renderNear();
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
