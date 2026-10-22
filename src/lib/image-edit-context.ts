/** Provider ordering is part of the Edit contract, independent of assistant output. */
export function imageEditSourceInstruction(prompt: string, labels: string[]) {
  if (!labels.length || labels[0] !== '@EditSource' || labels.slice(1).includes('@EditSource')) {
    throw new Error('Image edit requires exactly one @EditSource as the first image');
  }
  return [
    'IMAGE EDIT SOURCE CONTRACT:',
    'Image 1 is @EditSource, the exact base image to modify. Its person, face, body, pose, outfit, framing, camera, lighting and background remain unchanged unless the user explicitly asks to change that property.',
    ...labels.slice(1).map((label, index) => `Image ${index + 2} is ${label}, supplemental evidence only. It never replaces the base image or its subject automatically.`),
    'Apply only the requested changes to Image 1. Taking one property from another image never grants permission to copy its other properties or composition.',
    'USER EDIT INSTRUCTIONS:',
    prompt,
  ].join('\n');
}

type IdentityNode = {id: string; data: {personaId?: string; assetId?: string; attachedReferences?: {personaId?: string}[]}};
type Identity = {id: string; assets: {id: string; sourceAssetId?: string}[]};
/** Follow existing ownership through generated nodes, without picking an arbitrary supporting identity. */
export function imageEditIdentityId(node: IdentityNode | null, nodes: IdentityNode[], edges: {source: string; target: string}[], identities: Identity[]) {
  if (!node) return undefined;
  if (node.data.personaId) return node.data.personaId;
  const owner = identities.find(identity => identity.assets.some(asset => asset.id === node.data.assetId || asset.sourceAssetId === node.data.assetId && Boolean(node.data.assetId)));
  if (owner) return owner.id;
  const pending = [node.id], visited = new Set<string>(), owners = new Set<string>();
  const byId = new Map(nodes.map(item => [item.id, item]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge.source]);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const candidate = byId.get(id);
    if (candidate?.data.personaId) { owners.add(candidate.data.personaId); continue; }
    const candidateOwner = candidate?.data.assetId && identities.find(identity => identity.assets.some(asset => asset.id === candidate.data.assetId || asset.sourceAssetId === candidate.data.assetId));
    if (candidateOwner) { owners.add(candidateOwner.id); continue; }
    for (const reference of candidate?.data.attachedReferences || []) if (reference.personaId) owners.add(reference.personaId);
    pending.push(...(incoming.get(id) || []));
  }
  return owners.size === 1 ? [...owners][0] : undefined;
}
