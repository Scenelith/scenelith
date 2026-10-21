const selectionMime = "application/x-scenelith-canvas-selection";
export const canvasSelectionPrefix = "scenelith:canvas-selection:";

type CanvasClipboardHandlers = {
  copyNodes: () => string | null;
  pasteNodes: (token: string) => boolean;
  pasteImages: (images: File[]) => void;
  canPaste: () => boolean;
};

function isEditable(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/** Use the native clipboard event so an old in-memory node copy cannot swallow a new image. */
export function bindCanvasClipboard(handlers: CanvasClipboardHandlers, host: Window = window) {
  const copy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || isEditable(event.target) || !event.clipboardData) return;
    const token = handlers.copyNodes();
    if (!token) return;
    event.clipboardData.setData(selectionMime, token);
    event.clipboardData.setData("text/plain", token);
    event.preventDefault();
  };
  const paste = (event: ClipboardEvent) => {
    if (event.defaultPrevented || isEditable(event.target) || !event.clipboardData || !handlers.canPaste()) return;
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!images.length) images.push(...Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")));
    if (images.length) {
      event.preventDefault();
      handlers.pasteImages(images);
      return;
    }
    const token = event.clipboardData.getData(selectionMime) || event.clipboardData.getData("text/plain");
    if (token.startsWith(canvasSelectionPrefix) && handlers.pasteNodes(token)) event.preventDefault();
  };
  host.addEventListener("copy", copy);
  host.addEventListener("paste", paste);
  return () => {
    host.removeEventListener("copy", copy);
    host.removeEventListener("paste", paste);
  };
}
