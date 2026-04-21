/**
 * DaemonCommandExecutor — extracted command handling, status building,
 * and detail handlers from boot.ts per Engineering Standard #8
 * (composition root stays thin).
 *
 * This class owns:
 * - Command dispatch (directive, group-wake, wake-now, stop)
 * - Status response building (/api/status)
 * - Agent/group detail queries (/api/agent/:id, /api/group/:id)
 * - In-flight meeting and wake-now process tracking
 */

import { readFileSync as fsReadFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { HARNESS_VERSION } from "../index.js";
import { PROTOCOL_SCHEMA_VERSION } from "./protocol.js";
import { GovernanceStateStore } from "../governance/index.js";
import type { GovernancePlugin, GovernanceSyncCallbacks } from "../governance/index.js";
import type { GovernanceTally } from "../groups/index.js";
import type { AgentStateStore } from "../agents/index.js";
import type { RegisteredAgent } from "./index.js";
import type { DaemonEventBus } from "./events.js";

// ---------------------------------------------------------------------------
// Meeting + wake-now in-flight tracking
// ---------------------------------------------------------------------------

export interface MeetingStatus {
  readonly groupId: string;
  readonly kind: string;
  readonly startedAt: string;
  status: "running" | "completed" | "failed";
  minutesUrl?: string | undefined;
  error?: string | undefined;
}

export interface WakeProcessStatus {
  readonly agentId: string;
  readonly pid: number;
  readonly startedAt: string;
  status: "running" | "completed" | "failed";
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Minimal GitHub client interface for meeting fetching. */
export interface MeetingGithubClient {
  listIssues(
    repo: { owner: string; repo: string },
    filter?: { state?: "open" | "closed" | "all"; labels?: readonly string[]; perPage?: number },
  ): Promise<
    | {
        ok: true;
        value: readonly {
          number: number;
          title: string;
          htmlUrl: string;
          state: string;
          labels: readonly string[];
          createdAt: Date;
        }[];
      }
    | { ok: false }
  >;
}

/** Callback for executing a Source directive. Injected by the CLI layer. */
export type DirectiveHandler = (args: readonly string[], rootDir: string) => Promise<void>;

/** Callback for running a group-wake. Injected by the CLI layer. */
export type GroupWakeHandler = (
  args: readonly string[],
  rootDir: string,
) => Promise<{
  meetingMinutesUrl?: string | undefined;
  receipts: readonly unknown[];
  tallies: readonly GovernanceTally[];
  totalInputTokens: number;
  totalOutputTokens: number;
}>;

/** Callback for spawning a wake-now child process. Injected by the CLI layer. */
export type WakeNowHandler = (rootDir: string, agentId: string) => Promise<{ pid: number }>;

export interface CommandExecutorDeps {
  readonly rootDir: string;
  readonly agentStateStore: AgentStateStore;
  readonly allRegistered: readonly RegisteredAgent[];
  readonly governancePlugin?: GovernancePlugin | undefined;
  readonly governancePersistDir: string;
  readonly governancePath?: string | undefined;
  readonly governanceSync?: GovernanceSyncCallbacks | undefined;
  readonly eventBus?: DaemonEventBus | undefined;
  readonly githubClient?: MeetingGithubClient | undefined;
  readonly repoCoordinate?: { owner: string; repo: string } | undefined;
  /** CollaborationProvider for directive list/delete (ADR-0021). */
  readonly collaborationProvider?:
    | import("../collaboration/types.js").CollaborationProvider
    | undefined;
  // Command handlers injected by CLI layer (keeps core free of CLI imports)
  readonly onDirective?: DirectiveHandler | undefined;
  readonly onGroupWake?: GroupWakeHandler | undefined;
  readonly onWakeNow?: WakeNowHandler | undefined;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class DaemonCommandExecutor {
  readonly #deps: CommandExecutorDeps;
  readonly #meetings = new Map<string, MeetingStatus>();
  readonly #wakeProcesses = new Map<string, WakeProcessStatus>();

  public constructor(deps: CommandExecutorDeps) {
    this.#deps = deps;
  }

  // -----------------------------------------------------------------------
  // Command dispatch
  // -----------------------------------------------------------------------

  public async execute(
    method: string,
    params: Record<string, unknown>,
    options?: { readonly readOnly?: boolean },
  ): Promise<unknown> {
    // Enforce mutating flag (#84) — read-only clients can't invoke mutating methods
    if (options?.readOnly) {
      const { getMethod } = await import("./protocol.js");
      const methodDef = getMethod(method);
      if (methodDef?.mutating) {
        throw new Error(`method "${method}" is mutating — not allowed in read-only mode`);
      }
    }
    switch (method) {
      case "directive":
        return this.#handleDirective(params);
      case "directive.list":
        return this.#handleDirectiveList();
      case "directive.close":
        return this.#handleDirectiveClose(params);
      case "directive.delete":
        return this.#handleDirectiveDelete(params);
      case "directive.path":
        return this.#handleDirectivePath(params);
      case "group-wake":
        return this.#handleGroupWake(params);
      case "wake-now":
        return this.#handleWakeNow(params);
      case "stop":
        process.kill(process.pid, "SIGTERM");
        return { stopping: true };
      // Read-only query methods
      case "agents.list":
        return this.#agentsList();
      case "agents.get": {
        const agentId = params.agentId as string | undefined;
        if (!agentId) throw new Error("agents.get requires an agentId");
        return this.agentDetail(agentId);
      }
      case "groups.list":
        return this.#groupsList();
      case "events.history":
        return this.#eventsHistory();
      case "cost.summary":
        return this.#costSummary();
      default:
        throw new Error(`unknown command: ${method}`);
    }
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  public async buildStatus(): Promise<unknown> {
    const { rootDir, agentStateStore, allRegistered } = this.#deps;

    // Reload from disk so wake-now child process writes are visible
    await agentStateStore.load().catch((err: unknown) => {
      process.stderr.write(
        `[command-executor] agentStateStore.load failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    const agents = agentStateStore.getAllAgents().map((a) => ({
      agentId: a.agentId,
      state: a.currentState,
      totalWakes: a.totalWakes,
      totalArtifacts: a.totalArtifacts,
      idleWakes: a.idleWakes,
      consecutiveFailures: a.consecutiveFailures,
      groups: allRegistered.find((r) => r.agentId === a.agentId)?.groupMemberships ?? [],
    }));

    const totalWakes = agents.reduce((s, a) => s + a.totalWakes, 0);
    const totalArtifacts = agents.reduce((s, a) => s + a.totalArtifacts, 0);
    const totalIdle = agents.reduce((s, a) => s + a.idleWakes, 0);

    const groupMap = new Map<string, typeof agents>();
    for (const a of agents) {
      for (const g of a.groups) {
        const list = groupMap.get(g) ?? [];
        list.push(a);
        groupMap.set(g, list);
      }
    }
    const groups = [...groupMap.entries()].map(([groupId, members]) => ({
      groupId,
      memberCount: members.length,
      totalWakes: members.reduce((s, m) => s + m.totalWakes, 0),
      totalArtifacts: members.reduce((s, m) => s + m.totalArtifacts, 0),
      idleWakes: members.reduce((s, m) => s + m.idleWakes, 0),
      members: members.map((m) => m.agentId),
    }));

    // Derive murmuration name and GitHub URL
    const firstScope = allRegistered[0]?.signalScopes?.githubScopes?.[0];
    const githubUrl = firstScope
      ? `https://github.com/${firstScope.owner}/${firstScope.repo}`
      : null;

    return {
      version: HARNESS_VERSION,
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      pid: process.pid,
      name: process.env.MURMURATION_NAME ?? rootDir.split("/").pop() ?? "murmuration",
      rootDir,
      ...(githubUrl ? { githubUrl } : {}),
      governance: this.#readGovernanceStatus(),
      agentCount: agents.length,
      murmuration: { totalWakes, totalArtifacts, idleWakes: totalIdle, groupCount: groups.length },
      groups,
      agents,
      inFlightMeetings: [...this.#meetings.values()].filter((m) => m.status === "running"),
      recentMeetings: await this.#loadRecentMeetings(),
      inFlightWakes: [...this.#wakeProcesses.values()].filter((w) => w.status === "running"),
    };
  }

  // -----------------------------------------------------------------------
  // Detail handlers
  // -----------------------------------------------------------------------

  public async agentDetail(agentId: string): Promise<unknown> {
    const { rootDir, agentStateStore } = this.#deps;
    // Reload from disk so wake-now child-process writes are visible.
    // Without this, :status <agent> shows stale wake counts right
    // after a :wake — the daemon's in-memory state doesn't know the
    // child already updated the JSONL. buildStatus() does the same.
    await agentStateStore.load().catch(() => {
      /* best effort */
    });
    const runsDir = join(rootDir, ".murmuration", "runs", agentId);
    const agent = agentStateStore.getAgent(agentId);
    const recentDigests: { date: string; summary: string }[] = [];
    try {
      const dates = (await readdir(runsDir))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
        .slice(0, 5);
      const { stat } = await import("node:fs/promises");
      for (const date of dates) {
        const files = (await readdir(join(runsDir, date))).filter((f) => f.startsWith("digest-"));
        if (files.length === 0) continue;
        // Digest filenames are UUID-keyed, so alphabetical order has
        // no relationship to time. Pick the most recent by mtime so
        // :status <agent> shows the latest wake, not a random one
        // (often a timed-out earlier attempt with an empty body).
        const withStats = await Promise.all(
          files.map(async (f) => {
            const full = join(runsDir, date, f);
            const s = await stat(full).catch(() => null);
            return { file: full, mtimeMs: s?.mtimeMs ?? 0 };
          }),
        );
        withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const latest = withStats[0];
        if (!latest) continue;
        const content = await readFile(latest.file, "utf8");
        const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();
        recentDigests.push({ date, summary: body.slice(0, 500) });
      }
    } catch {
      /* no runs yet */
    }
    return {
      agentId,
      state: agent?.currentState ?? "unknown",
      totalWakes: agent?.totalWakes ?? 0,
      totalArtifacts: agent?.totalArtifacts ?? 0,
      idleWakes: agent?.idleWakes ?? 0,
      consecutiveFailures: agent?.consecutiveFailures ?? 0,
      recentDigests,
    };
  }

  public async groupDetail(groupId: string): Promise<unknown> {
    const { rootDir, agentStateStore, allRegistered } = this.#deps;
    const runsBase = join(rootDir, ".murmuration", "runs");

    // Find the matching group directory
    let groupRunsDir = "";
    for (const prefix of [`circle-${groupId}`, groupId, `group-${groupId}`]) {
      const candidate = join(runsBase, prefix);
      try {
        await readdir(candidate);
        groupRunsDir = candidate;
        break;
      } catch {
        /* try next */
      }
    }

    // Gather group members from registered agents
    const groupAgents = allRegistered.filter((r) => r.groupMemberships.includes(groupId));
    const members = groupAgents.map((r) => {
      const a = agentStateStore.getAgent(r.agentId);
      return {
        agentId: r.agentId,
        totalWakes: a?.totalWakes ?? 0,
        totalArtifacts: a?.totalArtifacts ?? 0,
      };
    });
    const totalWakes = members.reduce((s, m) => s + m.totalWakes, 0);
    const totalArtifacts = members.reduce((s, m) => s + m.totalArtifacts, 0);
    const idleWakes = groupAgents.reduce((s, r) => {
      const a = agentStateStore.getAgent(r.agentId);
      return s + (a?.idleWakes ?? 0);
    }, 0);
    const idleRate = totalWakes > 0 ? Math.round((idleWakes / totalWakes) * 100) : 0;

    // Read recent meeting files
    const recentMeetings: { date: string; kind: string; summary: string }[] = [];
    if (groupRunsDir) {
      try {
        const dates = (await readdir(groupRunsDir))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
          .reverse()
          .slice(0, 10);
        for (const date of dates) {
          const files = await readdir(join(groupRunsDir, date));
          const meetingFiles = files.filter((f) => f.startsWith("meeting-"));
          for (const mf of meetingFiles) {
            const content = await readFile(join(groupRunsDir, date, mf), "utf8");
            const firstLine = content.split("\n")[0] ?? "";
            let kind = "operational";
            if (firstLine.includes("governance")) kind = "governance";
            else if (firstLine.includes("retrospective")) kind = "retrospective";
            const body = content.replace(/^#[^\n]*\n+/, "").trim();
            recentMeetings.push({ date, kind, summary: body.slice(0, 600) });
          }
        }
      } catch {
        /* no meetings yet */
      }
    }
    return {
      groupId,
      memberCount: members.length,
      totalWakes,
      totalArtifacts,
      idleRate,
      members,
      recentMeetings,
    };
  }

  // -----------------------------------------------------------------------
  // Private: recent meetings loader (reads from disk)
  // -----------------------------------------------------------------------

  // Meeting cache — loaded from GitHub, refreshed every 60s
  #meetingCache: {
    groupId: string;
    date: string;
    kind: string;
    minutesUrl: string;
    title: string;
  }[] = [];
  #meetingCacheAt = 0;
  // Short TTL — operators hit :events right after a convene finishes
  // and expect to see the meeting. 60s was too long in practice.
  static readonly #MEETING_CACHE_TTL_MS = 15_000;

  /**
   * Load recent meetings from GitHub (source of truth) with local cache.
   * In-flight meetings from the current session are merged on top.
   */
  async #loadRecentMeetings(): Promise<
    {
      groupId: string;
      date: string;
      kind: string;
      minutesUrl?: string;
      title?: string;
      status: string;
    }[]
  > {
    // Refresh cache if stale OR if the cache is empty — an empty cache
    // might mean "truly no meetings yet" OR "we haven't queried GitHub
    // yet." Operators who ran convene expect to see the meeting within
    // seconds; always re-querying when empty trades one extra GitHub
    // call for a working :events right after the first meeting.
    const stale = Date.now() - this.#meetingCacheAt > DaemonCommandExecutor.#MEETING_CACHE_TTL_MS;
    if (stale || this.#meetingCache.length === 0) {
      await this.#refreshMeetingCache();
    }

    const meetings: {
      groupId: string;
      date: string;
      kind: string;
      minutesUrl?: string;
      title?: string;
      status: string;
    }[] = [];

    // In-flight meetings from current session (real-time)
    for (const m of this.#meetings.values()) {
      if (m.status === "running") {
        meetings.push({
          groupId: m.groupId,
          date: m.startedAt.slice(0, 10),
          kind: m.kind,
          status: "running",
          ...(m.minutesUrl ? { minutesUrl: m.minutesUrl } : {}),
        });
      }
    }

    // GitHub-backed meeting history
    for (const cached of this.#meetingCache) {
      meetings.push({ ...cached, status: "completed" });
    }

    return meetings.slice(0, 10);
  }

  async #refreshMeetingCache(): Promise<void> {
    const { githubClient, repoCoordinate } = this.#deps;
    if (!githubClient || !repoCoordinate) {
      // Daemon wasn't wired with a githubClient or no agent declared a
      // github_scopes. :events will stay empty until those are set.
      // Silent here — noisy logging on every :events call would drown
      // the daemon log, and the dashboard / spirit skill already
      // explains the GitHub-backed nature of the event history.
      return;
    }

    try {
      // Fetch meeting issues from GitHub (both open and closed, last 10)
      const [govResult, opsResult] = await Promise.all([
        githubClient.listIssues(repoCoordinate, {
          state: "all",
          labels: ["governance-meeting"],
          perPage: 10,
        }),
        githubClient.listIssues(repoCoordinate, {
          state: "all",
          labels: ["group-meeting"],
          perPage: 10,
        }),
      ]);

      const meetings: {
        groupId: string;
        date: string;
        kind: string;
        minutesUrl: string;
        title: string;
      }[] = [];

      const processIssues = (
        issues: readonly {
          number: number;
          title: string;
          htmlUrl: string;
          labels: readonly string[];
          createdAt: Date;
        }[],
        defaultKind: string,
      ): void => {
        for (const issue of issues) {
          // Parse group from labels (e.g., "group:content")
          const groupLabel = issue.labels.find((l) => l.startsWith("group:"));
          const groupId = groupLabel ? groupLabel.slice("group:".length) : "unknown";

          // Parse kind from title (e.g., "[GOVERNANCE MEETING]" or "[OPERATIONAL MEETING]")
          let kind = defaultKind;
          if (issue.title.toUpperCase().includes("GOVERNANCE")) kind = "governance";
          else if (issue.title.toUpperCase().includes("RETROSPECTIVE")) kind = "retrospective";
          else if (issue.title.toUpperCase().includes("OPERATIONAL")) kind = "operational";

          meetings.push({
            groupId,
            date: issue.createdAt.toISOString().slice(0, 10),
            kind,
            minutesUrl: issue.htmlUrl,
            title: issue.title,
          });
        }
      };

      if (govResult.ok) processIssues(govResult.value, "governance");
      if (opsResult.ok) processIssues(opsResult.value, "operational");

      // Sort by date descending, deduplicate by URL
      const seen = new Set<string>();
      this.#meetingCache = meetings
        .sort((a, b) => b.date.localeCompare(a.date))
        .filter((m) => {
          if (seen.has(m.minutesUrl)) return false;
          seen.add(m.minutesUrl);
          return true;
        })
        .slice(0, 10);
      this.#meetingCacheAt = Date.now();
    } catch {
      // Keep stale cache on error
    }
  }

  // -----------------------------------------------------------------------
  // Query methods (dedicated RPC handlers, not slicing status blob)
  // -----------------------------------------------------------------------

  async #agentsList(): Promise<unknown> {
    await this.#deps.agentStateStore.load().catch(() => {
      /* best effort */
    });
    return this.#deps.agentStateStore.getAllAgents().map((a) => {
      const reg = this.#deps.allRegistered.find((r) => r.agentId === a.agentId);
      return {
        agentId: a.agentId,
        state: a.currentState,
        totalWakes: a.totalWakes,
        totalArtifacts: a.totalArtifacts,
        idleWakes: a.idleWakes,
        consecutiveFailures: a.consecutiveFailures,
        groups: reg?.groupMemberships ?? [],
      };
    });
  }

  #groupsList(): unknown {
    const { allRegistered, agentStateStore } = this.#deps;
    const groupMap = new Map<
      string,
      { agentId: string; totalWakes: number; totalArtifacts: number; idleWakes: number }[]
    >();
    for (const reg of allRegistered) {
      for (const g of reg.groupMemberships) {
        const a = agentStateStore.getAgent(reg.agentId);
        const list = groupMap.get(g) ?? [];
        list.push({
          agentId: reg.agentId,
          totalWakes: a?.totalWakes ?? 0,
          totalArtifacts: a?.totalArtifacts ?? 0,
          idleWakes: a?.idleWakes ?? 0,
        });
        groupMap.set(g, list);
      }
    }
    return [...groupMap.entries()].map(([groupId, members]) => ({
      groupId,
      memberCount: members.length,
      totalWakes: members.reduce((s, m) => s + m.totalWakes, 0),
      totalArtifacts: members.reduce((s, m) => s + m.totalArtifacts, 0),
      idleWakes: members.reduce((s, m) => s + m.idleWakes, 0),
      members: members.map((m) => m.agentId),
    }));
  }

  async #eventsHistory(): Promise<unknown> {
    return this.#loadRecentMeetings();
  }

  #costSummary(): unknown {
    const agents = this.#deps.agentStateStore.getAllAgents();
    const totalWakes = agents.reduce((s, a) => s + a.totalWakes, 0);
    const totalArtifacts = agents.reduce((s, a) => s + a.totalArtifacts, 0);
    return {
      totalWakes,
      totalArtifacts,
      agents: agents.map((a) => ({
        agentId: a.agentId,
        totalWakes: a.totalWakes,
        totalArtifacts: a.totalArtifacts,
        artifactRate: a.totalWakes > 0 ? a.totalArtifacts / a.totalWakes : 0,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // Private: command handlers
  // -----------------------------------------------------------------------

  async #handleDirective(params: Record<string, unknown>): Promise<unknown> {
    if (!this.#deps.onDirective) throw new Error("directive handler not configured");
    const scope = (params.scope as string | undefined) ?? "--all";
    const target = (params.target as string | undefined) ?? "";
    const message = (params.message as string | undefined) ?? "";
    if (!message) throw new Error("directive requires a message");
    const args: string[] = [];
    if (scope === "--all") {
      args.push("--all");
    } else if (scope === "--group" && target) {
      args.push("--group", target);
    } else if (scope === "--agent" && target) {
      args.push("--agent", target);
    } else {
      args.push("--all");
    }
    args.push("--root", this.#deps.rootDir, message);
    await this.#deps.onDirective(args, this.#deps.rootDir);
    this.#deps.eventBus?.emit({ kind: "command.executed", method: "directive", ok: true });
    return { sent: true };
  }

  #handleGroupWake(params: Record<string, unknown>): unknown {
    if (!this.#deps.onGroupWake) throw new Error("group-wake handler not configured");
    const groupId = (params.groupId as string | undefined) ?? "";
    const kind = (params.kind as string | undefined) ?? "operational";
    const args = ["--group", groupId, "--root", this.#deps.rootDir];
    if (kind === "governance") args.push("--governance");
    if (kind === "retrospective") args.push("--retrospective");
    if (params.directive) args.push("--directive", params.directive as string);
    if (this.#deps.governancePath) args.push("--governance-plugin", this.#deps.governancePath);

    // Track the meeting
    const meeting: MeetingStatus = {
      groupId,
      kind,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#meetings.set(groupId, meeting);
    this.#deps.eventBus?.emit({ kind: "meeting.started", groupId, meetingKind: kind });

    // Fire in background — return immediately (Engineering Standard #2 + #7)
    void this.#deps.onGroupWake(args, this.#deps.rootDir).then(
      async (result) => {
        meeting.status = "completed";
        meeting.minutesUrl = result.meetingMinutesUrl;

        // Apply governance transitions (Engineering Standard #3 — single owner)
        const transitions = await this.#applyGovernanceTransitions(result);

        this.#deps.eventBus?.emit({
          kind: "meeting.completed",
          groupId,
          meetingKind: kind,
          minutesUrl: result.meetingMinutesUrl,
          transitions,
        });
      },
      (err: unknown) => {
        meeting.status = "failed";
        meeting.error = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "group-wake.failed", groupId, error: meeting.error })}\n`,
        );
      },
    );
    return { convened: true, groupId, kind };
  }

  async #handleWakeNow(params: Record<string, unknown>): Promise<unknown> {
    const agentId = params.agentId as string | undefined;
    if (!agentId) throw new Error("wake-now requires agentId");
    if (!this.#deps.onWakeNow) throw new Error("wake-now handler not configured");

    // Validate agent exists
    const known = this.#deps.allRegistered.find((a) => a.agentId === agentId);
    if (!known) {
      const available = this.#deps.allRegistered.map((a) => a.agentId).join(", ");
      throw new Error(`Unknown agent "${agentId}". Available: ${available}`);
    }

    // --force: reset the circuit-breaker by zeroing consecutiveFailures
    // before spawning the child. Operator escape hatch when an agent
    // is locked out after 3 consecutive failures.
    if (params.force === true) {
      await this.#deps.agentStateStore.load().catch(() => {
        /* best effort */
      });
      await this.#deps.agentStateStore.resetConsecutiveFailures(agentId);
    }

    const result = await this.#deps.onWakeNow(this.#deps.rootDir, agentId);

    // Track the process (Engineering Standard #7 — track what you spawn)
    const wakeProcess: WakeProcessStatus = {
      agentId,
      pid: result.pid,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#wakeProcesses.set(agentId, wakeProcess);

    return { waking: true, agentId, pid: result.pid };
  }

  // -----------------------------------------------------------------------
  // Private: governance transitions (Engineering Standard #3 — single owner)
  // -----------------------------------------------------------------------

  /**
   * Apply governance state transitions based on meeting tallies.
   * The daemon is the single owner of the governance store — group-wake
   * does not independently load or mutate it (Engineering Standard #3).
   */
  async #applyGovernanceTransitions(meetingResult: {
    tallies: readonly GovernanceTally[];
    totalInputTokens: number;
    totalOutputTokens: number;
  }): Promise<{ itemId: string; to: string }[]> {
    const { governancePersistDir, governancePlugin } = this.#deps;
    const resolveKeywords = ["resolve", "ratif", "approve", "adopt", "agree", "pass", "consent"];
    const shouldResolve = (text: string): boolean =>
      resolveKeywords.some((kw) => text.toLowerCase().includes(kw));

    try {
      const store = new GovernanceStateStore({
        persistDir: governancePersistDir,
        ...(this.#deps.governanceSync ? { onSync: this.#deps.governanceSync } : {}),
      });

      // Register graphs from the governance plugin so transitions validate
      const graphs = governancePlugin?.stateGraphs() ?? [];
      for (const g of graphs) {
        store.registerGraph(g);
      }
      await store.load();

      const transitions: { itemId: string; to: string }[] = [];

      // Determine which items to resolve: by tallies, or all pending if
      // no tallies but the meeting clearly ran (spent tokens = real meeting happened)
      const resolveByTally = new Set<string>();
      for (const tally of meetingResult.tallies) {
        if (shouldResolve(tally.recommendation)) {
          resolveByTally.add(tally.itemId);
        }
      }

      // If no tallies but meeting ran (tokens > 0), resolve all pending
      // items of this governance meeting — the meeting addressed them.
      const resolveAll = resolveByTally.size === 0 && meetingResult.totalOutputTokens > 0;

      // Get all non-terminal items
      const allItems = store.query();
      const terminalStates = new Set(graphs.flatMap((g) => g.terminalStates));
      const pendingItems = allItems.filter((i) => !terminalStates.has(i.currentState));

      for (const item of pendingItems) {
        if (!resolveByTally.has(item.id) && !resolveAll) continue;

        const graph = graphs.find((g) => g.kind === item.kind);
        if (!graph) continue;

        const terminalSet = new Set(graph.terminalStates);
        const directTerminal = graph.transitions.find(
          (t) => t.from === item.currentState && terminalSet.has(t.to),
        );
        if (!directTerminal) continue;

        try {
          store.transition(item.id, directTerminal.to, "governance-meeting");
          transitions.push({ itemId: item.id, to: directTerminal.to });
          this.#deps.eventBus?.emit({
            kind: "governance.transitioned",
            itemId: item.id,
            from: item.currentState,
            to: directTerminal.to,
            triggeredBy: "governance-meeting",
          });
          process.stdout.write(
            `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "governance.transitioned", itemId: item.id.slice(0, 8), from: item.currentState, to: directTerminal.to })}\n`,
          );
        } catch (err: unknown) {
          process.stderr.write(
            `[command-executor] governance transition failed for ${item.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      await store.flush();
      return transitions;
    } catch (err: unknown) {
      process.stderr.write(
        `[command-executor] governance transition failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Private: governance status reader
  // -----------------------------------------------------------------------

  #readGovernanceStatus(): unknown {
    const { governancePersistDir, governancePlugin } = this.#deps;
    const govTerminology = governancePlugin?.terminology ?? {
      group: "group",
      groupPlural: "groups",
      governanceItem: "item",
      governanceEvent: "governance event",
    };

    try {
      const content = fsReadFileSync(join(governancePersistDir, "items.jsonl"), "utf8");
      const items: Record<string, unknown>[] = [];
      for (const line of content.trim().split("\n")) {
        if (!line) continue;
        try {
          items.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* skip */
        }
      }

      const graphs = governancePlugin?.stateGraphs() ?? [];
      const terminalStates = new Set(graphs.flatMap((g) => g.terminalStates));

      const pending = items.filter((i) => !terminalStates.has(i.currentState as string));
      const resolved = items.filter((i) => terminalStates.has(i.currentState as string));

      return {
        model: governancePlugin?.name ?? "none",
        terminology: govTerminology,
        totalItems: items.length,
        pending: pending.map((i) => {
          const cb = i.createdBy as Record<string, unknown> | undefined;
          const pl = i.payload as Record<string, unknown> | undefined;
          const ghUrl = i.githubIssueUrl as string | undefined;
          return {
            id: (i.id as string).slice(0, 8),
            kind: i.kind,
            state: i.currentState,
            createdBy: (cb?.value as string | undefined) ?? "unknown",
            topic: (pl?.topic as string | undefined) ?? "",
            ...(ghUrl ? { githubIssueUrl: ghUrl } : {}),
          };
        }),
        recentDecisions: resolved
          .slice(-5)
          .reverse()
          .map((i) => {
            const pl = i.payload as Record<string, unknown> | undefined;
            const ghUrl = i.githubIssueUrl as string | undefined;
            return {
              id: (i.id as string).slice(0, 8),
              kind: i.kind,
              state: i.currentState,
              topic: (pl?.topic as string | undefined) ?? "",
              ...(ghUrl ? { githubIssueUrl: ghUrl } : {}),
            };
          }),
      };
    } catch {
      return {
        model: governancePlugin?.name ?? "none",
        terminology: govTerminology,
        totalItems: 0,
        pending: [],
        recentDecisions: [],
      };
    }
  }

  // -----------------------------------------------------------------------
  // Directive list/delete (ADR-0021)
  // -----------------------------------------------------------------------

  /**
   * Confirm the given item ID is a source-directive before letting
   * mutations through. Returns the matched item's state ("open" |
   * "closed") so callers can short-circuit no-op mutations (e.g.
   * closing an already-closed directive).
   *
   * Throws with a legible message when the target isn't a directive
   * or the provider couldn't verify.
   *
   * v0.5.0 tester reports:
   *   - `:directive close 12` closed an unrelated agent-identity
   *     issue because the handler passed any ID straight through.
   *   - `:directive close 513` repeatedly reported "Directive 513
   *     closed." even when it was already closed — the PATCH is a
   *     no-op on GitHub but the handler didn't notice.
   */
  async #assertIsDirective(id: string, action: "close" | "delete"): Promise<"open" | "closed"> {
    if (!this.#deps.collaborationProvider) return "open";
    const result = await this.#deps.collaborationProvider.listItems({
      labels: ["source-directive"],
      state: "all",
    });
    if (!result.ok) {
      throw new Error(
        `cannot ${action} directive ${id}: could not verify it is a directive (${result.error.message})`,
      );
    }
    const match = result.value.find((item) => item.ref.id === id);
    if (!match) {
      throw new Error(
        `refusing to ${action} ${id}: that ID is not a source-directive. Run \`:directive list\` to see open directives.`,
      );
    }
    return match.state;
  }

  async #handleDirectiveList(): Promise<unknown> {
    if (!this.#deps.collaborationProvider) {
      throw new Error("No collaboration provider configured");
    }
    const result = await this.#deps.collaborationProvider.listItems({
      labels: ["source-directive"],
      state: "open",
    });
    if (!result.ok) throw new Error(result.error.message);
    return {
      items: result.value.map((item) => ({
        id: item.ref.id,
        title: item.title,
        state: item.state,
        labels: item.labels,
        url: item.ref.url,
      })),
    };
  }

  async #handleDirectiveClose(params: Record<string, unknown>): Promise<unknown> {
    if (!this.#deps.collaborationProvider) {
      throw new Error("No collaboration provider configured");
    }
    const id = params.id as string | undefined;
    if (!id) throw new Error("directive.close requires an id");

    // Guard: confirm the target is actually a source-directive before
    // mutating it. Without this, :directive close 12 would happily
    // close ANY issue numbered 12, even an unrelated agent identity
    // doc. Tester caught this in v0.5.0 validation.
    const state = await this.#assertIsDirective(id, "close");
    if (state === "closed") {
      return { closed: true, id, alreadyClosed: true };
    }

    const result = await this.#deps.collaborationProvider.updateItemState({ id }, "closed");
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND") {
        const repoHint = this.#deps.repoCoordinate
          ? `${this.#deps.repoCoordinate.owner}/${this.#deps.repoCoordinate.repo}`
          : "(unknown)";
        throw new Error(
          `could not close directive ${id}: GitHub returned "not found" for ${repoHint}#${id}.\n  If :directive list showed this item, check two things:\n  1. Does the issue actually live in ${repoHint}? (The daemon is hitting that repo; if the directive was posted elsewhere, adjust harness.yaml collaboration.repo or the first agent's github_scopes.)\n  2. Does your GITHUB_TOKEN have Issues: Read and write on that repo? (GitHub returns 404 instead of 403 for unauthorized writes.)`,
        );
      }
      throw new Error(result.error.message);
    }
    return { closed: true, id };
  }

  async #handleDirectiveDelete(params: Record<string, unknown>): Promise<unknown> {
    const id = params.id as string | undefined;
    if (!id) throw new Error("directive.delete requires an id");

    // Local-mode only: delete the scaffolded .json. GitHub-mode is
    // refused — there's no true delete for GitHub issues via PAT, so
    // falling back to close-as-delete was a misleading duplicate of
    // :directive close. v0.5.0 tester: "what's the difference between
    // close and delete?" — now there is one.
    const itemsDir = join(this.#deps.rootDir, ".murmuration", "items");
    const filePath = join(itemsDir, `${id}.json`);
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(filePath);
      return { deleted: true, id };
    } catch {
      const repoHint = this.#deps.repoCoordinate
        ? `${this.#deps.repoCoordinate.owner}/${this.#deps.repoCoordinate.repo}`
        : "<owner>/<repo>";
      throw new Error(
        `:directive delete isn't supported on GitHub-backed murmurations (GitHub's REST API can't delete issues via PAT).\n  Use one of:\n    :directive close ${id}                         — close the issue (reversible)\n    gh issue delete ${id} --repo ${repoHint}   — permanently delete (requires admin on the repo)\n  Delete remains available for local-mode murmurations where the directive is a .murmuration/items/<id>.json file.`,
      );
    }
  }

  #handleDirectivePath(params: Record<string, unknown>): unknown {
    const id = params.id as string | undefined;
    if (!id) throw new Error("directive.path requires an id");

    const filePath = join(this.#deps.rootDir, ".murmuration", "items", `${id}.json`);
    return { path: filePath };
  }
}
