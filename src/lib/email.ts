import { baseUrl } from "@/lib/auth";
import { readInstanceSecret } from "@/platform/secrets";
import nodemailer from "nodemailer";

type EmailMessage = { to: string; subject: string; html: string; text: string; idempotencyKey?: string };

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | null = null;

function emailTransportKind() {
  const configured = String(process.env.EMAIL_TRANSPORT || "auto").toLowerCase();
  if (configured === "smtp" || configured === "resend" || configured === "noop") return configured;
  if (process.env.SMTP_HOST) return "smtp";
  if (readInstanceSecret("RESEND_API_KEY")) return "resend";
  return "noop";
}

export function emailDeliveryConfigured() {
  return emailTransportKind() !== "noop";
}

function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  const host = String(process.env.SMTP_HOST || "").trim();
  if (!host) throw new Error("SMTP_HOST is not configured");
  const user = String(process.env.SMTP_USER || "").trim();
  const password = readInstanceSecret("SMTP_PASSWORD");
  smtpTransport = nodemailer.createTransport({
    host,
    port: Math.max(1, Number(process.env.SMTP_PORT || 587)),
    secure: process.env.SMTP_SECURE === "true",
    auth: user ? { user, pass: password || "" } : undefined,
  });
  return smtpTransport;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] || character);
}

function layout(input: {
  preheader: string;
  eyebrow: string;
  title: string;
  copy: string;
  action?: { label: string; url: string };
  note?: string;
  details?: Array<{ label: string; value: string }>;
  points?: string[];
}) {
  const logoUrl = escapeHtml(`${baseUrl()}/scenelith-mark-email.png`);
  const actionUrl = input.action ? escapeHtml(input.action.url) : "";
  const button = input.action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0"><tr><td style="border-radius:10px;background:#72ddb7"><a href="${actionUrl}" style="display:inline-block;padding:14px 22px;color:#080809;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;line-height:1;text-decoration:none">${escapeHtml(input.action.label)}&nbsp;&nbsp;→</a></td></tr></table>`
    : "";
  const details = input.details?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0;border-top:1px solid #2d2d31">${input.details.map((detail) => `<tr><td style="padding:13px 0;border-bottom:1px solid #232326;color:#686864;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.4;text-transform:uppercase;letter-spacing:.08em">${escapeHtml(detail.label)}</td><td align="right" style="padding:13px 0;border-bottom:1px solid #232326;color:#c5c4bf;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:650;line-height:1.4">${escapeHtml(detail.value)}</td></tr>`).join("")}</table>`
    : "";
  const points = input.points?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:25px 0 0">${input.points.map((point) => `<tr><td width="26" valign="top" style="padding:0 0 12px"><span style="display:inline-block;width:18px;height:18px;border:1px solid #414147;border-radius:99px;color:#72ddb7;font-family:Arial,sans-serif;font-size:11px;line-height:18px;text-align:center">✓</span></td><td valign="top" style="padding:1px 0 12px;color:#92918d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.45">${escapeHtml(point)}</td></tr>`).join("")}</table>`
    : "";
  const fallback = input.action
    ? `<p style="margin:24px 0 0;color:#686864;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.55">Button not working? Copy this secure link:<br><a href="${actionUrl}" style="color:#92918d;text-decoration:none;word-break:break-all">${actionUrl}</a></p>`
    : "";
  const note = input.note
    ? `<p style="margin:22px 0 0;padding:15px 16px;border-left:2px solid #72ddb7;background:#19191b;color:#92918d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55">${escapeHtml(input.note)}</p>`
    : "";

  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escapeHtml(input.title)}</title></head><body style="margin:0;padding:0;background:#0b0b0c;color:#f1f0ec"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0b0b0c"><tr><td align="center" style="padding:38px 16px 46px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px"><tr><td style="padding:0 4px 23px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td><img src="${logoUrl}" width="34" height="34" alt="Scenelith" style="display:inline-block;width:34px;height:34px;border:0;vertical-align:middle"><span style="display:inline-block;margin-left:11px;color:#f1f0ec;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:.16em;vertical-align:middle">SCENELITH</span></td><td align="right" style="color:#686864;font-family:Menlo,Consolas,monospace;font-size:9px;letter-spacing:.09em">CONNECTED WORKSPACE</td></tr></table></td></tr><tr><td><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="9" style="border-top:1px solid #72ddb7"></td><td width="7" style="font-size:0;line-height:0"><span style="display:block;width:5px;height:5px;margin:-3px 1px 0;border:1px solid #72ddb7;border-radius:99px;background:#0b0b0c"></span></td><td style="border-top:1px solid #2d2d31"></td><td width="7" style="font-size:0;line-height:0"><span style="display:block;width:5px;height:5px;margin:-3px 1px 0;border:1px solid #414147;border-radius:99px;background:#0b0b0c"></span></td><td width="74" style="border-top:1px solid #2d2d31"></td></tr></table></td></tr><tr><td style="padding:39px 38px 36px;border:1px solid #2d2d31;border-top:0;border-radius:0 0 18px 18px;background:#151516"><p style="margin:0 0 15px;color:#72ddb7;font-family:Menlo,Consolas,monospace;font-size:10px;font-weight:750;line-height:1;letter-spacing:.12em">${escapeHtml(input.eyebrow)}</p><h1 style="margin:0;color:#f1f0ec;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:32px;font-weight:720;line-height:1.08;letter-spacing:-.035em">${escapeHtml(input.title)}</h1><p style="margin:18px 0 0;color:#92918d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65">${escapeHtml(input.copy)}</p>${details}${points}${button}${note}${fallback}</td></tr><tr><td style="padding:20px 4px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="color:#686864;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5">Scenelith · Connected visual workflows</td><td align="right" style="color:#686864;font-family:Menlo,Consolas,monospace;font-size:9px;letter-spacing:.06em">SECURE TRANSACTIONAL EMAIL</td></tr></table></td></tr></table></td></tr></table></body></html>`;
}

