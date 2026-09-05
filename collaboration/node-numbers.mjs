/** Canvas-local numbers. Shared by the browser, API and collaboration server. */
export function canvasNodeType(data) {
  if (data.kind === "prompt") return data.mediaType === "video" ? "video_generator" : "image_generator";
  return data.kind || "node";
}

export function canvasNodeLabel(data) {
  const labels = { image_generator: "Image Generator", video_generator: "Video Generator", assistant: "Assistant", note: "Note", videoMaster: "Video Master", persona: "Identity", source: "Source", scene: "Scene", hook: "Hook", generation: "Generation" };
  const title = labels[canvasNodeType(data)] || "Node";
  return Number.isSafeInteger(data.nodeNumber) && data.nodeNumber > 0 ? `${title} ${data.nodeNumber}` : title;
}

/** Preserve occupied slots before assigning the smallest free positive integer.
 * previous protects existing numbers against copied data and type changes.
 * Input order breaks ties for legacy nodes with no creation date.
 */
export function assignCanvasNodeNumbers(nodes, previous) {
  const prior = previous && new Map(previous.map((node) => [node.id, node]));
  const prepared = nodes.map((node, index) => {
    const type = canvasNodeType(node.data);
    const old = prior?.get(node.id);
    const number = prior
      ? (old && canvasNodeType(old.data) === type ? old.data.nodeNumber : undefined)
      : (!node.data.nodeNumberType || node.data.nodeNumberType === type ? node.data.nodeNumber : undefined);
    return { node, index, type, number };
  });
  const ordered = [...prepared].sort((a, b) => {
    const left = Date.parse(a.node.data.createdAt || "");
    const right = Date.parse(b.node.data.createdAt || "");
    return ((Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity)) || a.index - b.index;
  });
  const used = new Map();
  const assigned = new Map();
  for (const item of ordered) {
    if (!used.has(item.type)) used.set(item.type, new Set());
    const slots = used.get(item.type);
    if (Number.isSafeInteger(item.number) && item.number > 0 && !slots.has(item.number)) {
      slots.add(item.number);
      assigned.set(item.index, item.number);
    }
  }
  for (const item of ordered) {
    if (assigned.has(item.index)) continue;
    const slots = used.get(item.type);
    let number = 1;
    while (slots.has(number)) number++;
    slots.add(number);
    assigned.set(item.index, number);
  }
  let changed = false;
  const result = prepared.map(({ node, index, type }) => {
    const nodeNumber = assigned.get(index);
    if (node.data.nodeNumber === nodeNumber && node.data.nodeNumberType === type) return node;
    changed = true;
    return { ...node, data: { ...node.data, nodeNumber, nodeNumberType: type } };
  });
  return changed ? result : nodes;
}
