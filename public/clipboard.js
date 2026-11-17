// Clipboard API requires a secure context. LAN HTTP uses the copy-command fallback.
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Try legacy copy below. */
    }
  }
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, {
    position: "fixed",
    left: "0",
    top: "0",
    opacity: "0",
  });
  document.body.append(field);
  try {
    field.select();
    field.setSelectionRange(0, field.value.length);
    if (!document.execCommand("copy"))
      throw Error("クリップボードにコピーできませんでした");
  } finally {
    field.remove();
    previous?.focus();
  }
}
