import { ebadf } from "../errors";
import type { Signal } from "../proc/signals";
import type { Stat } from "../fs/types";
import type { Bytes, Pid } from "../types";
import type { OpenFile, PtyFds } from "./openfile";
import { PipeBuffer } from "./pipe";

let nextPtyId = 1;

export interface Termios {
  echo: boolean;
  icanon: boolean;
  isig: boolean;
}

export interface Winsize {
  rows: number;
  cols: number;
}

const INTR = 0x03; // ^C
const EOF = 0x04; // ^D
const BS = 0x08;
const NL = 0x0a;
const SUSP = 0x1a; // ^Z
const DEL = 0x7f;

const encoder = new TextEncoder();

/**
 * The line discipline between a pty's two ends: what the master (the
 * terminal) writes is edited, echoed and turned into signals before the
 * slave (the shell, its jobs) reads it. Slave output goes through untouched.
 * ponytail: no output processing (ONLCR), no VMIN/VTIME, no SIGTTIN for
 * background readers. Add them when a program needs them.
 */
export class Tty {
  public termios: Termios = { echo: true, icanon: true, isig: true };
  public winsize: Winsize = { rows: 24, cols: 80 };
  /** The group ^C and resizes go to (tcsetpgrp). */
  public foreground?: Pid;

  private line: number[] = [];

  public readonly toSlave = new PipeBuffer();
  public readonly toMaster = new PipeBuffer();
  public readonly id = nextPtyId++;

  private readonly signal: (pgid: Pid, signal: Signal) => void;

  public constructor(signal: (pgid: Pid, signal: Signal) => void) {
    this.signal = signal;
  }

  /** Master -> slave. Returns data.length: input is never refused, only parked. */
  public async input(data: Bytes, abort?: AbortSignal): Promise<number> {
    const echo: number[] = [];
    const ready: number[] = [];

    for (const byte of data) {
      const { icanon, isig } = this.termios;

      if (isig && (byte === INTR || byte === SUSP)) {
        this.line = [];
        echo.push(...encoder.encode(byte === INTR ? "^C\n" : "^Z\n"));
        if (this.foreground !== undefined)
          this.signal(this.foreground, byte === INTR ? "SIGINT" : "SIGTSTP");
        continue;
      }

      if (!icanon) {
        ready.push(byte);
        echo.push(byte);
        continue;
      }

      if (byte === DEL || byte === BS) {
        if (this.line.length === 0) continue;
        // One character, not one byte: drop UTF-8 continuation bytes too.
        while ((this.line.pop()! & 0xc0) === 0x80 && this.line.length > 0);
        echo.push(BS, 0x20, BS);
        continue;
      }

      if (byte === EOF) {
        // Mid-line: hand over what's typed. Empty line: one EOF read.
        if (this.line.length === 0) this.toSlave.pushEof();
        else ready.push(...this.line.splice(0));
        continue;
      }

      this.line.push(byte);
      echo.push(byte);
      if (byte === NL) ready.push(...this.line.splice(0));
    }

    if (this.termios.echo && echo.length > 0)
      await this.toMaster.write(new Uint8Array(echo), abort);
    if (ready.length > 0)
      await this.toSlave.write(new Uint8Array(ready), abort);
    return data.length;
  }

  public setAttr(changes: Partial<Termios>): void {
    const wasCanonical = this.termios.icanon;
    this.termios = { ...this.termios, ...changes };
    // Leaving canonical mode: a half-typed line is readable right away.
    if (wasCanonical && !this.termios.icanon && this.line.length > 0) {
      void this.toSlave.write(new Uint8Array(this.line.splice(0)));
    }
  }

  public setWinsize(size: Winsize): void {
    const changed =
      size.rows !== this.winsize.rows || size.cols !== this.winsize.cols;
    this.winsize = { ...size };
    if (changed && this.foreground !== undefined)
      this.signal(this.foreground, "SIGWINCH");
  }
}

export class PtyEnd implements OpenFile {
  public readonly seekable = false;
  private closed = false;

  public readonly tty: Tty;
  private readonly master: boolean;
  public readonly description: string;

  public constructor(tty: Tty, master: boolean) {
    this.tty = tty;
    this.master = master;
    this.description = `pty:[${tty.id}]:${master ? "master" : "slave"}`;
  }

  private get inbound(): PipeBuffer {
    return this.master ? this.tty.toMaster : this.tty.toSlave;
  }

  public async read(_offset: number, length: number, signal?: AbortSignal) {
    if (this.closed) throw ebadf(this.description);
    return this.inbound.read(length, signal);
  }

  public async write(_offset: number, data: Bytes, signal?: AbortSignal) {
    if (this.closed) throw ebadf(this.description);
    return this.master
      ? this.tty.input(data, signal)
      : this.tty.toMaster.write(data, signal);
  }

  public async stat(): Promise<Stat> {
    return this.inbound.stat();
  }

  public async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.inbound.closeRead();
    (this.master ? this.tty.toSlave : this.tty.toMaster).closeWrite();
  }
}

export function createPty(signal: (pgid: Pid, signal: Signal) => void): PtyFds {
  const tty = new Tty(signal);
  return { master: new PtyEnd(tty, true), slave: new PtyEnd(tty, false) };
}

