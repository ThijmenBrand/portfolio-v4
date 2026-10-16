// Where boxes go. Pure geometry: no DOM, no dates beyond arithmetic, so it
// can be checked on its own.

export interface Span {
  /** Start, in whatever unit the caller is working in (minutes, or days). */
  start: number;
  /** Exclusive. */
  end: number;
}

export interface Placed {
  col: number;
  /** How many columns wide, after widening into free neighbours. */
  span: number;
  /** Columns in this box's own cluster. */
  total: number;
}

/** A box narrower than this is unreadable, so overlap is judged at this size. */
export const MIN_MINUTES = 20;

interface Cluster {
  members: number[];
  colEnds: number[];
}

/**
 * Lays out overlapping events as columns in a day: greedy first-fit, then
 * widen to the right.
 *
 * Four things here are each a bug if you leave them out, and each only shows
 * up with real data:
 *
 *  1. Spans are padded to MIN_MINUTES BEFORE laying out. Laying out on true
 *     times and applying a CSS min-height afterwards is exactly how two
 *     back-to-back five-minute events end up drawn on top of each other.
 *  2. Within one start time the longest goes first, or a three-hour event
 *     lands in column 1 and the day looks inverted.
 *  3. The widening pass. Without it a 9-12 event sits at a third of the width
 *     for three hours because two short events overlap different parts of it.
 *  4. maxCols, so a phone doesn't render five 24px slivers. What doesn't fit
 *     comes back in `hidden` for the caller to show as "+N".
 *
 * `placed` is index-aligned with `input`; null means hidden.
 */
export function columnLayout(
  input: readonly Span[],
  maxCols = Number.POSITIVE_INFINITY,
): { placed: (Placed | null)[]; hidden: number[] } {
  const spans = input.map((span) => ({
    start: span.start,
    end: Math.max(span.end, span.start + MIN_MINUTES),
  }));
  const order = spans
    .map((_, index) => index)
    .sort(
      (a, b) =>
        spans[a]!.start - spans[b]!.start || spans[b]!.end - spans[a]!.end || a - b,
    );

  const placed: (Placed | null)[] = input.map(() => null);
  const hidden: number[] = [];
  const overlaps = (a: number, b: number): boolean =>
    spans[a]!.start < spans[b]!.end && spans[b]!.start < spans[a]!.end;

  let cluster: Cluster = { members: [], colEnds: [] };
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    const total = Math.min(cluster.colEnds.length, maxCols);
    const byCol: number[][] = cluster.colEnds.map(() => []);
    for (const index of cluster.members) byCol[placed[index]!.col]!.push(index);

    for (const index of cluster.members) {
      const box = placed[index]!;
      if (box.col >= maxCols) {
        placed[index] = null;
        hidden.push(index);
        continue;
      }
      box.total = total;
      let reach = box.col + 1;
      while (reach < total && !byCol[reach]!.some((other) => overlaps(index, other))) {
        reach++;
      }
      box.span = reach - box.col;
    }
    cluster = { members: [], colEnds: [] };
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const index of order) {
    // A cluster is a maximal run of boxes connected by overlap; once we are
    // past every box in it, the next one starts fresh at column 0.
    if (cluster.members.length && spans[index]!.start >= clusterEnd) flush();

    let col = cluster.colEnds.findIndex((end) => end <= spans[index]!.start);
    if (col === -1) {
      col = cluster.colEnds.length;
      cluster.colEnds.push(0);
    }
    cluster.colEnds[col] = spans[index]!.end;
    placed[index] = { col, span: 1, total: 0 };
    cluster.members.push(index);
    clusterEnd = Math.max(clusterEnd, spans[index]!.end);
  }
  if (cluster.members.length) flush();

  return { placed, hidden };
}

export interface Lane {
  lane: number;
  /** Lanes in this entry's own cluster, so a caller can size the row. */
  lanes: number;
}

/**
 * The same first-fit packing without the widening pass, for bars that are
 * always full width: the month grid's week rows and the week view's all-day
 * strip. Spans are in days there, so a three-day event stays one continuous
 * bar instead of three disconnected chips.
 */
export function packLanes(input: readonly Span[]): Lane[] {
  const order = input
    .map((_, index) => index)
    .sort(
      (a, b) =>
        input[a]!.start - input[b]!.start || input[b]!.end - input[a]!.end || a - b,
    );

  const out: Lane[] = input.map(() => ({ lane: 0, lanes: 1 }));
  let members: number[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    for (const index of members) out[index]!.lanes = laneEnds.length;
    members = [];
    laneEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const index of order) {
    if (members.length && input[index]!.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= input[index]!.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = input[index]!.end;
    out[index] = { lane, lanes: 1 };
    members.push(index);
    clusterEnd = Math.max(clusterEnd, input[index]!.end);
  }
  if (members.length) flush();

  return out;
}

/**
 * Minutes from the local midnight that opens `day` to the instant `at`.
 *
 * Never compute this from getHours() * 60 + getMinutes(): on the two days a
 * year a zone changes offset, that is wrong by an hour for part of the day.
 * Measuring from midnight instead means a 23- or 25-hour day runs correctly
 * short or long against the grid's nominal 00-23 gutter, which is the honest
 * rendering of a day that genuinely isn't 24 hours. Don't "fix" it.
 */
export function minutesInto(day: Date, at: Date): number {
  return (at.getTime() - day.getTime()) / 60_000;
}
