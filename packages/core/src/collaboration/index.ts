/**
 * @murmurations-ai/core — Collaboration provider abstraction (ADR-0021).
 *
 * Re-exports the interface, types, errors, and built-in providers.
 */

export type {
  CollaborationProvider,
  CollaborationItem,
  ItemRef,
  ItemFilter,
  ItemState,
  CommentRef,
  ArtifactRef,
  CollabResult,
  CollaborationErrorCode,
} from "./types.js";

export { CollaborationError } from "./types.js";

export { GitHubCollaborationProvider } from "./github-provider.js";
export { LocalCollaborationProvider } from "./local-provider.js";
