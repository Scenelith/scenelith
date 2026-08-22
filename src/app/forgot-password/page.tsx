import { redirect } from "next/navigation";
import AuthRecoveryForm from "@/components/ui/auth-recovery-form";
import { isAuthenticated } from "@/lib/auth";

export default async function ForgotPasswordPage() {
  if (await isAuthenticated()) redirect("/canvas");
  return <AuthRecoveryForm mode="forgot" />;
}
