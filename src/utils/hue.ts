// A stable colour and letter from a string: what stands in for an icon when
// the sandbox can't load one. Shared by the Shortcuts dial and the Calendar's
// subscription swatches, so the same address looks the same in both.

/** The same text always gets the same hue, across users and reinstalls. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

export function initialOf(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
