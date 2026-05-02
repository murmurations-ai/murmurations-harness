/**
 * @murmurations-ai/llm/pricing
 *
 * Per-provider pricing catalog subpath. See
 * `docs/adr/0015-pricing-catalog.md`.
 */

export { SEED_CATALOG } from "./catalog.js";
export type { ProviderRate } from "./catalog.js";

export {
  isSubscriptionCliProvider,
  resolveLLMCost,
  resolveLLMCostWith,
  resolveShadowApiCost,
} from "./resolve.js";
export type {
  PricingCatalogError,
  PricingCatalogErrorCode,
  ResolveLLMCostInput,
} from "./resolve.js";
