// aliases — the owner's SimpleLogin aliases: switch them on/off, see and block
// the contacts that mail them. The server proxies SimpleLogin (server/simplelogin.ts)
// so the API key never reaches the browser.
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import aliasesHTML from "./aliases.html?raw";
import "../../ui/theme.css";
import "./aliases.css";

interface Alias {
  id: number;
  email: string;
  enabled: boolean;
  name: string | null;
  note: string | null;
  pinned: boolean;
  nb_forward: number;
  nb_block: number;
  nb_reply: number;
  creation_timestamp: number;
  mailboxes?: { email: string }[];
  latest_activity: { action: string; timestamp: number; contact: { email: string } } | null;
}

interface Contact {
  id: number;
  contact: string;
  last_email_sent_timestamp: number | null;
  reverse_alias_address: string;
  block_forward: boolean;
}

const PAGE = 20; // SimpleLogin's fixed page size
const NARROW = matchMedia("(max-width: 560px)"); // keep in sync with aliases.css
const ACTIONS: Record<string, string> = {
  forward: "Forwarded from",
  block: "Blocked from",
  reply: "Replied to",
  bounced: "Bounced from",
};
const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>';
const PIN_ICON = '<svg class="pin" viewBox="0 0 16 16" aria-label="Pinned" role="img"><path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14"/></svg>';

let os: AppInterface;
let aliases: Alias[] = [];
let page = 0;
let hasMore = false;
let listSeq = 0;
let query = "";
let filter = "";
let selected: Alias | null = null;
let contactPage = 0;
let contactSeq = 0;
let contactCount = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const rows = new Map<number, HTMLLIElement>();

