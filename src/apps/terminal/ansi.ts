/**
 * Minimal escape-sequence handling for an append-only screen.
 *
 * The terminal renders plain text, so it only acts on "erase display"
 * (ESC[2J / ESC[3J) and full reset (ESC c). Every other CSI sequence
 * (cursor moves, colours) is consumed and dropped, so programs that emit
 * them don't print garbage.
 *
 * Stateful: a read can end in the middle of a sequence, so an incomplete
 * tail is held back and finished by the next chunk.
 */

export type Segment = { kind: "text"; text: string } | { kind: "clear" };

const ESC = "\x1b";
/** Longest incomplete sequence we hold back before giving up on it. */
const MAX_PENDING = 32;

export class AnsiParser {
  private pending = "";

  public feed(input: string): Segment[] {
    const s = this.pending + input;
    this.pending = "";

    const out: Segment[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ kind: "text", text });
      text = "";
    };

    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch !== ESC) {
        text += ch;
        i++;
        continue;
      }

      // ESC at the very end: wait for the next chunk.
      if (i + 1 >= s.length) {
        this.hold(s.slice(i));
        break;
      }

      const next = s[i + 1];

      if (next === "c") {
        // RIS — full reset.
        flush();
        out.push({ kind: "clear" });
        i += 2;
        continue;
      }

      if (next === "[") {
        // CSI: ESC [ params final
        let j = i + 2;
        while (j < s.length && /[0-9;?]/.test(s[j])) j++;
        if (j >= s.length) {
          this.hold(s.slice(i));
          break;
        }
        const params = s.slice(i + 2, j);
        const final = s[j];
        if (final === "J" && (params === "2" || params === "3")) {
          flush();
          out.push({ kind: "clear" });
        }
        i = j + 1;
        continue;
      }

      // ESC followed by something we don't know: drop the ESC itself.
      i++;
    }

    flush();
    return out;
  }

  private hold(tail: string): void {
    // A runaway "sequence" is not a sequence; don't swallow output forever.
    this.pending = tail.length <= MAX_PENDING ? tail : "";
  }
}
