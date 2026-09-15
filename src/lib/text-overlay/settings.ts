import { z } from "zod";

export const textOverlaySettingsSchema = z.object({
  x: z.number().finite().min(0).max(100).default(50),
  y: z.number().finite().min(0).max(100).default(50),
  fontSize: z.number().finite().min(0).max(300).default(0),
  sizeScale: z.number().finite().min(0.25).max(3).default(1),
  maxWidth: z.number().finite().min(10).max(100).default(90),
  lineHeight: z.number().finite().min(1).max(3).default(80 / 66.37931561026407),
  stroke: z.number().finite().min(0).max(20).default(4.5),
  transparent: z.boolean().default(false),
}).strict();
export type TextOverlaySettings = z.infer<typeof textOverlaySettingsSchema>;

