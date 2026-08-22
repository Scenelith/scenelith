"use client";

import type { EditionClient } from "@/editions/contracts/client";

export const editionClient: EditionClient = Object.freeze({
  accountMenuPresentation(usage) {
    return {
      subtitle: `${usage.profileName} · Your provider keys`,
      summaryLabel: "INSTANCE",
      summaryValue: usage.profileName,
    };
  },
  registrationCopy() {
    return {
      title: "Create your workspace",
      lead: "Your canvases, identities and assets stay private to your account.",
      emailLabel: "Email",
      submitLabel: "Create account",
      hideSocialRegistration: false,
    };
  },
  railItems: [],
});
