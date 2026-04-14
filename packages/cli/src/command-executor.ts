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
import { dirname, join, resolve } from "node:path";
import { openSync } from "node:fs";

import {
  HARNESS_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  GovernanceStateStore,
  type AgentStateStore,
  type GovernancePlugin,
  type GovernanceSyncCallbacks,
  type GovernanceTally,
  type RegisteredAgent,
} from "@murmurations-ai/core";
import type { DaemonEventBus } from "@murmurations-ai/core";

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

  public async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "directive":
        return this.#handleDirective(params);
      case "group-wake":
        return this.#handleGroupWake(params);
      case "wake-now":
        return this.#handleWakeNow(params);
      case "stop":
        process.kill(process.pid, "SIGTERM");
        return { stopping: true };
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
    const runsDir = join(rootDir, ".murmuration", "runs", agentId);
    const agent = agentStateStore.getAgent(agentId);
    const recentDigests: { date: string; summary: string }[] = [];
    try {
      const dates = (await readdir(runsDir))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
        .slice(0, 5);
      for (const date of dates) {
        const files = await readdir(join(runsDir, date));
        const digestFile = files.find((f) => f.startsWith("digest-"));
        if (digestFile) {
          const content = await readFile(join(runsDir, date, digestFile), "utf8");
          const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();
          recentDigests.push({ date, summary: body.slice(0, 500) });
        }
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
  static readonly #MEETING_CACHE_TTL_MS = 60_000;

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
    // Refresh cache if stale
    if (Date.now() - this.#meetingCacheAt > DaemonCommandExecutor.#MEETING_CACHE_TTL_MS) {
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
    if (!githubClient || !repoCoordinate) return;

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
  // Private: command handlers
  // -----------------------------------------------------------------------

  async #handleDirective(params: Record<string, unknown>): Promise<unknown> {
    const { runDirective } = await import("./directive.js");
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
    await runDirective(args, this.#deps.rootDir);
    this.#deps.eventBus?.emit({ kind: "command.executed", method: "directive", ok: true });
    return { sent: true };
  }

  async #handleGroupWake(params: Record<string, unknown>): Promise<unknown> {
    const { runGroupWakeCommand } = await import("./group-wake.js");
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
    void runGroupWakeCommand(args, this.#deps.rootDir).then(
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

    // Spawn a separate --now process for this agent
    const { spawn: cpSpawn } = await import("node:child_process");
    const binPath = resolve(dirname(import.meta.url.replace("file://", "")), "bin.js");
    const logPath = join(this.#deps.rootDir, ".murmuration", `wake-${agentId}.log`);
    const child = cpSpawn(
      process.execPath,
      [binPath, "start", "--root", this.#deps.rootDir, "--agent", agentId, "--now"],
      {
        detached: true,
        stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")],
      },
    );

    // Track the process (Engineering Standard #7 — track what you spawn)
    const wakeProcess: WakeProcessStatus = {
      agentId,
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.#wakeProcesses.set(agentId, wakeProcess);

    child.on("exit", (code) => {
      wakeProcess.status = code === 0 ? "completed" : "failed";
      wakeProcess.exitCode = code ?? 1;
      this.#deps.eventBus?.emit({
        kind: "wake.completed",
        agentId,
        wakeId: `now-${agentId}`,
        outcome: code === 0 ? "completed" : "failed",
        artifactCount: 0, // will be updated on next status reload
      });
    });

    child.unref();
    return { waking: true, agentId, pid: child.pid };
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
}
