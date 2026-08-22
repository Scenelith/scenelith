import { z } from "zod";

// Older persisted canvases use stable slug ids while newer canvases use UUIDs.
// API routes must accept both forms and leave ownership to userCanAccessProject.
export const persistedProjectIdSchema = z.string().trim().min(1).max(160);
