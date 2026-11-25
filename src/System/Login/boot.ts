/**
 * The first-boot console: a fake Linux-style startup log, shown once on a
 * fresh install (first visit, or after a factory reset) while the system
 * seeds itself. Pure theatre, on purpose a bit long: the steps are made up,
 * the machine facts (cores, memory, storage, screen) are real.
 *
 * Any key or click finishes it early; reduced motion gets it near-instantly.
 */

type Step = [text: string, ms: number, status?: "ok" | "wait"];

async function machineFacts(): Promise<string[]> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const quota = await navigator.storage?.estimate?.().catch(() => undefined);
  const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
  return [
    `cpu: ${nav.hardwareConcurrency ?? 1} logical core(s)`,
    nav.deviceMemory ? `memory: ${nav.deviceMemory} GiB available` : "memory: size not reported, assuming enough",
    quota?.quota ? `storage: ${gib(quota.quota)} quota` : "storage: quota unknown",
    `display: ${screen.width}x${screen.height} @${window.devicePixelRatio}x`,
    `locale: ${navigator.language}, tz ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  ];
}

function script(facts: string[]): Step[] {
  return [
    ["portfolio-os bootloader 4.0", 350],
    ["no installed system found, starting first-time setup", 450],
    ...facts.map((fact): Step => [fact, 120]),
    ["", 250],
    ["Checking boot medium", 300, "ok"],
    ["Probing storage: origin private file system", 500, "ok"],
    ["Creating partition table", 350, "ok"],
    ["Formatting /home", 400, "ok"],
    ["Formatting /etc", 300, "ok"],
    ["Mounting /proc", 250, "ok"],
    ["Mounting /mnt/cloud (remote, requires sign-in)", 350, "ok"],
    ["Mounting /ProgramFiles and /System (read-only)", 300, "ok"],
    ["", 200],
    ["Starting kernel", 300, "ok"],
    ["Initializing process table", 250, "ok"],
    ["Initializing virtual file system", 350, "ok"],
    ["Initializing window manager", 300, "ok"],
    ["Initializing display compositor", 450, "ok"],
    ["Registering system calls (68)", 350, "ok"],
    ["Loading binary formats", 250, "ok"],
    ["Starting event bus", 200, "ok"],
    ["", 200],
    ["Creating user database", 400, "ok"],
    ["Adding group: root", 150, "ok"],
    ["Adding group: admin", 150, "ok"],
    ["Adding user: root", 200, "ok"],
    ["Adding user: guest", 200, "ok"],
    ["Hashing passwords (scrypt)", 600, "ok"],
    ["Creating home directories", 350, "ok"],
    ["Installing default settings", 400, "ok"],
    ["Installing wallpapers", 350, "ok"],
    ["Installing applications", 300, "wait"],
    ["    terminal  files  code  reader  calendar  projects  settings  resume  about", 500],
    ["Writing autostart", 300, "ok"],
    ["Indexing files for Spotlight", 550, "ok"],
    ["Starting network: same-origin only", 300, "ok"],
    ["Starting login manager", 500, "ok"],
    ["", 250],
    ["System installed. Welcome.", 700],
  ];
}

/** Resolves when the console has finished (or been skipped) and faded out. */
export async function bootConsole(root: HTMLElement): Promise<void> {
  const screen = document.createElement("div");
  screen.className = "boot";
  const log = document.createElement("pre");
  log.className = "boot-log";
  const cursor = document.createElement("span");
  cursor.className = "boot-cursor";
  screen.append(log);
  root.replaceChildren(screen);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let skip = reduced;
  const stop = () => (skip = true);
  addEventListener("keydown", stop, { once: true });
  screen.addEventListener("pointerdown", stop, { once: true });

  const wait = (ms: number) =>
    new Promise<void>((done) => setTimeout(done, skip ? 0 : ms));
  const append = (line: string) => {
    log.append(line + "\n", cursor);
    screen.scrollTop = screen.scrollHeight;
  };

  for (const [text, ms, status] of await machineFacts().then(script)) {
    if (!text) {
      append("");
      await wait(ms);
      continue;
    }
    if (status) {
      const row = document.createElement("span");
      const tag = document.createElement("span");
      tag.className = "boot-tag";
      tag.textContent = status === "ok" ? "[  OK  ] " : "[ .... ] ";
      row.append(tag, text + "\n");
      log.append(row, cursor);
    } else {
      append(text);
    }
    await wait(ms * (0.6 + Math.random() * 0.8));
  }

  removeEventListener("keydown", stop);
  screen.classList.add("is-leaving");
  await new Promise<void>((done) => setTimeout(done, skip ? 0 : 450));
  root.replaceChildren();
}

const SPLASH_FLAG = "portfolio.splash";

/** Set just before a reboot's reload, so the next load shows the splash (a plain reload doesn't). */
export function markReboot(): void {
  try {
    sessionStorage.setItem(SPLASH_FLAG, "1");
  } catch {
    // storage blocked: the reboot just has no splash
  }
}

/** True once per marked reboot. */
export function takeRebootMark(): boolean {
  try {
    const marked = sessionStorage.getItem(SPLASH_FLAG) === "1";
    sessionStorage.removeItem(SPLASH_FLAG);
    return marked;
  } catch {
    return false;
  }
}

/** The short boot screen after a reboot, like a Mac's logo and progress bar. */
export async function splashScreen(root: HTMLElement): Promise<void> {
  const screen = document.createElement("div");
  screen.className = "splash";
  const mark = document.createElement("div");
  mark.className = "splash-mark";
  mark.textContent = "Thijmen Brand";
  const bar = document.createElement("div");
  bar.className = "splash-bar";
  bar.append(document.createElement("span"));
  screen.append(mark, bar);
  root.replaceChildren(screen);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  await new Promise<void>((done) => setTimeout(done, reduced ? 300 : 2600));
  screen.classList.add("is-leaving");
  await new Promise<void>((done) => setTimeout(done, reduced ? 0 : 450));
  root.replaceChildren();
}
