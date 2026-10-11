// What a shortcut's address means: parsing what people type, and the name,
// letter and colour that stand in for the site's favicon until (or unless) it loads.

/**
 * "github.com" -> https://github.com/. Only what openExternal accepts:
 * https and mailto; http is upgraded. Anything else is null.
 */
export function toUrl(input: string): URL | null {
  const text = input.trim();
  if (!text) return null;
  try {
    // No dots in a scheme, so "example.com:8080" still gets https:// in front.
    const url = new URL(/^[a-z][a-z\d+-]*:/i.test(text) ? text : `https://${text}`);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol === "mailto:") return url.pathname.includes("@") ? url : null;
    return url.protocol === "https:" && url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

/** github.com, en.wikipedia.org, or the address of a mailto link. */
export function hostOf(url: URL): string {
  return url.protocol === "mailto:" ? url.pathname : url.hostname.replace(/^www\./, "");
}

/** mail.google.com -> "Google", bbc.co.uk -> "Bbc": a starting point the user can rename. */
export function guessName(url: URL): string {
  if (url.protocol === "mailto:") return url.pathname;
  const parts = hostOf(url).split(".");
  let label = parts.at(-2) ?? parts[0];
  // ponytail: short second-level labels are usually co.uk-style suffixes; no public suffix list
  if (label.length <= 3 && parts.length >= 3) label = parts.at(-3)!;
  return label[0].toUpperCase() + label.slice(1);
}

/** A stable hue per site, so the same site always gets the same colour. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

export function initialOf(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
