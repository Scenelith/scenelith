"use client";

import { useEffect, useState, type ComponentType } from "react";
import { ArrowRight } from "lucide-react";
import AuthCanvasPreview from "@/components/ui/auth-canvas-preview";
import AuthCredentialsPanel, { type AuthRegistrationCopy } from "@/components/ui/auth-credentials-panel";
import BrandMark from "@/components/BrandMark";
import type { AuthPageProps } from "@/editions/contracts/client";

const workflowMoments = [
  { stage: "Import", text: "Paste a TikTok link. Scenelith reads the slideshow and keeps the source intact." },
  { stage: "Slides", text: "Every imported image becomes its own connected, reusable canvas node." },
  { stage: "Identity", text: "Connect the original composition and a saved identity to one image generator." },
  { stage: "Generate", text: "Replace the subject while preserving the original pose, framing, and scene." },
];

type RegistrationConsentProps = {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
};

type AuthSectionTwoProps = AuthPageProps & {
  previewMedia: (asset: string) => string;
  registrationCopy: AuthRegistrationCopy;
  AuthRecoveryLink?: ComponentType;
  RegistrationConsent?: ComponentType<RegistrationConsentProps>;
};

export default function AuthSectionTwo({ previewMedia, registrationCopy, AuthRecoveryLink, RegistrationConsent, ...props }: AuthSectionTwoProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [cycleRevision, setCycleRevision] = useState(0);
  const googleEnabled = Boolean(props.providerSettings.googleLoginConfigured);

  useEffect(() => {
    const interval = window.setInterval(() => setActiveIndex((current) => (current + 1) % workflowMoments.length), 3200);
    return () => window.clearInterval(interval);
  }, [cycleRevision]);

  function showStep(index: number) {
    setActiveIndex(index);
    setCycleRevision((revision) => revision + 1);
  }

  return (
    <main className="auth-v2-page">
      <section className="auth-v2-showcase">
        <div className="auth-v2-showcase-inner">
          <div className="auth-v2-wordmark"><BrandMark />SCENELITH</div>
          <AuthCanvasPreview activeStep={activeIndex} mediaUrl={previewMedia} />
          <div className="auth-v2-prompt">
            <div className="auth-v2-flow-copy">
              <div className="auth-v2-flow-label"><span>0{activeIndex + 1}</span><b>{workflowMoments[activeIndex].stage}</b></div>
              <p>{workflowMoments[activeIndex].text}</p>
            </div>
            <button type="button" onClick={() => showStep((activeIndex + 1) % workflowMoments.length)} aria-label="Show next workflow step"><ArrowRight size={17} /></button>
          </div>
          <h2>From source to final output.<br />Everything stays connected.</h2>
          <div className="auth-v2-dots">{workflowMoments.map((item, index) => <button key={item.stage} type="button" className={index === activeIndex ? "is-active" : ""} onClick={() => showStep(index)} aria-label={`Show ${item.stage} workflow step`} />)}</div>
        </div>
      </section>

      <section className="auth-v2-form-side">
        <AuthCredentialsPanel
          {...props}
          registrationCopy={registrationCopy}
          signInLead="Continue building in your private creative graph."
          securityCopy="Protected with isolated workspaces, hashed passwords and secure server sessions."
          socialAction={{
            enabled: googleEnabled,
            href: `/api/auth/google?next=${encodeURIComponent(props.returnTo)}`,
            icon: <GoogleIcon />,
            label: "Continue with Google",
            lastUsed: props.lastAuthMethod === "google",
            unavailableError: "Google sign-in is not configured yet",
          }}
          AuthRecoveryLink={AuthRecoveryLink}
          RegistrationConsent={RegistrationConsent}
        />
      </section>
    </main>
  );
}

function GoogleIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853"/><path d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.74.13-1.44.35-2.1V7.06H2.18A10.98 10.98 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" fill="#EB4335"/></svg>;
}
