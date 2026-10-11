// settings — edits ~/.config/settings.json, then SIGHUPs this user's desktop,
// taskbar and open apps so they re-read it.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ADMIN_GID, readGroups, readUsers, type User } from "../../bin/lib/users";
import {
  ACCENTS,
  applyAccent,
  clockFormat,
  CUSTOM_WALLPAPER,
  hasCustomWallpaper,
  loadSettings,
  saveCustomWallpaper,
  saveSettings,
  wallpaperCSS,
  WALLPAPERS,
  type Settings,
} from "../../utils/settings";
import settingsHTML from "./settings.html?raw";
import "../../ui/theme.css";
import "./settings.css";

// Each of these handles SIGHUP (desktop/taskbar directly, apps via followAccent);
// SIGHUP's default action kills, so only list processes that handle it.
const RELOAD_ON_HUP = [
  "/System/desktop",
  "/System/Taskbar",
  ...["admin", "code", "resume", "terminal"].map((id) => `/ProgramFiles/${id}`),
];
const DESKTOP = "/System/desktop";
const MAX_UPLOAD = 20 * 1024 * 1024;

/** `settings [tab]`, e.g. `settings account` opens on the Account tab. */
export async function main(os: AppInterface, args: string[] = []): Promise<void> {
  const handle = await os.windows.create({ title: "Settings" });
  void handle.onCloseRequest(() => void os.process.exit(0));

  const settings = await loadSettings(os);
  applyAccent(settings);
  document.body.innerHTML = settingsHTML;

  setUpTabs(args[0]);
  await bindForm(os, settings);
  await showAccount(os);
}

