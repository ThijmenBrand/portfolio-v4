// The pling on finishing a todo: synthesised on the spot, so there is no
// audio file to ship and nothing for the CSP to load.
//
// Two bell-ish notes a fifth apart, the second one higher and longer, with a
// short echo behind them for shimmer. Rising intervals read as "done, well
// done"; a falling one reads as an error.

let context: AudioContext | null = null;

/** A sine with two quiet overtones, struck at `at` and left to ring out. */
function note(ctx: AudioContext, out: AudioNode, freq: number, at: number, ring: number, level: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ring);
  gain.connect(out);

  for (const [ratio, share] of [[1, 1], [2, 0.22], [3, 0.06]] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * ratio, at);
    const partial = ctx.createGain();
    partial.gain.value = share;
    osc.connect(partial).connect(gain);
    osc.start(at);
    osc.stop(at + ring + 0.05);
  }
}

/** Must be called from the click itself, or the browser keeps the context muted. */
export function pling(): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === "suspended") void ctx.resume();

    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);

    // The echo: a little of the sound again a beat later, softer each time.
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.11;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    master.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(ctx.destination);

    const now = ctx.currentTime + 0.01;
    note(ctx, master, 1046.5, now, 0.38, 0.7); // C6
    note(ctx, master, 1568.0, now + 0.075, 1.1, 1); // G6

    // Let the graph go once the echo has died away.
    // The delay loop feeds itself, so it has to be cut too or it outlives the sound.
    setTimeout(() => {
      master.disconnect();
      delay.disconnect();
      wet.disconnect();
    }, 2000);
  } catch {
    /* no audio here: finishing a todo still works, just quietly */
  }
}
