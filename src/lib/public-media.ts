const publicMediaBase = (process.env.NEXT_PUBLIC_MEDIA_BASE_URL || "").replace(/\/$/, "");

export function landingMedia(path: string) {
  if (!publicMediaBase) return "/scenelith-mark-email.png";
  return `${publicMediaBase}/landing/auth-demo/${path.replace(/^\/+/, "")}`;
}
