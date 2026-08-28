export const GENERATION_REFERENCE_ROLES = [
  "source composition",
  "identity",
  "location",
  "pose",
  "outfit",
  "style",
  "product",
  "supporting visual",
] as const;

export type GenerationReferenceRole = typeof GENERATION_REFERENCE_ROLES[number];

export const AUTOMATION_SOURCE_REFERENCE_INSTRUCTION = "Use this source slide only for composition, framing, pose, camera relationship and per-slide scene evidence. Never copy this source person's identity. Follow the preserve and change arrays exactly for wardrobe, location and text.";
export const AUTOMATION_IDENTITY_REFERENCE_INSTRUCTION = "Use only for stable face, hair and physical identity. Do not copy pose, framing, wardrobe, clothing, jewelry, makeup, location, background, lighting, composition or visual style.";
export const AUTOMATION_NO_TEXT_AVOID_INSTRUCTION = "No captions, words, letters, numbers, logos, watermark-like typography or replacement text.";

export type ImageGenerationPromptContract = {
  title: string;
  task: string;
  reference_plan: Array<{
    token: string;
    title: string;
    role: string;
    instruction: string;
  }>;
  subject: {
    identity: string;
    appearance: string[];
    pose: string;
    expression: string;
  };
  scene: {
    environment: string;
    composition: string;
    lighting: string;
    camera: string;
  };
  preserve: string[];
  change: string[];
  avoid: string[];
  output: {
    format: string;
    style: string;
  };
};

export const imageGenerationPromptJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 100 },
    task: { type: "string", maxLength: 420 },
    reference_plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          token: { type: "string" },
          title: { type: "string" },
          role: { type: "string" },
          instruction: { type: "string" },
        },
        required: ["token", "title", "role", "instruction"],
        additionalProperties: false,
      },
    },
    subject: {
      type: "object",
      properties: {
        identity: { type: "string" },
        appearance: { type: "array", items: { type: "string" } },
        pose: { type: "string" },
        expression: { type: "string" },
      },
      required: ["identity", "appearance", "pose", "expression"],
      additionalProperties: false,
    },
    scene: {
      type: "object",
      properties: {
        environment: { type: "string" },
        composition: { type: "string" },
        lighting: { type: "string" },
        camera: { type: "string" },
      },
      required: ["environment", "composition", "lighting", "camera"],
      additionalProperties: false,
    },
    preserve: { type: "array", items: { type: "string" } },
    change: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
    output: {
      type: "object",
      properties: { format: { type: "string" }, style: { type: "string" } },
      required: ["format", "style"],
      additionalProperties: false,
    },
  },
  required: ["title", "task", "reference_plan", "subject", "scene", "preserve", "change", "avoid", "output"],
  additionalProperties: false,
} as const;

export function serializeImageGenerationPrompt(contract: ImageGenerationPromptContract) {
  return JSON.stringify(contract, null, 2);
}
