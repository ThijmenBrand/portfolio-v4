import "./confirm.css";

/**
 * A themed stand-in for window.confirm(): a modal <dialog> on the top layer.
 * Esc / Cancel resolves false; the confirm button is focused, Enter accepts.
 *
 * The buttons close the dialog themselves rather than through a
 * <form method="dialog">: apps run in sandboxed iframes without allow-forms,
 * where submitting a form (even a dialog one) is blocked and does nothing.
 */
export function confirmDialog(
  message: string,
  { title = "", ok = "OK", danger = false } = {},
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  const content = document.createElement("div");
  if (title) content.append(Object.assign(document.createElement("h2"), { textContent: title }));
  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: "Cancel",
  });
  const accept = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: ok,
    className: danger ? "danger" : "primary",
  });
  cancel.addEventListener("click", () => dialog.close("cancel"));
  accept.addEventListener("click", () => dialog.close("ok"));
  actions.append(cancel, accept);
  content.append(Object.assign(document.createElement("p"), { textContent: message }), actions);
  dialog.append(content);
  document.body.append(dialog);
  dialog.showModal();
  // Not `autofocus`: that's ignored in a cross-origin iframe.
  accept.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
  });
}
