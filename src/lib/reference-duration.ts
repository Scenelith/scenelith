export type ReferenceDurationMode = "reference" | "fixed";
type TimedReference = {role?: string; durationSeconds?: number};
export function followsReferenceDuration(modelId: string, mode?: ReferenceDurationMode) {
  return (modelId === "wan-3" || modelId === "wan-3-prime") && mode === "reference";
}
/** Wan accepts whole output seconds. Like Reviral, round up to cover the
 * selected source, with a 2s minimum and a 15s reference budget. */
export function referenceDurationSettings<T extends TimedReference>(modelId: string, references: T[], fixedDuration: string, mode?: ReferenceDurationMode) {
  const videos = references.filter(ref => ref.role === "reference-video" || ref.role === "motion-video");
  const active = followsReferenceDuration(modelId, mode) && videos.length > 0;
  const preparedReferences = active && videos.length === 1
    ? references.map(ref => videos.includes(ref) && Number(ref.durationSeconds) > 15 ? {...ref, durationSeconds: 15} : ref)
    : references;
  const seconds = preparedReferences.filter(ref => ref.role === "reference-video" || ref.role === "motion-video").reduce((sum, ref) => sum + Math.max(0, Number(ref.durationSeconds) || 0), 0);
  return {active, references: preparedReferences, seconds, duration: active && seconds > 0 ? String(Math.min(15, Math.max(2, Math.ceil(seconds - .000001)))) : fixedDuration};
}
