// The iCalendar lexer (RFC 5545 §3.1): a feed's text -> content lines. Knows
// nothing about calendars; parse.ts is what gives the lines meaning.
import { naive, type Naive } from "./zone.ts";

export interface ContentLine {
  /** Upper-cased: "DTSTART", "X-WR-CALNAME". */
  name: string;
  /** Keys upper-cased, surrounding quotes stripped. Values keep their case. */
  params: Record<string, string>;
  /** Still escaped: run it through unescapeText for a TEXT property. */
  value: string;
}

/**
 * Splits on line endings and rejoins folded continuations. A line starting
 * with a space or tab continues the one before it, and exactly one character
 * is the fold — "\r\n  x" is a continuation whose first character is a space.
 *
 * ponytail: RFC 5545 folds on octets, so an exporter may split a multi-byte
 * UTF-8 sequence. By the time we have a string that damage is already done.
 */
export function unfold(text: string): string[] {
  const out: string[] = [];
  // Bare \n and bare \r both happen: feeds get rewritten by proxies and CDNs.
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (out.length && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] += line.slice(1);
    } else out.push(line);
  }
  return out;
}

/**
 * "DTSTART;TZID=Europe/Amsterdam:20261006T100000" -> its three parts, or null
 * for a blank or malformed line.
 *
 * One left-to-right scan rather than a split: a ":" or ";" inside a quoted
 * parameter value does not end the section it sits in, so splitting on them
 * loses CN="Doe: John" — and the value itself is full of colons anyway
 * ("SUMMARY:Lunch: 12:00").
 */
export function parseLine(line: string): ContentLine | null {
  let at = 0;
  const scan = (stops: string): string => {
    const from = at;
    let quoted = false;
    while (at < line.length) {
      const char = line[at]!;
      if (char === '"') quoted = !quoted;
      else if (!quoted && stops.includes(char)) break;
      at++;
    }
    return line.slice(from, at);
  };

  const name = scan(";:").toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  while (line[at] === ";") {
    at++;
    const key = scan("=;:").toUpperCase();
    let value = "";
    if (line[at] === "=") {
      at++;
      value = scan(";:");
    }
    // RFC 5545 forbids a quote inside a quoted value, so trimming the ends is safe.
    params[key] =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
  }

  if (line[at] !== ":") return null;
  return { name, params, value: line.slice(at + 1) };
}

/** \n and \N -> a newline; \, \; \\ -> the character. An unknown \x keeps x. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\s\S])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

/** Splits a multi-value property on its unescaped commas. Segments stay escaped. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let at = 0; at < value.length; at++) {
    if (value[at] === "\\") at++; // whatever follows is escaped, including a comma
    else if (value[at] === ",") {
      out.push(value.slice(from, at));
      from = at + 1;
    }
  }
  out.push(value.slice(from));
  return out;
}

export interface DateValue {
  /** The wall clock the value spells out. */
  n: Naive;
  /** The value ended in "Z": it names an instant, whatever TZID says. */
  utc: boolean;
  /** VALUE=DATE, i.e. 20261212 with no time part. */
  dateOnly: boolean;
}

/** "20261006T100000Z" / "20261006T100000" / "20261212" -> its parts, or null. */
export function parseDateValue(value: string): DateValue | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  return {
    n: naive(+y!, +mo!, +d!, +(h ?? 0), +(mi ?? 0), +(s ?? 0)),
    utc: z === "Z",
    dateOnly: h === undefined,
  };
}
