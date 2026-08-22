export function referenceMentionToken(title: string, index: number) {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return `@${slug || "reference"}_${index + 1}`;
}

export function editReferenceMentionToken(title: string, assetId: string) {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "reference";
  let hash = 2166136261;
  for (const character of assetId) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return `@${slug}_${(hash >>> 0).toString(36).slice(0, 4)}`;
}

export function appendEditReferenceMention(current: string, title: string, assetId: string) {
  const token = editReferenceMentionToken(title, assetId);
  return `${current}${current && !/\s$/u.test(current) ? " " : ""}${token}`;
}
