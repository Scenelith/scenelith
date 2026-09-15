import type { FrameNode, GeneratorInputRole } from "@/lib/types";

export type AutomationReferenceAsset = {
  id: string;
  persona_id: string | null;
  persona_name: string | null;
  role: string | null;
};

/** Use the recorded request, never the identity's current selection or full library. */
export function automationCanvasReferences(
  item: { referenceAssetIds: string[]; referenceRoles: string[]; referenceLabels: string[] },
  assets: AutomationReferenceAsset[],
  connectedSourceAssetId?: string,
): NonNullable<FrameNode["data"]["attachedReferences"]> {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return item.referenceAssetIds.flatMap((assetId, index) => {
    const role = item.referenceRoles[index] as GeneratorInputRole;
    // The source already appears through its visible input connection.
    if (assetId === connectedSourceAssetId && role === "reference-image") return [];
    const asset = byId.get(assetId);
    const variant = asset?.role === "before" || asset?.role === "after" || asset?.role === "reference" ? asset.role : undefined;
    const label = item.referenceLabels[index];
    return [{
      assetId,
      url: `/api/assets/${encodeURIComponent(assetId)}`,
      thumbnailUrl: `/api/assets/${encodeURIComponent(assetId)}?variant=thumbnail`,
      title: asset?.persona_name ? `${asset.persona_name} · ${variant || "reference"} · ${label}` : label,
      ...(asset?.persona_id ? { personaId: asset.persona_id } : {}),
      ...(variant ? { variant } : {}),
      role,
    }];
  });
}
