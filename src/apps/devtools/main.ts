// devtools — JSON, Base64, JWT, URL, UUID and timestamp tools in tabs. The
// logic is src/bin/lib/dev.ts, the same as the json/base64/jwt/urlencode/uuid/epoch
// commands. Everything runs locally; nothing is sent anywhere.
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import {
  b64decode,
  b64encode,
  decodeJwt,
  formatJson,
  parseTime,
  relative,
  timeRows,
  urlDecode,
  urlEncode,
  uuidV4,
  uuidV7,
  type Result,
} from "../../bin/lib/dev";
import devtoolsHTML from "./devtools.html?raw";
import "../../ui/theme.css";
import "../../ui/kit.css";
import "./devtools.css";

type Panel = HTMLElement;

const $ = <T extends Element = HTMLElement>(panel: Panel, selector: string) => panel.querySelector<T>(selector)!;
const value = (panel: Panel, name: string) =>
  panel.querySelector<HTMLInputElement>(`[name="${name}"]:is(:checked, select, [type="number"])`)?.value ?? "";
const checked = (panel: Panel, name: string) => $<HTMLInputElement>(panel, `[name="${name}"]`).checked;
const input = (panel: Panel) => $<HTMLTextAreaElement | HTMLInputElement>(panel, "[data-in]");

/** Status line text; `error` also marks the input invalid. */
function status(panel: Panel, text: string, error = false): void {
  const line = $(panel, "[data-status]");
  line.textContent = text;
  line.classList.toggle("error", error);
  input(panel)?.setAttribute("aria-invalid", String(error));
}

/** Shows a Result in the panel's output, or its error in the status line. */
function show(panel: Panel, result: Result, okText = ""): void {
  $(panel, "[data-out]").textContent = result.ok ? result.out : "";
  status(panel, result.ok ? okText : result.error, !result.ok);
}

/** Each tool re-renders its panel from scratch on any input or change inside it. */
const tools: Record<string, (panel: Panel) => void> = {
  json(panel) {
    const text = input(panel).value;
    if (!text.trim()) return show(panel, { ok: true, out: "" });
    show(panel, formatJson(text, Number(value(panel, "indent"))), "Valid JSON");
  },

  base64(panel) {
    const text = input(panel).value;
    if (value(panel, "mode") === "encode") return show(panel, { ok: true, out: b64encode(text, checked(panel, "url")) });
    show(panel, b64decode(text));
  },

  jwt(panel) {
    const text = input(panel).value.trim();
    const view = $(panel, "[data-jwt]");
    view.hidden = true;
    if (!text) return status(panel, "");
    try {
      const jwt = decodeJwt(text);
      $(panel, '[data-field="header"]').textContent = JSON.stringify(jwt.header, null, 2);
      $(panel, '[data-field="payload"]').textContent = JSON.stringify(jwt.payload, null, 2);
      const names = { exp: "Expires", nbf: "Not before", iat: "Issued" };
      $(panel, '[data-field="times"]').replaceChildren(
        ...Object.entries(jwt.times).map(([claim, date]) =>
          row(names[claim as keyof typeof names], `${date.toLocaleString()} (${relative(date)})`),
        ),
      );
      view.hidden = false;
      status(panel, jwt.expired ? "Expired" : `Decoded, ${String(jwt.header.alg ?? "no alg")}`, jwt.expired);
    } catch (error) {
      status(panel, (error as Error).message, true);
    }
  },

  url(panel) {
    const text = input(panel).value;
    if (value(panel, "mode") === "encode") return show(panel, { ok: true, out: urlEncode(text, checked(panel, "whole")) });
    show(panel, urlDecode(text));
  },

  uuid(panel) {
    const count = Math.min(Math.max(Number(value(panel, "count")) || 1, 1), 1000);
    const make = value(panel, "version") === "7" ? uuidV7 : uuidV4;
    $(panel, "[data-out]").textContent = Array.from({ length: count }, () => make()).join("\n");
  },

  time(panel) {
    const table = $(panel, '[data-field="rows"]');
    try {
      const rows = timeRows(parseTime(input(panel).value));
      table.replaceChildren(...rows.map(([label, text]) => row(label, text, true)));
      status(panel, input(panel).value.trim() ? "" : "Now, updating live");
    } catch (error) {
      table.replaceChildren();
      status(panel, (error as Error).message, true);
    }
  },
};

/** A <tr> of label and value, with a copy button if asked. */
function row(label: string, text: string, copy = false): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.innerHTML = `<th scope="row"></th><td class="mono"></td><td class="copy"></td>`;
  tr.cells[0]!.textContent = label;
  tr.cells[1]!.textContent = text;
  if (copy) tr.cells[2]!.innerHTML = `<button type="button" data-copy-text>Copy</button>`;
  return tr;
}

/** `devtools [tab]`, e.g. `devtools jwt` opens on the JWT tab. */
export async function main(os: AppInterface, args: string[] = []): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Dev Toolbox" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = devtoolsHTML;

  for (const [name, render] of Object.entries(tools)) {
    const panel = document.getElementById(`panel-${name}`)!;
    panel.addEventListener("input", () => render(panel));
    panel.addEventListener("change", () => render(panel));
    panel.addEventListener("click", (event) => {
      const button = (event.target as Element).closest("button");
      if (!button) return;
      if (button.dataset.action === "now") input(panel).value = "";
      if (button.dataset.action) return render(panel);
      const text = button.hasAttribute("data-copy")
        ? $(panel, "[data-out]").textContent
        : button.hasAttribute("data-copy-text")
          ? button.closest("tr")!.cells[1]!.textContent
          : null;
      if (text) void copy(os, button, text);
    });
    render(panel);
  }

  // The Timestamp tab follows the clock while its input is empty.
  const time = document.getElementById("panel-time")!;
  setInterval(() => {
    if (!time.hidden && !input(time).value.trim()) tools.time!(time);
  }, 1000);

  setUpTabs(args[0]);
}

async function copy(os: AppInterface, button: HTMLButtonElement, text: string): Promise<void> {
  const label = button.textContent;
  try {
    await os.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Couldn't copy";
  }
  setTimeout(() => (button.textContent = label), 1200);
}

/** Horizontal tablist: click or arrow keys, roving tabindex (as in Settings). */
function setUpTabs(initial?: string): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement): void => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")!)!.hidden = !selected;
    }
    document.getElementById(tab.getAttribute("aria-controls")!)!.querySelector<HTMLElement>("[data-in]")?.focus();
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length]!;
      select(target);
      target.focus();
    });
  });
  select(tabs.find((tab) => tab.id === `tab-${initial}`) ?? tabs[0]!);
}
