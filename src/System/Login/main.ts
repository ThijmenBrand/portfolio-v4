import {
  ADMIN_GID,
  addUser,
  readShadow,
  readUsers,
  seedUsers,
  sessionEnv,
  userByName,
  verifyPassword,
  type User,
} from "../../bin/lib/users";
import type { SystemInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import loginHTML from "./login.html?raw";
import "./login.css";
import "../../ui/theme.css";

/**
 * Runs as root, forever: pick a user, run their desktop until they log out,
 * end what their session left behind, repeat.
 *
 * Local users (guest, root, useradd) are checked against /etc/shadow, in the
 * browser. Any other name is the owner: the backend checks the password and
 * sets a session cookie, and the owner becomes a local admin-group user.
 */
export async function main(os: SystemInterface): Promise<void> {
  await seedUsers(os);
  const root = await os.display.root();

  // Boot goes straight in: as the owner if still signed in to the backend,
  // else as guest. Other users log out first and pick themselves at the prompt.
  let user = (await ownerFromSession(os)) ?? userByName(await readUsers(os), "guest");
  for (;;) {
    user ??= await prompt(os, root);
    await runSession(os, user);
    if (user.gid === ADMIN_GID) {
      await os.api.fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    }
    user = undefined;
  }
}

async function runSession(os: SystemInterface, user: User): Promise<void> {
  const desktop = await os.process.spawn("/System/desktop", [], {
    uid: user.uid,
    gid: user.gid,
    env: sessionEnv(user),
  });
  await os.process.wait(desktop);

  // Logging out ends the whole session, not only the desktop: its taskbar,
  // apps and shells were reparented to the kernel and are still running.
  for (const proc of await os.process.list()) {
    const mine = proc.uid === user.uid && proc.pid !== 0 && proc.pid !== os.process.pid;
    if (mine && (proc.status === "running" || proc.status === "loading")) {
      await os.process.kill(proc.pid, "SIGKILL").catch(() => {});
    }
  }
  // SIGKILL runs no handlers, so the taskbar's DOM (and an open session menu)
  // outlives it. Windows and struts the kernel frees; this layer is ours.
  (await os.display.taskbar()).replaceChildren();
}

/** The local account for the backend's user, made on first login. */
async function ownerAccount(os: SystemInterface, name: string): Promise<User | undefined> {
  const existing = userByName(await readUsers(os), name);
  if (existing) return existing.gid === ADMIN_GID ? existing : undefined;
  return addUser(os, name, ADMIN_GID);
}

async function ownerFromSession(os: SystemInterface): Promise<User | undefined> {
  try {
    const response = await os.api.fetch("/api/auth/me");
    if (response.status !== 200) return undefined;
    const { username } = JSON.parse(response.body) as { username: string };
    return await ownerAccount(os, username);
  } catch {
    return undefined; // no backend (offline, or plain `vite`): local users only
  }
}

/** Resolves with the user once their password checks out. */
async function login(os: SystemInterface, name: string, password: string): Promise<User> {
  const local = userByName(await readUsers(os), name);
  if (local && local.gid !== ADMIN_GID) {
    const entry = (await readShadow(os)).get(name) ?? "!";
    if (await verifyPassword(entry, password)) return local;
    throw new Error("Wrong user name or password.");
  }

  const response = await os.api
    .fetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: name, password }),
    })
    .catch(() => ({ status: 0, body: "" }));
  if (response.status === 204) {
    const owner = await ownerAccount(os, name);
    if (owner) return owner;
  }
  if (response.status === 429) throw new Error("Too many attempts. Try again later.");
  if (response.status >= 500) throw new Error("Login service unavailable.");
  throw new Error("Wrong user name or password.");
}

/** Shown for "Other user", where the owner types their name. */
const PERSON_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 20.5c.9-4.2 4.3-6.6 8.5-6.6s7.6 2.4 8.5 6.6z"/></svg>`;

/** A stable, muted color per name, so each account is recognisable. */
function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `oklch(0.55 0.08 ${Math.abs(hash) % 360})`;
}

function paintAvatar(avatar: HTMLElement, name: string | undefined): void {
  if (name) {
    avatar.textContent = name[0].toUpperCase();
    avatar.style.setProperty("--avatar", avatarColor(name));
  } else {
    avatar.innerHTML = PERSON_ICON;
    avatar.style.setProperty("--avatar", "rgba(255, 255, 255, 0.16)");
  }
}

function tick(date: HTMLElement, time: HTMLElement): void {
  const now = new Date();
  date.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  // Lock-screen style: "1:17", no AM/PM.
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .formatToParts(now)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

async function prompt(os: SystemInterface, root: HTMLElement): Promise<User> {
  const screen = htmlStringToTemplate(loginHTML);
  const field = <T extends HTMLElement = HTMLElement>(key: string) =>
    selectElementFromTemplate<T>(screen, `[data-field="${key}"]`);
  const form = field<HTMLFormElement>("form");
  const name = field<HTMLInputElement>("name");
  const password = field<HTMLInputElement>("password");
  const error = field("error");
  const users = field("users");
  const avatar = field("avatar");
  const title = field("title");
  const date = field("date");
  const time = field("time");
  const submit = selectElementFromTemplate<HTMLButtonElement>(screen, "button[type=submit]");
  const shell = form.parentElement!;

  tick(date, time);
  const clock = setInterval(() => tick(date, time), 1000);

  // Local accounts get a tile; the owner picks "Other user" and types their name.
  const shadow = await readShadow(os);
  const choices: (string | undefined)[] = (await readUsers(os))
    .filter((user) => user.uid !== 0 && user.gid !== ADMIN_GID)
    .map((user) => user.name);
  choices.push(undefined);

  const tiles: HTMLButtonElement[] = [];
  const select = (choice: string | undefined) => {
    paintAvatar(avatar, choice);
    title.textContent = choice ?? "Other user";
    name.hidden = choice !== undefined;
    name.value = choice ?? "";
    password.value = "";
    error.textContent = "";
    // No password set: one click on the arrow is enough.
    const open = choice !== undefined && shadow.get(choice) === "";
    form.classList.toggle("is-open", open);
    choices.forEach((other, i) => tiles[i].setAttribute("aria-pressed", String(other === choice)));
    (choice === undefined ? name : open ? submit : password).focus();
  };

  for (const choice of choices) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "login-user";
    const small = document.createElement("span");
    small.className = "login-avatar";
    paintAvatar(small, choice);
    tile.append(small, choice ?? "Other user");
    tile.addEventListener("click", () => select(choice));
    tiles.push(tile);
    users.appendChild(tile);
  }

  root.replaceChildren(screen);
  select(choices[0]);

  return new Promise<User>((done) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      form.classList.remove("is-wrong");
      login(os, name.value.trim(), password.value)
        .then(async (user) => {
          clearInterval(clock);
          shell.classList.add("is-leaving");
          await new Promise((resolve) => setTimeout(resolve, 260));
          root.replaceChildren();
          done(user);
        })
        .catch((failure: Error) => {
          error.textContent = failure.message;
          void form.offsetWidth; // restart the shake on repeat failures
          form.classList.add("is-wrong");
          password.value = "";
          password.focus();
        })
        .finally(() => (submit.disabled = false));
    });
  });
}