export async function main(appOs: AppInterface): Promise<void> {
  os = appOs;
  await followAccent(os);
  const handle = await os.windows.create({ title: "Aliases" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = aliasesHTML;
  bind();
  void loadAliases(true);
}

// ------------------------------------------------------------------ api --

async function api<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  let response;
  try {
    response = await os.api.fetch(`/api/private/sl${path}`, method === "POST" ? { method, body: "{}" } : undefined);
  } catch {
    throw new Error("Can't reach the server. Is the API running?");
  }
  let body: { error?: string } | undefined;
  try {
    body = JSON.parse(response.body) as { error?: string };
  } catch {}
  if (response.status === 401) throw new Error("You're signed out. Log in as the owner to use Aliases.");
  if (response.status >= 400) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

// --------------------------------------------------------------- aliases --

async function loadAliases(reset: boolean): Promise<void> {
  const seq = ++listSeq;
  const list = field("list");
  if (reset) {
    aliases = [];
    page = 0;
    rows.clear();
    list.replaceChildren(...skeletons(8));
    setState("list", null);
    field("more").hidden = true;
    field("count").textContent = "";
  }
  field<HTMLButtonElement>("more").disabled = true;

  const params = new URLSearchParams({ page: String(page) });
  if (query) params.set("q", query);
  if (filter) params.set("filter", filter);
  try {
    const { aliases: batch } = await api<{ aliases: Alias[] }>(`/aliases?${params}`);
    if (seq !== listSeq) return; // a newer search or filter won
    if (reset) list.replaceChildren();
    aliases.push(...batch);
    page++;
    hasMore = batch.length === PAGE;
    for (const alias of batch) list.append(aliasRow(alias));
    field("more").hidden = !hasMore;
    field<HTMLButtonElement>("more").disabled = false;
    field("count").textContent = aliases.length ? `${aliases.length}${hasMore ? "+" : ""} aliases` : "";
    if (!aliases.length) {
      setState("list", query ? `No aliases match “${query}”.` : filter ? "Nothing here with this filter." : "No aliases yet.");
    }
  } catch (error) {
    if (seq !== listSeq) return;
    if (reset) list.replaceChildren();
    field<HTMLButtonElement>("more").disabled = false;
    if (reset) setState("list", (error as Error).message, () => void loadAliases(true));
    else toast((error as Error).message, true);
  }
}

function aliasRow(alias: Alias): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "alias";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "alias-main";
  main.addEventListener("click", () => select(alias));
  const top = document.createElement("span");
  top.className = "alias-top";
  if (alias.pinned) top.insertAdjacentHTML("beforeend", PIN_ICON);
  top.append(address(alias.email));
  const sub = document.createElement("span");
  sub.className = "alias-sub";
  main.append(top, sub);

  const toggle = switchInput(`Forward mail sent to ${alias.email}`);
  toggle.addEventListener("change", () => void toggleAlias(alias));

  li.append(main, toggle);
  rows.set(alias.id, li);
  syncRow(alias);
  return li;
}

function syncRow(alias: Alias): void {
  const li = rows.get(alias.id);
  if (!li) return;
  li.classList.toggle("is-off", !alias.enabled);
  li.classList.toggle("is-selected", selected?.id === alias.id);
  const main = li.querySelector<HTMLButtonElement>(".alias-main")!;
  if (selected?.id === alias.id) main.setAttribute("aria-current", "true");
  else main.removeAttribute("aria-current");
  li.querySelector<HTMLInputElement>("input")!.checked = alias.enabled;

  const sub = li.querySelector<HTMLElement>(".alias-sub")!;
  const activity = alias.latest_activity;
  if (alias.note || alias.name) {
    sub.textContent = alias.note || alias.name;
    sub.removeAttribute("title");
  } else if (activity) {
    sub.textContent = `${ACTIONS[activity.action] ?? "Activity with"} ${activity.contact.email} · ${ago(activity.timestamp)}`;
    sub.title = new Date(activity.timestamp * 1000).toLocaleString();
  } else {
    sub.textContent = "No mail yet";
  }
}

async function toggleAlias(alias: Alias): Promise<void> {
  alias.enabled = !alias.enabled; // optimistic; the server answers with the truth
  sync(alias);
  try {
    alias.enabled = (await api<{ enabled: boolean }>(`/aliases/${alias.id}/toggle`, "POST")).enabled;
  } catch (error) {
    alias.enabled = !alias.enabled;
    toast(`Couldn't switch ${alias.email}: ${(error as Error).message}`, true);
  }
  sync(alias);
}

function sync(alias: Alias): void {
  syncRow(alias);
  if (selected?.id === alias.id) syncDetail();
}

// ---------------------------------------------------------------- detail --

function select(alias: Alias): void {
  const previous = selected;
  selected = alias;
  if (previous) syncRow(previous);
  syncRow(alias);
  field("app").dataset.view = "detail";
  field("detail-empty").hidden = true;
  const body = field("detail-body");
  body.hidden = false;
  body.classList.remove("is-entering");
  void body.offsetWidth; // restart the entrance
  body.classList.add("is-entering");
  body.parentElement!.scrollTop = 0;
  syncDetail();
  void loadContacts(true);
}

function syncDetail(): void {
  const alias = selected;
  if (!alias) return;
  const email = field("d-email");
  email.replaceChildren(address(alias.email));
  if (alias.pinned) email.insertAdjacentHTML("afterbegin", PIN_ICON);
  const note = field("d-note");
  note.textContent = [alias.name, alias.note].filter(Boolean).join(" — ");
  note.hidden = !note.textContent;

  field("d-state").textContent = alias.enabled ? "Forwarding" : "Off";
  const toggle = field<HTMLInputElement>("d-toggle");
  toggle.checked = alias.enabled;
  toggle.setAttribute("aria-label", `Forward mail sent to ${alias.email}`);
  field("app").querySelector(".detail-head")!.classList.toggle("is-off", !alias.enabled);

  field("d-fwd").textContent = alias.nb_forward.toLocaleString();
  field("d-blk").textContent = alias.nb_block.toLocaleString();
  field("d-rep").textContent = alias.nb_reply.toLocaleString();
  const created = field<HTMLTimeElement>("d-created");
  const date = new Date(alias.creation_timestamp * 1000);
  created.textContent = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  created.dateTime = date.toISOString();
  field("d-mailbox").textContent = alias.mailboxes?.map((m) => m.email).join(", ") ?? "";
}

async function loadContacts(reset: boolean): Promise<void> {
  const alias = selected;
  if (!alias) return;
  const seq = ++contactSeq;
  const list = field("contacts");
  if (reset) {
    contactPage = 0;
    contactCount = 0;
    list.replaceChildren(...skeletons(3));
    setState("contacts", null);
    field("contacts-more").hidden = true;
  }
  field<HTMLButtonElement>("contacts-more").disabled = true;
  try {
    const { contacts } = await api<{ contacts: Contact[] }>(`/aliases/${alias.id}/contacts?page=${contactPage}`);
    if (seq !== contactSeq) return; // another alias was selected meanwhile
    if (reset) list.replaceChildren();
    contactPage++;
    contactCount += contacts.length;
    for (const contact of contacts) list.append(contactRow(contact));
    field("contacts-more").hidden = contacts.length !== PAGE;
    field<HTMLButtonElement>("contacts-more").disabled = false;
    if (!contactCount) setState("contacts", "No one has emailed this alias yet.");
  } catch (error) {
    if (seq !== contactSeq) return;
    if (reset) list.replaceChildren();
    field<HTMLButtonElement>("contacts-more").disabled = false;
    if (reset) setState("contacts", (error as Error).message, () => void loadContacts(true));
    else toast((error as Error).message, true);
  }
}

function contactRow(contact: Contact): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "contact";

  const info = document.createElement("div");
  info.className = "contact-info";
  const email = document.createElement("span");
  email.className = "contact-email";
  email.textContent = contact.contact;
  email.title = contact.contact;
  const meta = document.createElement("span");
  meta.className = "contact-meta";
  const reverse = document.createElement("span");
  reverse.className = "reverse";
  const code = document.createElement("code");
  code.textContent = contact.reverse_alias_address;
  code.title = `Reply to ${contact.contact} from your alias by mailing ${contact.reverse_alias_address}`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-button";
  copy.innerHTML = COPY_ICON;
  copy.setAttribute("aria-label", `Copy reverse-alias for ${contact.contact}`);
  copy.title = "Copy reverse-alias";
  copy.addEventListener("click", () => void copyText(contact.reverse_alias_address, code));
  reverse.append(code, copy);
  info.append(email, meta, reverse);

  const toggle = switchInput(`Forward mail from ${contact.contact}`);
  toggle.addEventListener("change", () => void toggleContact(contact, li));

  li.append(info, toggle);
  syncContact(contact, li);
  return li;
}

