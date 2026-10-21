/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bindCanvasClipboard, canvasSelectionPrefix } from "../../../src/lib/canvas-clipboard";

function Fixture() {
  const copied = useRef<string | null>(null);
  const [nodes, setNodes] = useState(0);
  const [images, setImages] = useState<string[]>([]);
  useEffect(() => bindCanvasClipboard({
    copyNodes: () => copied.current = canvasSelectionPrefix + crypto.randomUUID(),
    pasteNodes: (token) => {
      if (token !== copied.current) return false;
      setNodes((count) => count + 1);
      return true;
    },
    pasteImages: (files) => setImages((current) => [...current, ...files.map((file) => URL.createObjectURL(file))]),
    canPaste: () => true,
  }), []);
  return <>
    <button>Canvas node</button>
    <output aria-label="Pasted nodes">{nodes}</output>
    <div aria-label="Pasted images">{images.map((url, index) => <img key={url} src={url} alt={`Pasted ${index + 1}`} />)}</div>
    <input aria-label="Node title" />
    <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Prompt"><span>Editable prompt</span></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
