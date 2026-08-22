import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import AuthSectionTwo from "@/components/ui/auth-section-2";
import { isAuthenticated, LAST_AUTH_METHOD_COOKIE, safeReturnTo } from "@/lib/auth";
import { db } from "@/lib/postgres-db";
import { readRuntimeConfig } from "@/platform/runtime-config";
import { distributionAuthPageContext } from "@/distribution/auth-server-extension";

const oauthErrors: Record<string, string> = {
  google_unavailable: "Google sign-in is not configured yet",
  google_state: "Google sign-in expired. Please try again.",
  google_exchange: "Google could not complete sign-in",
  google_profile: "Google did not return a verified email",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; reset?: string; mode?: string; next?: string; email?: string; invite?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.next);
  if (await isAuthenticated()) redirect(returnTo);
  const lastAuthMethod = (await cookies()).get(LAST_AUTH_METHOD_COOKIE)?.value;
  const runtimeConfig = readRuntimeConfig();
  const accountCount = runtimeConfig.registrationMode === "open"
    ? 0
    : Number((await db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count);
  const distributionAuth = distributionAuthPageContext(params);
  const registrationEnabled = distributionAuth.invitationRegistration || runtimeConfig.registrationMode === "open" || accountCount === 0;
  return <AuthSectionTwo registrationEnabled={registrationEnabled} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)} initialMode={registrationEnabled && params.mode === "register" ? "register" : "login"} initialEmail={distributionAuth.initialEmail} invitationRegistration={distributionAuth.invitationRegistration} lastAuthMethod={lastAuthMethod === "google" ? "google" : lastAuthMethod === "email" ? "email" : null} initialError={distributionAuth.error || (params.error ? oauthErrors[params.error] || "Could not sign in" : "")} initialNotice={distributionAuth.notice} returnTo={returnTo} />;
}
