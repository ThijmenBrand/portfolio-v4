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

async function prompt(os: SystemInterface, root: HTMLElement): Promise<User> {
  const screen = htmlStringToTemplate(loginHTML);
  const form = selectElementFromTemplate<HTMLFormElement>(screen, '[data-field="form"]');
  const name = selectElementFromTemplate<HTMLInputElement>(screen, '[data-field="name"]');
  const password = selectElementFromTemplate<HTMLInputElement>(screen, '[data-field="password"]');
  const error = selectElementFromTemplate(screen, '[data-field="error"]');
  const users = selectElementFromTemplate(screen, '[data-field="users"]');
  const submit = selectElementFromTemplate<HTMLButtonElement>(screen, "button[type=submit]");

  // Shortcuts for local accounts; the owner types their name.
  const shadow = await readShadow(os);
  for (const user of await readUsers(os)) {
    if (user.uid === 0 || user.gid === ADMIN_GID) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "login-user";
    chip.textContent = user.name;
    chip.addEventListener("click", () => {
      name.value = user.name;
      password.value = "";
      // No password set: one click is enough.
      if (shadow.get(user.name) === "") form.requestSubmit();
      else password.focus();
    });
    users.appendChild(chip);
  }

  root.replaceChildren(screen);
  name.focus();

  return new Promise<User>((done) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      login(os, name.value.trim(), password.value)
        .then((user) => {
          root.replaceChildren();
          done(user);
        })
        .catch((failure: Error) => {
          error.textContent = failure.message;
          password.value = "";
          password.focus();
        })
        .finally(() => (submit.disabled = false));
    });
  });
}
