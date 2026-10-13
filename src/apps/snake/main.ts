// snake — the classic: eat food, grow, don't hit a wall or yourself.
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";
import "../../ui/kit.css";
import "./snake.css";

const SHORT_SIDE = 18; // cells along the window's shorter side; the longer side gets as many as fit
const TICK_MS = 110;
const STATUS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="9.5" r="5.5" fill="#e5383b"/><path d="M8 4 9 1.5" stroke="#5b3a1e" stroke-width="1.2" fill="none"/><ellipse cx="10.5" cy="2.8" rx="2" ry="1" fill="#3fa34d"/></svg>`;

type Point = { x: number; y: number };

const KEYS: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 },
};

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Snake" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = `
    <div class="toolbar"><strong>Score <span data-field="score">0</span></strong>
      <span class="spacer"></span><span class="muted">Best <span data-field="best">0</span></span></div>
    <div class="board"><canvas></canvas>
      <div class="overlay"><strong data-field="title"></strong><span data-field="status"></span></div></div>`;

  const canvas = document.querySelector("canvas")!;
  const ctx = canvas.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const board = document.querySelector<HTMLElement>(".board")!;
  const overlay = document.querySelector<HTMLElement>(".overlay")!;
  let cell = 20; // px per grid square, recomputed whenever the window resizes
  let cols = SHORT_SIDE;
  let rows = SHORT_SIDE;

  const bestFile = `${(await os.process.env()).HOME ?? "/"}/.config/snake-best`;
  let best = parseInt(await os.fs.readTextFile(bestFile).catch(() => "0"), 10) || 0;

  let snake: Point[] = [];
  let dir: Point = { x: 1, y: 0 };
  let queue: Point[] = []; // ponytail: queued turns so quick double-taps don't get lost or reverse you
  let food: Point = { x: 0, y: 0 };
  let score = 0;
  let state: "ready" | "running" | "paused" | "over" = "ready";
  let timer: ReturnType<typeof setInterval> | undefined;

  const set = (field: string, text: string) => {
    document.querySelector(`[data-field="${field}"]`)!.textContent = text;
    if (field === "score")
      void os.display.updateStatusItem(statusItem, { label: text }).catch(() => {});
  };

  // Topbar icon with the live score; clicking it pauses/resumes and brings the window back.
  const statusItem = await os.display.addStatusItem(
    { icon: STATUS_ICON, title: "Snake", label: "0" },
    () => {
      void os.windows.focus(handle.id);
      if (state === "running" || state === "paused") togglePause();
    },
  );

  function placeFood(): void {
    const free: Point[] = [];
    for (let x = 0; x < cols; x++)
      for (let y = 0; y < rows; y++)
        if (!snake.some((p) => p.x === x && p.y === y)) free.push({ x, y });
    food = free[Math.floor(Math.random() * free.length)];
  }

  // ponytail: the grid's shape is fixed per game; resizing mid-game rescales it and leaves a hedge margin
  function fitGrid(): void {
    const { clientWidth: w, clientHeight: h } = board;
    const target = Math.min(w, h) / SHORT_SIDE;
    cols = Math.max(SHORT_SIDE, Math.floor(w / target));
    rows = Math.max(SHORT_SIDE, Math.floor(h / target));
  }

  function reset(): void {
    fitGrid();
    const x = Math.floor(cols / 2), y = Math.floor(rows / 2);
    snake = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
    dir = { x: 1, y: 0 };
    queue = [];
    score = 0;
    set("score", "0");
    placeFood();
    resize();
  }

  function show(title: string, status: string): void {
    set("title", title);
    set("status", status);
    overlay.hidden = false;
  }

  function draw(): void {
    ctx.fillStyle = "#8bd46a";
    ctx.fillRect(0, 0, cols * cell, rows * cell);
    ctx.fillStyle = "#7cc85c";
    for (let x = 0; x < cols; x++)
      for (let y = (x + 1) % 2; y < rows; y += 2) ctx.fillRect(x * cell, y * cell, cell, cell);

    drawApple(food.x * cell + cell / 2, food.y * cell + cell / 2);
    drawSnake();
  }

  function drawApple(cx: number, cy: number): void {
    const r = cell * 0.42;
    ctx.fillStyle = "rgba(0,0,0,.15)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.85, r * 0.8, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e5383b";
    ctx.strokeStyle = "#7a1416";
    ctx.lineWidth = cell * 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.05, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.38, cy - r * 0.3, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5b3a1e";
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.8);
    ctx.lineTo(cx + r * 0.1, cy - r * 1.2);
    ctx.stroke();
    ctx.fillStyle = "#3fa34d";
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.4, cy - r * 1.05, r * 0.35, r * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSnake(): void {
    const center = (p: Point) => [p.x * cell + cell / 2, p.y * cell + cell / 2] as const;
    const body = (width: number, style: string, dx = 0, dy = 0) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      for (const p of snake) {
        const [x, y] = center(p);
        ctx.lineTo(x + dx, y + dy);
      }
      ctx.stroke();
    };
    body(cell * 0.86, "rgba(0,0,0,.45)"); // outline
    body(cell * 0.7, color("--app-accent"));
    body(cell * 0.18, "rgba(255,255,255,.35)", -cell * 0.12, -cell * 0.12); // shine

    // head: eyes look where we're going
    const [hx, hy] = center(snake[0]);
    const side = { x: -dir.y, y: dir.x };
    for (const s of [-1, 1]) {
      const ex = hx + dir.x * cell * 0.12 + side.x * s * cell * 0.2;
      const ey = hy + dir.y * cell * 0.12 + side.y * s * cell * 0.2;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = cell * 0.05;
      ctx.beginPath();
      ctx.arc(ex, ey, cell * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc(ex + dir.x * cell * 0.06, ey + dir.y * cell * 0.06, cell * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    // rosy cheeks
    ctx.fillStyle = "rgba(255,120,150,.45)";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hx - dir.x * cell * 0.12 + side.x * s * cell * 0.28, hy - dir.y * cell * 0.12 + side.y * s * cell * 0.28, cell * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function resize(): void {
    const dpr = devicePixelRatio || 1;
    cell = Math.max(4, Math.min(board.clientWidth / cols, board.clientHeight / rows));
    canvas.style.width = `${cols * cell}px`;
    canvas.style.height = `${rows * cell}px`;
    canvas.width = Math.round(cols * cell * dpr);
    canvas.height = Math.round(rows * cell * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function step(): void {
    const next = queue.shift();
    if (next) dir = next;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const eating = head.x === food.x && head.y === food.y;
    const body = eating ? snake : snake.slice(0, -1); // the tail moves away this tick
    if (head.x < 0 || head.y < 0 || head.x >= cols || head.y >= rows ||
        body.some((p) => p.x === head.x && p.y === head.y)) return gameOver();
    snake = [head, ...body];
    if (eating) {
      set("score", String(++score));
      if (snake.length === cols * rows) return gameOver();
      placeFood();
    }
    draw();
  }

  function gameOver(): void {
    stop();
    state = "over";
    if (score > best) {
      best = score;
      set("best", String(best));
      void os.fs.writeTextFile(bestFile, String(best)).catch((error) => console.error("[snake]", error));
    }
    show("Game over", `You scored ${score}${score === best && score > 0 ? ", a new best!" : "."} Press Space to play again.`);
  }

  const start = () => { timer = setInterval(step, TICK_MS); };
  const stop = () => clearInterval(timer);

  function togglePause(): void {
    state = state === "running" ? "paused" : "running";
    if (state === "paused") {
      stop();
      show("Paused", "Press P or Space to resume.");
    } else {
      start();
      overlay.hidden = true;
    }
  }

  document.addEventListener("keydown", (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const turn = KEYS[key];
    if (turn && state === "running") {
      event.preventDefault();
      const last = queue.at(-1) ?? dir;
      if (queue.length < 3 && turn.x !== -last.x && turn.y !== -last.y) queue.push(turn);
    } else if (key === " ") {
      event.preventDefault();
      if (state === "running") return;
      if (state !== "paused") reset();
      state = "running";
      overlay.hidden = true;
      start();
    } else if (key === "p" && (state === "running" || state === "paused")) {
      togglePause();
    }
  });

  set("best", String(best));
  show("Snake", "Press Space to start. Steer with the arrow keys or WASD, P pauses.");
  reset();
  new ResizeObserver(() => (state === "ready" ? reset() : resize())).observe(board);
}