export async function sendEmail(message: EmailMessage) {
  const from = process.env.EMAIL_FROM || "Scenelith <account@noreply.scenelith.com>";
  const transport = emailTransportKind();
  if (transport === "noop") return { ok: false as const, error: "Email delivery is not configured" };
  if (transport === "smtp") {
    try {
      const result = await getSmtpTransport().sendMail({ from, to: message.to, subject: message.subject, html: message.html, text: message.text });
      return { ok: true as const, id: String(result.messageId || "") };
    } catch (error) {
      console.error("SMTP email failed", error instanceof Error ? error.message : String(error));
      return { ok: false as const, error: "SMTP delivery failed" };
    }
  }
  const apiKey = readInstanceSecret("RESEND_API_KEY");
  if (!apiKey) return { ok: false as const, error: "RESEND_API_KEY is not configured" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}) },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Resend email failed", response.status, detail.slice(0, 500));
    return { ok: false as const, error: `Resend returned ${response.status}` };
  }
  const body = await response.json().catch(() => ({})) as { id?: string };
  return { ok: true as const, id: body.id || "" };
}

export function sendVerificationEmail(email: string, name: string, token: string) {
  const url = `${baseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const firstName = name.trim().split(/\s+/)[0] || "there";
  return sendEmail({
    to: email,
    subject: "Confirm your Scenelith email",
    html: layout({ preheader: "Confirm your email to finish setting up Scenelith.", eyebrow: "ACCOUNT / EMAIL VERIFICATION", title: "Confirm your email", copy: `Hi ${firstName}. One quick confirmation keeps your workspace and future team invitations tied to the right account.`, action: { label: "Confirm email", url }, note: "This secure link expires in 24 hours. If you did not create this account, you can safely ignore this message." }),
    text: `Hi ${firstName}. Confirm your Scenelith email: ${url}\n\nThis link expires in 24 hours.`,
  });
}

export function sendPasswordResetEmail(email: string, name: string, token: string) {
  const url = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const firstName = name.trim().split(/\s+/)[0] || "there";
  return sendEmail({
    to: email,
    subject: "Reset your Scenelith password",
    html: layout({ preheader: "Use this secure link to reset your Scenelith password.", eyebrow: "ACCOUNT / PASSWORD RESET", title: "Reset your password", copy: `Hi ${firstName}. Use the secure link below to choose a new password and return to your workspace.`, action: { label: "Reset password", url }, note: "This link expires in 30 minutes and works once. If you did not request a reset, no action is needed." }),
    text: `Hi ${firstName}. Reset your Scenelith password: ${url}\n\nThis link expires in 30 minutes and can only be used once.`,
  });
}

export function sendPasswordChangedEmail(email: string, name: string) {
  const firstName = name.trim().split(/\s+/)[0] || "there";
  return sendEmail({
    to: email,
    subject: "Your Scenelith password was changed",
    html: layout({ preheader: "Your Scenelith password was changed.", eyebrow: "ACCOUNT / SECURITY", title: "Password changed", copy: `Hi ${firstName}. The password for your Scenelith account was changed successfully.`, details: [{ label: "Account", value: email }], note: "If this was not you, request another password reset immediately and secure your email account." }),
    text: `Hi ${firstName}. Your Scenelith password was changed successfully. If this was not you, request another password reset immediately.`,
  });
}

export function sendTeamInvitationEmail(input: { email: string; inviterEmail: string; workspaceName: string; token: string; invitationId: string; attempt: number }) {
  const url = `${baseUrl()}/invite/${encodeURIComponent(input.token)}`;
  const inviter = input.inviterEmail.split("@", 1)[0]?.trim() || "A teammate";
  return sendEmail({
    to: input.email,
    subject: `${inviter} invited you to join ${input.workspaceName}`,
    html: layout({
      preheader: `${inviter} invited you to join the ${input.workspaceName} project on Scenelith.`,
      eyebrow: "PROJECT / TEAM INVITATION",
      title: `Join ${input.workspaceName}`,
      copy: `${inviter} invited you to join the ${input.workspaceName} project on Scenelith. Accept with this email address to connect your account.`,
      details: [{ label: "Project", value: input.workspaceName }, { label: "Invited by", value: inviter }, { label: "Access", value: "Team member" }],
      points: ["Shared canvases, identities and hooks", "Shared generation credit pool", "Your own secure Scenelith login"],
      action: { label: "Accept invitation", url },
      note: `This invitation expires in 7 days. The secure link creates your team login and can be used once. If you lose it before joining, ask ${inviter} to resend the invitation.`,
    }),
    text: `${inviter} invited you to join the ${input.workspaceName} project on Scenelith.\n\nAccept the invitation: ${url}\n\nThis invitation expires in 7 days. The secure link creates your team login and can be used once. If you lose it before joining, ask ${inviter} to resend the invitation.`,
    idempotencyKey: `team-invite-${input.invitationId}-${input.attempt}`,
  });
}
