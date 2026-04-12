/**
 * AgentStateStore — formal state machine for agent wake lifecycle.
 *
 * Every agent has a concrete, queryable state at all times:
 *   registered → idle → waking → running → completed → idle
 *                                        → failed → idle
 *                                        → timed-out → idle
 *
 * The daemon transitions state at each lifecycle point. The dashboard
 * reads state directly — no log scraping.
 *
 * Design approved by Intelligence Circle meeting 2026-04-11.
 * Issue: murmurations-ai/murmurations-harness#29
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentLifecycleState =
  | "registered"
  | "idle"
  | "waking"
  | "running"
  | "completed"
  | "failed"
  | "timed-out";

export type WakeOutcome = "success" | "failure" | "timeout" | "killed";

export interface AgentWakeInstance {
  readonly wakeId: string;
  readonly agentId: string;
  readonly state: AgentLifecycleState;
  readonly startedAt: string | null; // ISO
  readonly finishedAt: string | null; // ISO
  readonly outcome: WakeOutcome | null;
  readonly durationMs: number | null;
  readonly costMicros: number | null;
  readonly errorMessage?: string;
}

export interface AgentRecord {
  readonly agentId: string;
  readonly currentState: AgentLifecycleState;
  readonly registeredAt: string; // ISO
  readonly lastWokenAt: string | null; // ISO
  readonly lastOutcome: WakeOutcome | null;
  readonly maxWallClockMs: number;
  readonly consecutiveFailures: number;
  readonly totalWakes: number;
  readonly totalArtifacts: number;
  readonly idleWakes: number;
  readonly currentWakeId: string | null;
  readonly currentWakeStartedAt: string | null; // ISO
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AgentStateStore {
  readonly #agents = new Map<string, AgentRecord>();
  readonly #wakes = new Map<string, AgentWakeInstance>();
  readonly #wakesByAgent = new Map<string, string[]>(); // agentId → wakeId[]
  readonly #persistDir: string | undefined;
  readonly #now: () => Date;

  public constructor(options: { readonly persistDir?: string; readonly now?: () => Date } = {}) {
    this.#persistDir = options.persistDir;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Load persisted state from disk. Call once at daemon start. */
  public async load(): Promise<number> {
    if (!this.#persistDir) return 0;
    try {
      const content = await readFile(join(this.#persistDir, "state.json"), "utf8");
      const data = JSON.parse(content) as {
        agents?: Record<string, AgentRecord>;
        wakes?: Record<string, AgentWakeInstance>;
        wakesByAgent?: Record<string, string[]>;
      };
      if (data.agents) {
        for (const [id, record] of Object.entries(data.agents)) {
          this.#agents.set(id, record);
        }
      }
      if (data.wakes) {
        for (const [id, wake] of Object.entries(data.wakes)) {
          this.#wakes.set(id, wake);
        }
      }
      if (data.wakesByAgent) {
        for (const [id, wakeIds] of Object.entries(data.wakesByAgent)) {
          this.#wakesByAgent.set(id, wakeIds);
        }
      }
      return this.#agents.size;
    } catch {
      return 0;
    }
  }

  /** Register an agent. Idempotent — re-registering preserves history. */
  public register(agentId: string, maxWallClockMs: number): void {
    const existing = this.#agents.get(agentId);
    if (existing) {
      // Update maxWallClockMs but preserve history
      this.#agents.set(agentId, { ...existing, maxWallClockMs });
      return;
    }
    this.#agents.set(agentId, {
      agentId,
      currentState: "registered",
      registeredAt: this.#now().toISOString(),
      lastWokenAt: null,
      lastOutcome: null,
      maxWallClockMs,
      consecutiveFailures: 0,
      totalWakes: 0,
      totalArtifacts: 0,
      idleWakes: 0,
      currentWakeId: null,
      currentWakeStartedAt: null,
    });
    if (!this.#wakesByAgent.has(agentId)) {
      this.#wakesByAgent.set(agentId, []);
    }
    void this.#persist();
  }

  /** Transition an agent to a new state. */
  public transition(
    agentId: string,
    to: AgentLifecycleState,
    wakeId?: string,
  ): void {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`AgentStateStore: unknown agentId "${agentId}" — register before transitioning`);

    const now = this.#now().toISOString();
    let updates: Partial<AgentRecord> = { currentState: to };

    if (to === "waking" && wakeId) {
      updates = {
        ...updates,
        currentWakeId: wakeId,
        currentWakeStartedAt: now,
        lastWokenAt: now,
        totalWakes: agent.totalWakes + 1,
      };

      // Create a wake instance
      const wake: AgentWakeInstance = {
        wakeId,
        agentId,
        state: "waking",
        startedAt: now,
        finishedAt: null,
        outcome: null,
        durationMs: null,
        costMicros: null,
      };
      this.#wakes.set(wakeId, wake);
      const agentWakes = this.#wakesByAgent.get(agentId) ?? [];
      agentWakes.push(wakeId);
      // Keep only last 50 wakes per agent
      if (agentWakes.length > 50) {
        const removed = agentWakes.shift();
        if (removed) this.#wakes.delete(removed);
      }
      this.#wakesByAgent.set(agentId, agentWakes);
    }

    if (to === "running" && agent.currentWakeId) {
      const wake = this.#wakes.get(agent.currentWakeId);
      if (wake) {
        this.#wakes.set(agent.currentWakeId, { ...wake, state: "running" });
      }
    }

    if (to === "idle") {
      updates = { ...updates, currentWakeId: null, currentWakeStartedAt: null };
    }

    this.#agents.set(agentId, { ...agent, ...updates } as AgentRecord);
    void this.#persist();
  }

  /** Record a wake's outcome. Transitions agent to idle. */
  public recordWakeOutcome(
    wakeId: string,
    outcome: WakeOutcome,
    options: { errorMessage?: string | undefined; costMicros?: number | undefined; artifactCount?: number | undefined } = {},
  ): void {
    const wake = this.#wakes.get(wakeId);
    if (!wake) return;

    const now = this.#now();
    const startedAt = wake.startedAt ? new Date(wake.startedAt) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    const terminalState: AgentLifecycleState =
      outcome === "success" ? "completed"
        : outcome === "timeout" ? "timed-out"
          : "failed";

    this.#wakes.set(wakeId, {
      ...wake,
      state: terminalState,
      finishedAt: now.toISOString(),
      outcome,
      durationMs,
      costMicros: options.costMicros ?? null,
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    });

    const agent = this.#agents.get(wake.agentId);
    if (agent) {
      const consecutiveFailures =
        outcome === "success" ? 0 : agent.consecutiveFailures + 1;
      const artifacts = options.artifactCount ?? 0;
      const isIdle = outcome === "success" && artifacts === 0;
      this.#agents.set(wake.agentId, {
        ...agent,
        currentState: "idle",
        lastOutcome: outcome,
        consecutiveFailures,
        totalArtifacts: agent.totalArtifacts + artifacts,
        idleWakes: agent.idleWakes + (isIdle ? 1 : 0),
        currentWakeId: null,
        currentWakeStartedAt: null,
      });
    }
    void this.#persist();
  }

  /** Get a single agent's record. */
  public getAgent(agentId: string): AgentRecord | undefined {
    return this.#agents.get(agentId);
  }

  /** Get all agent records. */
  public getAllAgents(): readonly AgentRecord[] {
    return [...this.#agents.values()];
  }

  /**
   * Get agents that are stuck — in "running" or "waking" state for
   * longer than their maxWallClockMs. This is the stall detection
   * primitive the dashboard and group meetings use.
   */
  public getStalledAgents(): readonly AgentRecord[] {
    const now = this.#now().getTime();
    return [...this.#agents.values()].filter((a) => {
      if (a.currentState !== "running" && a.currentState !== "waking") return false;
      if (!a.currentWakeStartedAt) return false;
      const started = new Date(a.currentWakeStartedAt).getTime();
      return now - started > a.maxWallClockMs;
    });
  }

  /** Get recent wakes for an agent, most recent first. */
  public getRecentWakes(agentId: string, limit = 10): readonly AgentWakeInstance[] {
    const wakeIds = this.#wakesByAgent.get(agentId) ?? [];
    const result: AgentWakeInstance[] = [];
    for (const id of wakeIds.slice(-limit).reverse()) {
      const wake = this.#wakes.get(id);
      if (wake) result.push(wake);
    }
    return result;
  }

  /** How many agents are tracked. */
  public size(): number {
    return this.#agents.size;
  }

  /** Persist to disk. Best-effort, fire-and-forget. */
  async #persist(): Promise<void> {
    if (!this.#persistDir) return;
    try {
      await mkdir(this.#persistDir, { recursive: true });
      const data = {
        agents: Object.fromEntries(this.#agents),
        wakes: Object.fromEntries(this.#wakes),
        wakesByAgent: Object.fromEntries(this.#wakesByAgent),
      };
      await writeFile(
        join(this.#persistDir, "state.json"),
        JSON.stringify(data, null, 2) + "\n",
        "utf8",
      );
    } catch {
      // Best-effort
    }
  }

  /** Wait for pending persistence writes (for tests). */
  public async flush(): Promise<void> {
    await this.#persist();
  }
}
