import type { ModelReference } from "./kie-new-models";

export const isKling4 = (id: string) => id === "kling-4-reference" || id === "kling-4-keyframe";

/** KIE resolves mentions against submitted field names, not Canvas aliases. */
export function kling4ReferenceNames(id: string, refs: ModelReference[]) {
  const counts: Record<string, number> = {};
  return refs.map(ref => {
    const role = ref.role || "reference-image";
    if (id === "kling-4-keyframe" && role === "start-frame") return "@first_frame";
    if (id === "kling-4-keyframe" && role === "end-frame") return "@last_frame";
    const kind = id === "kling-4-keyframe" ? "keyframe" : role === "reference-video" ? "video" : role === "reference-audio" ? "voice" : "image";
    counts[kind] = (counts[kind] || 0) + 1;
    return `@${kind}_${counts[kind]}`;
  });
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function kling4Prompt(id: string, prompt: string, refs: ModelReference[]) {
  const names = kling4ReferenceNames(id, refs);
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  refs.forEach((ref, index) => {
    if (!ref.label) return;
    const alias = ref.label.startsWith("@") ? ref.label : `@${ref.label}`;
    if (names.includes(alias)) return;
    if (aliases.has(alias) && aliases.get(alias) !== names[index]) ambiguous.add(alias);
    aliases.set(alias, names[index]);
  });
  const pattern = [...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
  let error: string | null = null;
  const rewritten = (pattern ? prompt.replace(new RegExp(`(?:${pattern})(?![A-Za-z0-9_])`, "g"), alias => {
    if (ambiguous.has(alias)) error = `reference ${alias} is ambiguous; use the numbered reference name`;
    return aliases.get(alias)!;
  }) : prompt).trim();
  const declared = names.toSorted((a, b) => b.length - a.length);
  for (const match of rewritten.matchAll(/@/g)) {
    const tail = rewritten.slice(match.index);
    if (!declared.some(name => tail.startsWith(name) && !/[A-Za-z0-9_]/.test(tail[name.length] || ""))) {
      error ||= `mention ${tail.match(/^@[^\s,.;:!?"'(){}\[\]]*/)?.[0] || "@"} does not match a connected reference`;
    }
  }
  return { prompt: rewritten, error };
}

export function kling4InputError(id: string, input: { prompt: string; references: ModelReference[]; duration?: string }, allowUnmeasuredMedia = false) {
  const refs = input.references;
  if (id === "kling-4-keyframe") {
    const maxFrames = Math.min(10, Number(input.duration || 5) + 1);
    if (refs.length > maxFrames) return `at ${input.duration || 5}s use at most ${maxFrames} total frames; choose a longer duration or disconnect frames`;
  }
  for (const ref of refs) {
    const video = ref.role === "reference-video";
    const image = !video && ref.role !== "reference-audio";
    if (ref.mimeType && video && !["video/mp4", "video/quicktime", "video/x-matroska", "video/x-msvideo", "video/webm"].includes(ref.mimeType.toLowerCase())) return "reference video has an unsupported file format";
    if (image && id === "kling-4-reference" && ref.width && ref.height && (Math.min(ref.width, ref.height) < 300 || Math.max(ref.width, ref.height) > 65536 || ref.width / ref.height < .4 || ref.width / ref.height > 2.5)) return "reference images need sides of 300–65536 pixels and an aspect ratio of 0.4–2.5";
    if (video && !(allowUnmeasuredMedia && !ref.durationSeconds) && (!Number.isFinite(ref.durationSeconds) || ref.durationSeconds! < 2 || ref.durationSeconds! > 30)) return "each reference video needs a measured duration of 2–30s";
  }
  return kling4Prompt(id, input.prompt, refs).error;
}
