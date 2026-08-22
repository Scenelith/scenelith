export type AssistantUsagePolicy = {
  metered: boolean;
  description: string;
};

/** Self-hosted users pay their configured provider directly. */
export function assistantUsagePolicy(_modelId: string): AssistantUsagePolicy {
  return { metered: false, description: "Provider-billed" };
}
