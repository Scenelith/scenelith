import AuthRecoveryForm from "@/components/ui/auth-recovery-form";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <AuthRecoveryForm mode="reset" token={token} />;
}
