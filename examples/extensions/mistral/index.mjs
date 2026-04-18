/**
 * Example provider extension — registers Mistral as an LLM provider
 * via the ProviderRegistry hook added in ADR-0025 Phase 2.
 *
 * To use this extension in a murmuration:
 *   1. Copy this directory to `<root>/extensions/mistral/`
 *   2. Install `@ai-sdk/mistral` (e.g. `pnpm add @ai-sdk/mistral`
 *      at the murmuration root, or ship it as a dep of your own
 *      distribution extension)
 *   3. Add `MISTRAL_API_KEY=...` to your `.env`
 *   4. Set `llm.provider: mistral` in `murmuration/harness.yaml` (or
 *      per-agent in `role.md` frontmatter)
 *
 * The extension reuses the same `registerProvider` API any other
 * provider does — Groq, Bedrock, xAI, Perplexity, Vertex AI, etc.
 * all follow the same pattern.
 */

/** @type {import('@murmurations-ai/core').ExtensionEntry} */
export default {
  id: "mistral-provider",
  name: "Mistral (via Vercel AI SDK)",
  description: "Registers Mistral models as an LLM provider.",

  register(api) {
    if (!api.registerProvider) {
      console.warn(
        "[mistral-provider] api.registerProvider unavailable — loader was not built with provider registration support",
      );
      return;
    }

    /** @type {import('@murmurations-ai/llm').ProviderDefinition} */
    const mistralDefinition = {
      id: "mistral",
      displayName: "Mistral",
      envKeyName: "MISTRAL_API_KEY",
      tiers: {
        fast: "mistral-small-latest",
        balanced: "mistral-large-latest",
        deep: "mistral-large-latest",
      },
      create: async ({ token, model, baseUrl }) => {
        const { createMistral } = await import("@ai-sdk/mistral");
        const mistral = createMistral({
          apiKey: token?.reveal() ?? "",
          ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
        });
        return mistral(model);
      },
    };

    api.registerProvider(mistralDefinition);
  },
};
