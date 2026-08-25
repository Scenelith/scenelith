"use client";

import BrandMark from "@/components/BrandMark";
import AuthCredentialsPanel from "@/components/ui/auth-credentials-panel";
import type { AuthPageProps } from "@/editions/contracts/client";

export default function SelfhostAuthPage(props: AuthPageProps) {
  return (
    <main className="selfhost-auth-page">
      <section className="selfhost-auth-shell" aria-labelledby="selfhost-auth-title">
        <header className="selfhost-auth-brand">
          <span className="selfhost-auth-mark"><BrandMark /></span>
          <span><b>SCENELITH</b><small>SELF-HOSTED</small></span>
        </header>
        <div className="selfhost-auth-card">
          <span className="selfhost-auth-kicker">PRIVATE INSTANCE</span>
          <div id="selfhost-auth-title" className="selfhost-auth-title">Local access</div>
          <AuthCredentialsPanel
            {...props}
            registrationCopy={{
              title: "Create the owner account",
              lead: "This first account owns the instance. No email verification or external identity provider is required.",
              emailLabel: "Local email",
              submitLabel: "Create owner account",
              hideSocialRegistration: true,
            }}
            signInLead="Sign in with the local account stored on this instance."
            securityCopy="Passwords are hashed and sessions are created by this server. Provider keys never enter the browser."
          />
        </div>
        <footer className="selfhost-auth-foot">
          <span aria-hidden="true" />
          <p>Authentication and creative data stay on infrastructure controlled by the instance operator.</p>
        </footer>
      </section>
    </main>
  );
}
