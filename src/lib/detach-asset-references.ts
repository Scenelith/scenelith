import type { ProjectGraph } from "./types";

/** Remove input bindings, never generated outputs or their history. */
export function detachAssetReferences(graph: ProjectGraph, assetIds: ReadonlySet<string>): ProjectGraph {
  let changed = false;
  const removedNodes = new Set<string>();
  const nodes = graph.nodes.flatMap((node) => {
    const referenceAssetIds = node.data.referenceAssetIds?.filter((id) => !assetIds.has(id));
    const identityGroupChanged = node.data.kind === "persona" && referenceAssetIds?.length !== node.data.referenceAssetIds?.length;
    if (node.data.kind === "persona" && ((identityGroupChanged && !referenceAssetIds?.length)
      || (!node.data.referenceAssetIds?.length && node.data.assetId && assetIds.has(node.data.assetId)))) {
      changed = true;
      removedNodes.add(node.id);
      return [];
    }
    let nodeChanged = false;
    const filter = <T extends { assetId: string }>(refs: T[] | undefined) => {
      if (!refs?.some((ref) => assetIds.has(ref.assetId))) return refs;
      nodeChanged = true;
      return refs.filter((ref) => !assetIds.has(ref.assetId));
    };
    const attachedReferences = filter(node.data.attachedReferences);
    if (referenceAssetIds?.length !== node.data.referenceAssetIds?.length) nodeChanged = true;
    const videoMasterClips = node.data.videoMasterClips?.map((clip) => {
      const refs = filter(clip.attachedReferences);
      return refs === clip.attachedReferences ? clip : { ...clip, attachedReferences: refs };
    });
    const editReferencesByAssetId = node.data.editReferencesByAssetId && Object.fromEntries(
      Object.entries(node.data.editReferencesByAssetId).map(([id, refs]) => [id, filter(refs)!]),
    );
    if (!nodeChanged) return [node];
    changed = true;
    return [{ ...node, data: { ...node.data, attachedReferences, referenceAssetIds, videoMasterClips, editReferencesByAssetId,
      ...(identityGroupChanged ? { imageUrl: `/api/assets/${encodeURIComponent(referenceAssetIds![0])}`, subtitle: `${referenceAssetIds!.length} selected reference${referenceAssetIds!.length === 1 ? "" : "s"}` } : {}),
    } }];
  });
  if (!changed) return graph;
  return { ...graph, nodes, edges: graph.edges.filter((edge) => !removedNodes.has(edge.source) && !removedNodes.has(edge.target)) };
}
