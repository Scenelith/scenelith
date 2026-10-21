import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BaseEdge, ReactFlow, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";

function Edge(props: EdgeProps) {
  return <><BaseEdge path={getBezierPath(props)[0]} /><foreignObject x="100" y="20" width="30" height="30"><button aria-label="Disconnect">✂</button></foreignObject></>;
}
const edgeTypes = { disconnectable: Edge };
function Camera() {
  const flow = useReactFlow();
  return <button style={{ position: "absolute", zIndex: 30 }} onClick={() => flow.setViewport({ x: 40, y: 30, zoom: .7 })}>Move camera</button>;
}
function Fixture() {
  const [selected, setSelected] = useState(false);
  const [shown, setShown] = useState(true);
  const [moved, setMoved] = useState(false);
  return <>
    <button onClick={() => setSelected(!selected)}>Highlight</button>
    <button onClick={() => setShown(!shown)}>Remove edges</button>
    <button onClick={() => setMoved(!moved)}>Move node</button>
    <div style={{ width: 1100, height: 700, background: "#111" }}>
      <ReactFlow nodes={[{ id: "a", position: { x: 50, y: 50 }, data: { label: "a" } }, { id: "b", position: { x: 800, y: moved ? 200 : 500 }, data: { label: "b" } }]} edges={shown ? [{ id: "e", source: "a", target: "b", type: "disconnectable", animated: true, className: selected ? "is-selected-path" : "" }] : []} edgeTypes={edgeTypes}>
        <Camera />
      </ReactFlow>
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
