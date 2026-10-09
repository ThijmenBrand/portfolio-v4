/**
 * Mouse events over an iframe go to the iframe's document, not ours — so a
 * drag or resize that crosses an app's iframe would stall, and a mouseup
 * inside it would be lost (leaving the window "stuck" to the cursor).
 * While an interaction runs, iframes ignore the pointer (see window.css).
 */
const CLASS = "wm-interacting";

export function shieldIframes(): void {
  document.body.classList.add(CLASS);
}

export function unshieldIframes(): void {
  document.body.classList.remove(CLASS);
}