function syncContact(contact: Contact, li: HTMLLIElement): void {
  li.classList.toggle("is-blocked", contact.block_forward);
  li.querySelector<HTMLInputElement>("input")!.checked = !contact.block_forward;
  const meta = li.querySelector<HTMLElement>(".contact-meta")!;
  const last = contact.last_email_sent_timestamp;
  const when = last ? `Last mail ${ago(last)}` : "No mail yet";
  meta.textContent = contact.block_forward ? `Blocked · ${when}` : when;
  meta.title = last ? new Date(last * 1000).toLocaleString() : "";
}

async function toggleContact(contact: Contact, li: HTMLLIElement): Promise<void> {
  contact.block_forward = !contact.block_forward;
  syncContact(contact, li);
  try {
    contact.block_forward = (await api<{ block_forward: boolean }>(`/contacts/${contact.id}/toggle`, "POST")).block_forward;
  } catch (error) {
    contact.block_forward = !contact.block_forward;
    toast(`Couldn't change ${contact.contact}: ${(error as Error).message}`, true);
  }
  syncContact(contact, li);
}

async function copyText(text: string, source: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Reverse-alias copied. Mail it to reply from your alias.");
  } catch {
    // ponytail: no clipboard permission in this frame, so let the user copy the selection.
    getSelection()?.selectAllChildren(source);
    toast("Selected. Press ⌘C to copy.");
  }
}

// --------------------------------------------------------------- helpers --

function address(email: string): DocumentFragment {
  const at = email.lastIndexOf("@");
  const local = document.createElement("span");
  local.className = "local";
  local.textContent = at > 0 ? email.slice(0, at) : email;
  const domain = document.createElement("span");
  domain.className = "domain";
  domain.textContent = at > 0 ? email.slice(at) : "";
  const fragment = document.createDocumentFragment();
  fragment.append(local, domain);
  return fragment;
}

function switchInput(label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", label);
  return input;
}

function skeletons(count: number): HTMLLIElement[] {
  return Array.from({ length: count }, () => {
    const li = document.createElement("li");
    li.className = "skeleton";
    li.setAttribute("aria-hidden", "true");
    li.innerHTML = "<span></span><span></span>";
    return li;
  });
}

function setState(which: "list" | "contacts", message: string | null, retry?: () => void): void {
  field(`${which}-state`).hidden = !message;
  field(`${which}-message`).textContent = message ?? "";
  const button = field(`${which}-retry`);
  button.hidden = !retry;
  button.onclick = retry ?? null;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

function ago(timestamp: number): string {
  const seconds = timestamp - Date.now() / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return "just now";
}

function toast(text: string, isError = false): void {
  const node = field("toast");
  node.textContent = text;
  node.classList.toggle("is-error", isError);
  node.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-shown"), isError ? 5000 : 2600);
}

function field<T extends HTMLElement = HTMLElement>(name: string): T {
  return document.querySelector<T>(`[data-field="${name}"]`)!;
}

// -------------------------------------------------------------- bindings --

function bind(): void {
  const search = field<HTMLInputElement>("search");
  let debounce: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = search.value.trim();
      if (next === query) return;
      query = next;
      void loadAliases(true);
    }, 300);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value) {
      search.value = "";
      search.dispatchEvent(new Event("input"));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>(".alias-main")?.focus();
    }
  });

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="filter"]')) {
    radio.addEventListener("change", () => {
      filter = radio.value;
      void loadAliases(true);
    });
  }

  field("more").addEventListener("click", () => void loadAliases(false));
  field("contacts-more").addEventListener("click", () => void loadContacts(false));
  field("d-toggle").addEventListener("change", () => selected && void toggleAlias(selected));
  field("back").addEventListener("click", () => {
    field("app").dataset.view = "list";
    if (selected) rows.get(selected.id)?.querySelector<HTMLButtonElement>(".alias-main")?.focus();
  });

  // ↑/↓ walk the list and open each alias as they go, like a mail client.
  field("list").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const current = (event.target as HTMLElement).closest("li");
    const next = event.key === "ArrowDown" ? current?.nextElementSibling : current?.previousElementSibling;
    const button = next?.querySelector<HTMLButtonElement>(".alias-main");
    if (!button) return;
    event.preventDefault();
    button.focus();
    if (!NARROW.matches) button.click(); // one pane: don't jump into the detail
  });

  document.addEventListener("keydown", (event) => {
    const typing = (event.target as HTMLElement).closest("input[type=search], textarea");
    if (event.key === "/" && !typing) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });
}
