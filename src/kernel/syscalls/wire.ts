import type { AppInterface } from "./api";

type Primitive = string | number | boolean | bigint | null | undefined | void;

/** Things the structured clone algorithm copies natively. */
type CloneableBuiltin = ArrayBuffer | ArrayBufferView | Date | RegExp | Blob;

/** Live objects that must never cross: DOM nodes, AbortSignal, windows, ports... */
type Live = EventTarget;

/**
 * true  -> structured clone carries this faithfully.
 * false -> it does not (function, DOM node, live object, any/unknown).
 * Distributes over unions, so a union yields `boolean` if any member fails.
 */
type CloneCheck<T> = T extends Primitive
  ? true
  : T extends Function
    ? false
    : T extends Live
      ? false
      : T extends CloneableBuiltin
        ? true
        : T extends readonly (infer U)[]
          ? CloneCheck<U>
          : T extends Map<infer K, infer V>
            ? CloneCheck<K> | CloneCheck<V>
            : T extends Set<infer U>
              ? CloneCheck<U>
              : T extends object
                ? { [K in keyof T]-?: CloneCheck<T[K]> }[keyof T]
                : false;

export type IsCloneable<T> = false extends CloneCheck<T> ? false : true;

/** A callback the app passes in. Its arguments travel kernel -> app, it returns nothing. */
type CallbackOk<F> = F extends (...args: infer A) => infer R
  ? IsCloneable<A> extends true
    ? [R] extends [void]
      ? true
      : false
    : false
  : false;

/** One parameter: plain data, or a callback the runtime will turn into an id. */
type ParamOk<P> = [P] extends [(...args: any[]) => any]
  ? CallbackOk<P>
  : IsCloneable<P>;

type ParamsOk<A extends readonly unknown[]> = false extends {
  [I in keyof A]: ParamOk<A[I]>;
}[number]
  ? false
  : true;

/** `any` silently passes most checks, so reject it explicitly. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** A disposer the runtime builds locally (unsubscribe). */
type Disposer = () => void;

/**
 * What a call may resolve to:
 *  - plain data,
 *  - a disposer,
 *  - a handle: an object whose members are themselves wire-safe members
 *    (the runtime builds it from an id, e.g. a WindowHandle).
 */
type ResultOk<V> =
  IsAny<V> extends true
    ? false
    : [V] extends [Disposer]
      ? true
      : IsCloneable<V> extends true
        ? true
        : V extends Live
          ? false
          : V extends object
            ? HandleOk<V>
            : false;

type MethodOk<F> = F extends (...args: infer A) => infer R
  ? R extends Promise<infer V>
    ? ParamsOk<A> extends true
      ? ResultOk<V>
      : false
    : false // every call must be async over a wire
  : false;

type MemberOk<M> = [M] extends [(...args: any[]) => any]
  ? MethodOk<M>
  : IsCloneable<M>; // data property, e.g. pid / handle.id

type HandleOk<H> = false extends { [K in keyof H]-?: MemberOk<H[K]> }[keyof H]
  ? false
  : true;

/** Union of "namespace.member" paths that cannot cross a wire. `never` = all good. */
export type WireViolations<I> = {
  [NS in keyof I & string]: {
    [M in keyof I[NS] & string]-?: MemberOk<I[NS][M]> extends true
      ? never
      : `${NS}.${M}`;
  }[keyof I[NS] & string];
}[keyof I & string];

/**
 * Members the app-side runtime implements locally; they never reach the
 * kernel, so they are exempt. Keep this list short and reviewed.
 */
type RuntimeLocal = "process.signal";

type AssertNever<T extends never> = T;

export type AppInterfaceIsWireSafe = AssertNever<
  Exclude<WireViolations<AppInterface>, RuntimeLocal>
>;
