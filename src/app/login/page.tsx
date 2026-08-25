import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AuthPage } from "@/editions/current/client";
import { isAuthenticated, LAST_AUTH_METHOD_COOKIE, safeReturnTo } from "@/lib/auth";
import { db } from "@/lib/postgres-db";
import { readRuntimeConfig } from "@/platform/runtime-config";
import { editionServer } from "@/editions/current/server";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(typeof params.next === "string" ? params.next : undefined);
  if (await isAuthenticated()) redirect(returnTo);
  const lastAuthMethod = (await cookies()).get(LAST_AUTH_METHOD_COOKIE)?.value;
  const runtimeConfig = readRuntimeConfig();
  const accountCount = runtimeConfig.registrationMode === "open"
    ? 0
    : Number((await db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count);
  const distributionAuth = editionServer.authPageContext(params);
  const registrationEnabled = distributionAuth.registrationOverride || runtimeConfig.registrationMode === "open" || accountCount === 0;
  return <AuthPage registrationEnabled={registrationEnabled} initialMode={registrationEnabled && params.mode === "register" ? "register" : "login"} initialEmail={distributionAuth.initialEmail} registrationVariant={distributionAuth.registrationVariant} lockRegistrationEmail={distributionAuth.lockEmail} lastAuthMethod={lastAuthMethod || null} initialError={distributionAuth.error} initialNotice={distributionAuth.notice} returnTo={returnTo} providerSettings={editionServer.authProviderSettings()} />;
}
