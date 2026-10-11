import "./confirm.css";

/**
 * A themed stand-in for window.confirm(): a modal <dialog> on the top layer.
 * Esc / Cancel resolves false; the confirm button is focused, Enter accepts.
 */
export function confirmDialog(
  message: string,
  { title = "", ok = "OK", danger = false } = {},
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  if (title) form.append(Object.assign(document.createElement("h2"), { textContent: title }));
  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = Object.assign(document.createElement("button"), {
    value: "cancel",
    textContent: "Cancel",
  });
  const accept = Object.assign(document.createElement("button"), {
    value: "ok",
    textContent: ok,
    className: danger ? "danger" : "primary",
    autofocus: true,
  });
  actions.append(cancel, accept);
  form.append(Object.assign(document.createElement("p"), { textContent: message }), actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
  });
}
