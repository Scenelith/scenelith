/**
 * Scenelith generation credits mirror Kie.ai credits one-for-one.
 * Kie currently values one provider credit at $0.005. Fractional provider
 * charges are rounded up because workspace balances use whole credits.
 */

const imageCredits: Record<string, Record<string, number>> = {
  "nano-banana-2-lite": { "1K": 4 },
  "nano-banana-2": { "1K": 8, "2K": 12, "4K": 18 },
  "nano-banana-pro": { "1K": 18, "2K": 18, "4K": 24 },
  "gpt-image-2": { "1K": 6, "2K": 10, "4K": 16 },
  "grok-image-2": { "1K": 4 },
  "seedream-5-lite": { "2K": 5.5, "3K": 5.5, "4K": 5.5 },
  "seedream-5-pro": { "1K": 7, "2K": 14 },
  "flux-2-flex": { "1K": 14, "2K": 24 },
  "imagen4-fast": { "1K": 4 },
  "imagen4-ultra": { "1K": 12 },
};

const videoCreditsPerSecond: Record<string, Record<string, number>> = {
  "seedance-2-fast": { "480P": 15.5, "720P": 33 },
  "seedance-2-mini": { "480P": 9.5, "720P": 20.5 },
  "seedance-2": { "480P": 19, "720P": 41, "1080P": 102, "4K": 208 },
  "seedance-2-5": { "480P": 28, "720P": 63 },
  "kling-3-turbo-text": { "720P": 18, "1080P": 22.5 },
  "kling-3-turbo-image": { "720P": 18, "1080P": 22.5 },
  "kling-3-motion": { "720P": 20, "1080P": 27 },
  "grok-video-text": { "480P": 2.4, "720P": 4.5, "1080P": 8 },
  "grok-video-image": { "480P": 2.4, "720P": 4.5, "1080P": 8 },
  "grok-video-1-5": { "480P": 2.4, "720P": 4.5 },
  "wan-2-7": { "720P": 16, "1080P": 24 },
};

const seedanceWithVideoCreditsPerSecond: Record<string, Record<string, number>> = {
  "seedance-2-fast": { "480P": 9, "720P": 20 },
  "seedance-2-mini": { "480P": 6, "720P": 12.5 },
  "seedance-2": { "480P": 11.5, "720P": 25, "1080P": 62, "4K": 128 },
  "seedance-2-5": { "480P": 17, "720P": 38, "1080P": 68.5 },
};

const kling3CreditsPerSecond = {
  audio: { "720P": 20, "1080P": 27, "4K": 67 },
  silent: { "720P": 14, "1080P": 18, "4K": 67 },
};

const fixedVideoCredits: Record<string, Record<string, number>> = {
  "veo-3-1-fast": { "720P": 60, "1080P": 65, "4K": 180 },
  "veo-3-1": { "720P": 250, "1080P": 255, "4K": 380 },
};

const legacyAliases: Record<string, string> = {
  "nano-banana-pro-flash": "nano-banana-2",
  "flux-kontext-pro": "flux-2-flex",
  "flux-2-turbo": "flux-2-flex",
  "flux-2-klein": "flux-2-flex",
  "seedream-v4": "seedream-5-lite",
  "flux-2-pro": "flux-2-flex",
  "mystic-realism": "flux-2-flex",
  "wan-2-5-t2v-720p": "wan-2-7",
  "wan-2-5-i2v-1080p": "wan-2-7",
  "wan-2-7-i2v": "wan-2-7",
  "runway-4-5-i2v": "seedance-2-fast",
  "kling-v3-pro": "kling-3",
  "kling-v3-std": "kling-3",
};

function configuredValue(table: Record<string, number>, requested: string) {
  if (table[requested] !== undefined) return table[requested];
  const values = Object.values(table);
  if (!values.length) throw new Error("Credit pricing has no configured values");
  return Math.max(...values);
}

export type GenerationPricingOptions = {
  generateAudio?: boolean;
  hasVideoInput?: boolean;
  inputVideoDurationSeconds?: number;
};

export function generationCreditCost(modelId: string, resolution: string, duration: string, referenceCount = 0, options: GenerationPricingOptions = {}) {
  const canonicalId = legacyAliases[modelId] || modelId;
  const normalizedResolution = resolution.toUpperCase();
  const image = imageCredits[canonicalId];
  if (image) {
    let providerCredits = configuredValue(image, normalizedResolution);
    // Seedream 5 Pro includes the first input image; each additional input is
    // currently billed by Kie at 0.5 credit.
    if (canonicalId === "seedream-5-pro") providerCredits += Math.max(0, referenceCount - 1) * 0.5;
    return Math.ceil(providerCredits);
  }
  const fixedVideo = fixedVideoCredits[canonicalId];
  if (fixedVideo) {
    // Kie's Veo 3.1 Quality 4K image-to-video row is 370 credits, while the
    // text-to-video row is 380. Other Veo modes share the same fixed price.
    if (canonicalId === "veo-3-1" && normalizedResolution === "4K" && referenceCount > 0) return 370;
    return Math.ceil(configuredValue(fixedVideo, normalizedResolution));
  }
  const outputSeconds = Math.max(1, Number(duration) || 5);
  if (canonicalId === "seedance-2-5" && normalizedResolution === "1080P" && !options.hasVideoInput) {
    throw new Error("Seedance 2.5 1080P requires a video input");
  }
  if (canonicalId === "kling-3") {
    const rate = configuredValue(options.generateAudio !== false ? kling3CreditsPerSecond.audio : kling3CreditsPerSecond.silent, normalizedResolution);
    return Math.ceil(rate * outputSeconds);
  }
  if (canonicalId === "kling-3-motion") {
    const rate = configuredValue(videoCreditsPerSecond[canonicalId], normalizedResolution);
    const referenceVideoSeconds = Math.max(1, options.inputVideoDurationSeconds || outputSeconds);
    return Math.ceil(rate * referenceVideoSeconds);
  }
  const perSecond = options.hasVideoInput && seedanceWithVideoCreditsPerSecond[canonicalId]
    ? seedanceWithVideoCreditsPerSecond[canonicalId]
    : videoCreditsPerSecond[canonicalId];
  if (perSecond) {
    const billedSeconds = outputSeconds + (options.hasVideoInput ? Math.max(0, options.inputVideoDurationSeconds || 0) : 0);
    return Math.ceil(configuredValue(perSecond, normalizedResolution) * billedSeconds);
  }
  throw new Error("Credit pricing is not configured for this model");
}
