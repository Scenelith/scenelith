import { AutomationPermissionError } from "./permissions";

export function automationApiErrorResponse(error: unknown, fallback: string, fallbackStatus = 422) {
  if (error instanceof AutomationPermissionError) {
    return Response.json({ error: error.message, code: error.code, permission: error.permission }, { status: 403 });
  }
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: fallbackStatus });
}
