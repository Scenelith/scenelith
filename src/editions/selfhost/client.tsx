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
  railItems: [],
});