function fields(name: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-field="${name}"]`)];
}

/** Vertical tablist: click or arrow keys, roving tabindex. */
function setUpTabs(initial?: string): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement): void => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")!)!.hidden = !selected;
    }
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      select(target);
      target.focus();
    });
  });
  select(tabs.find((tab) => tab.id === `tab-${initial}`) ?? tabs[0]);
}

function wallpaperOption(name: string, background: string): HTMLLabelElement {
  const option = document.createElement("label");
  option.className = "wallpaper";
  option.innerHTML = `<input type="radio" name="wallpaper"><span class="wallpaper-thumb"></span><span></span>`;
  option.querySelector("input")!.value = name;
  option.querySelector<HTMLElement>(".wallpaper-thumb")!.style.background = background;
  option.querySelector("span:last-child")!.textContent = name;
  return option;
}

async function bindForm(os: AppInterface, settings: Settings): Promise<void> {
  const form = document.querySelector("form")!;

  const [wallpapers] = fields("wallpapers");
  for (const [name, background] of Object.entries(WALLPAPERS)) wallpapers.append(wallpaperOption(name, background));

  const custom = wallpaperOption(CUSTOM_WALLPAPER, "");
  custom.hidden = !(await hasCustomWallpaper(os));
  if (!custom.hidden) {
    custom.querySelector<HTMLElement>(".wallpaper-thumb")!.style.background = await wallpaperCSS(os, {
      ...settings,
      wallpaper: CUSTOM_WALLPAPER,
    });
  }
  wallpapers.append(custom);

  const upload = document.createElement("label");
  upload.className = "wallpaper wallpaper-upload";
  upload.innerHTML = `<input type="file" accept="image/*"><span class="wallpaper-thumb" aria-hidden="true">+</span><span>Upload</span>`;
  wallpapers.append(upload);
  upload.querySelector("input")!.addEventListener("change", (event) => {
    // Not a settings field: keep the form's change handler out of it until the file is stored.
    event.stopPropagation();
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return showStatus("Pick an image file.", true);
    if (file.size > MAX_UPLOAD) return showStatus("Pick an image under 20 MB.", true);
    void saveCustomWallpaper(os, file)
      .then(() => wallpaperCSS(os, { ...settings, wallpaper: CUSTOM_WALLPAPER }))
      .then((background) => {
        custom.querySelector<HTMLElement>(".wallpaper-thumb")!.style.background = background;
        custom.hidden = false;
        custom.querySelector("input")!.checked = true;
        form.dispatchEvent(new Event("change"));
      })
      .catch((error) => {
        console.error("[settings]", error);
        showStatus("Couldn't upload. Try again.", true);
      });
  });

  const [accents] = fields("accents");
  for (const [name, color] of Object.entries(ACCENTS)) {
    const swatch = Object.assign(document.createElement("input"), { type: "radio", name: "accent", value: name });
    swatch.setAttribute("aria-label", name);
    swatch.title = name[0].toUpperCase() + name.slice(1);
    swatch.style.setProperty("--swatch", color);
    accents.append(swatch);
  }

  const radio = (name: string) => form.elements.namedItem(name) as RadioNodeList;
  const check = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  radio("wallpaper").value = settings.wallpaper;
  radio("accent").value = settings.accent;
  radio("dateFormat").value = settings.dateFormat;
  radio("iconSize").value = settings.iconSize;
  check("clock24h").checked = settings.clock24h;
  check("clockSeconds").checked = settings.clockSeconds;

  const [preview] = fields("preview");
  const renderPreview = (): void => {
    preview.textContent = clockFormat(settings).format(new Date());
  };
  renderPreview();
  void os.timers.setInterval(renderPreview, 1000);

  form.addEventListener("change", () => {
    settings.wallpaper = radio("wallpaper").value;
    settings.accent = radio("accent").value;
    settings.dateFormat = radio("dateFormat").value as Settings["dateFormat"];
    settings.iconSize = radio("iconSize").value as Settings["iconSize"];
    settings.clock24h = check("clock24h").checked;
    settings.clockSeconds = check("clockSeconds").checked;
    applyAccent(settings);
    renderPreview();
    void apply(os, settings).then(
      () => showStatus("Saved"),
      (error) => {
        console.error("[settings]", error);
        showStatus("Couldn't save. Try again.", true);
      },
    );
  });
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false): void {
  const status = document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden]) .status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-error", isError);
  status.classList.add("is-shown");
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => status.classList.remove("is-shown"), 1200);
}

async function apply(os: AppInterface, settings: Settings): Promise<void> {
  await saveSettings(os, settings);
  const { uid } = await os.process.ids();
  for (const proc of await os.process.list()) {
    if (proc.uid === uid && proc.status === "running" && RELOAD_ON_HUP.includes(proc.path)) {
      await os.process.kill(proc.pid, "SIGHUP");
    }
  }
}

function roleOf(user: User): string {
  if (user.uid === 0) return "Root";
  if (user.gid === ADMIN_GID) return "Owner";
  if (user.name === "guest") return "Guest";
  return "Standard user";
}

async function showAccount(os: AppInterface): Promise<void> {
  const { uid } = await os.process.ids();
  const env = await os.process.env();
  const [users, groups] = await Promise.all([readUsers(os), readGroups(os).catch(() => [])]);
  const user = users.find((u) => u.uid === uid) ?? {
    name: env.USER ?? "user",
    uid,
    gid: uid,
    home: env.HOME ?? "/",
    shell: env.SHELL ?? "",
  };

  const set = (name: string, text: string): void => {
    for (const el of fields(name)) el.textContent = text;
  };
  set("avatar", user.name.slice(0, 1));
  set("name", user.name);
  set("role", roleOf(user));
  set("uid", String(user.uid));
  set("home", user.home);
  set("shell", user.shell || "none");
  set(
    "groups",
    groups
      .filter((g) => g.gid === user.gid || g.members.includes(user.name))
      .map((g) => g.name)
      .join(", ") || "none",
  );

  const terminal = document.querySelector<HTMLButtonElement>('[data-action="terminal"]')!;
  if (user.gid === ADMIN_GID) {
    set("password-hint", "Managed by your online account");
    terminal.hidden = true;
  } else {
    set("password-hint", "Change it with passwd in Terminal");
    terminal.addEventListener("click", () => void os.process.spawn("/ProgramFiles/terminal").catch(console.error));
  }

  // Two clicks: logging out closes every app, unsaved work included.
  const logout = document.querySelector<HTMLButtonElement>('[data-action="logout"]')!;
  let armed: ReturnType<typeof setTimeout> | undefined;
  logout.addEventListener("click", () => {
    if (!armed) {
      logout.textContent = "Click again to log out";
      armed = setTimeout(() => {
        logout.textContent = "Log out";
        armed = undefined;
      }, 3000);
      return;
    }
    logout.disabled = true;
    void os.process
      .list()
      .then((procs) => {
        const desktop = procs.find((p) => p.uid === uid && p.path === DESKTOP && p.status === "running");
        if (desktop) return os.process.kill(desktop.pid, "SIGTERM");
      })
      .catch((error) => {
        console.error("[settings]", error);
        logout.disabled = false;
      });
  });
}
