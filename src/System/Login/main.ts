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
import { paintAvatar as paintPicture } from "../../utils/settings";
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
 * Local users (guest, useradd; never root) are checked against /etc/shadow, in the
 * browser. Any other name is the owner: the backend checks the password and
 * sets a session cookie, and the owner becomes a local admin-group user.
 */
export async function main(os: SystemInterface): Promise<void> {
  await seedUsers(os);
  const root = await os.display.root();

  // Boot goes straight in: as the owner if still signed in to the backend,
  // else as guest. Other users log out first and pick themselves at the prompt.
  let user = (await ownerFromSession(os, root)) ?? userByName(await readUsers(os), "guest");
  for (;;) {
    user ??= await prompt(os, root);
    await runSession(os, user);
    if (user.gid === ADMIN_GID) await signOut(os, root);
    user = undefined;
  }
}

/**
 * Ends the backend session; returns only once the cookie is gone. Until then
 * nobody else may get a session in this browser: root is one `su` away for any
 * local user, and root may call the API with the owner's cookie.
 */
async function signOut(os: SystemInterface, root: HTMLElement): Promise<void> {
  for (;;) {
    const response = await os.api
      .fetch("/api/auth/logout", { method: "POST" })
      .catch(() => ({ status: 0 }));
    if (response.status === 204) return;
    await signOutFailed(root);
  }
}

/** Blocks on a "try again" screen; resolves when the user asks to retry. */
function signOutFailed(root: HTMLElement): Promise<void> {
  const screen = document.createElement("div");
  screen.className = "login";
  const panel = document.createElement("div");
  panel.className = "login-panel";
  const title = document.createElement("h1");
  title.className = "login-name";
  title.textContent = "Couldn't sign out";
  const detail = document.createElement("p");
  detail.className = "login-error";
  detail.setAttribute("role", "alert");
  detail.textContent = "Your session is still active. Check the connection and try again.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "login-user";
  retry.textContent = "Try again";
  panel.append(title, detail, retry);
  screen.append(panel);
  root.replaceChildren(screen);
  retry.focus();
  return new Promise((done) =>
    retry.addEventListener("click", () => {
      root.replaceChildren();
      done();
    }, { once: true }),
  );
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

async function ownerFromSession(os: SystemInterface, root: HTMLElement): Promise<User | undefined> {
  let username: string;
  try {
    const response = await os.api.fetch("/api/auth/me");
    if (response.status !== 200) return undefined;
    ({ username } = JSON.parse(response.body) as { username: string });
  } catch {
    return undefined; // no backend (offline, or plain `vite`): local users only
  }
  const owner = await ownerAccount(os, username);
  // A local non-admin account took the owner's name: don't fall back to guest
  // with the owner's cookie still live.
  if (!owner) await signOut(os, root);
  return owner;
}

/** Resolves with the user once their password checks out. */
async function login(os: SystemInterface, name: string, password: string): Promise<User> {
  const local = userByName(await readUsers(os), name);
  // Root has no desktop session; same message as a bad password, no hint it exists.
  if (local?.uid === 0) throw new Error("Wrong user name or password.");
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

/** Initial on a color right away, then the user's picture over it once read. */
function paintAvatar(os: SystemInterface, avatar: HTMLElement, user: User | undefined): void {
  avatar.style.background = "";
  const name = user?.name;
  if (user) void paintPicture(os, avatar, user.home).catch(() => {});
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
  const accounts = (await readUsers(os)).filter((user) => user.uid !== 0 && user.gid !== ADMIN_GID);
  const choices: (string | undefined)[] = accounts.map((user) => user.name);
  choices.push(undefined);
  const userOf = (choice: string | undefined) => accounts.find((user) => user.name === choice);

  const tiles: HTMLButtonElement[] = [];
  const select = (choice: string | undefined) => {
    paintAvatar(os, avatar, userOf(choice));
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
    paintAvatar(os, small, userOf(choice));
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
