const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const WEBM_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3] as const;

const ISO_BASED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v"]);

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.byteLength >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  if (bytes.byteLength < start + length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasIsoFileTypeBox(bytes: Uint8Array) {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const boxSize = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    const boxType = ascii(bytes, offset + 4, 4);
    if (boxType === "ftyp" && boxSize >= 8) return true;
    if (boxSize < 8 || offset + boxSize > bytes.byteLength) return false;
    offset += boxSize;
  }
  return false;
}

function hasWebpHeader(bytes: Uint8Array) {
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

export function mediaContentMatchesMime(bytes: Uint8Array, declaredMimeType: string) {
  const mimeType = declaredMimeType.toLowerCase().split(";", 1)[0].trim();
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return startsWith(bytes, JPEG_SIGNATURE);
  if (mimeType === "image/png") return startsWith(bytes, PNG_SIGNATURE);
  if (mimeType === "image/webp") return hasWebpHeader(bytes);
  if (mimeType === "video/webm") return startsWith(bytes, WEBM_SIGNATURE);
  if (ISO_BASED_VIDEO_TYPES.has(mimeType)) {
    // MP4, M4V and modern MOV files are ISO Base Media containers. A small
    // `free`/`wide` box may precede the required file-type box.
    return hasIsoFileTypeBox(bytes);
  }
  return false;
}
