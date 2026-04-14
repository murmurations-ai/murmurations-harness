/**
 * Re-export DaemonCommandExecutor from @murmurations-ai/core.
 *
 * The executor was moved to packages/core/src/daemon/command-executor.ts
 * per Engineering Standard #8 (composition root stays thin) and
 * architecture review finding #87. This re-export maintains backward
 * compatibility for imports from the CLI package.
 */
export {
  DaemonCommandExecutor,
  type CommandExecutorDeps,
  type MeetingStatus,
  type WakeProcessStatus,
  type MeetingGithubClient,
  type DirectiveHandler,
  type GroupWakeHandler,
  type WakeNowHandler,
} from "@murmurations-ai/core";
