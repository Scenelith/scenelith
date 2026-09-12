import sharp from "sharp";
import { extname } from "node:path";
import { newKieModel, type ModelReference } from "./kie-new-models";
import { readStorageObject } from "./storage";
import { probeVideoMetadata } from "./media-probe";

/** Old uploads may lack duration/dimensions. Measure the actual stored media
 * before admission, rather than making up a trim range or skipping limits. */
export async function prepareNewKieReferences<T extends ModelReference & { path: string; mimeType: string }>(modelId: string, references: T[]): Promise<T[]> {
  if (!newKieModel(modelId)) return references;
  return Promise.all(references.map(async (reference) => {
    const wan = modelId.startsWith("wan-3");
    const image = reference.mimeType.startsWith("image/");
    const video = reference.mimeType.startsWith("video/");
    const needsDimensions = wan && (image || video) && (!reference.width || !reference.height || (image && reference.hasAlpha === undefined));
    const needsDuration = (wan || modelId.startsWith("gemini-omni")) && !image && !reference.durationSeconds;
    if (reference.sizeBytes && !needsDimensions && !needsDuration) return reference;
    const bytes = await readStorageObject(reference.path);
    const bitmap = ["image/bmp", "image/x-ms-bmp"].includes(reference.mimeType);
    if (image && needsDimensions && !bitmap) {
      const metadata = await sharp(bytes).metadata();
      const transparent = metadata.hasAlpha ? !(await sharp(bytes).stats()).isOpaque : false;
      return { ...reference, sizeBytes: bytes.byteLength, width: metadata.width, height: metadata.height, hasAlpha: transparent };
    }
    const metadata = needsDuration || needsDimensions ? await probeVideoMetadata(bytes, extname(reference.path)) : {};
    return { ...reference, ...metadata, ...(bitmap ? { hasAlpha: false } : {}), sizeBytes: bytes.byteLength };
  }));
}
