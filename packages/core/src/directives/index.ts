/**
 * Source Directives — first-class communication from Source to the
 * murmuration.
 *
 * A directive is a question, instruction, or decision that Source
 * injects into the murmuration. It flows through the existing
 * signal → wake → output pipeline:
 *
 *   1. Source runs `murmuration directive --circle content "question"`
 *   2. CLI writes a directive file to `.murmuration/directives/<id>.json`
 *   3. Daemon reads pending directives before each wake
 *   4. Injects matching directives into the agent's signal bundle
 *      as custom signals with sourceId "source-directive"
 *   5. Agent's runner sees the directive in its signals and responds
 *   6. Directive status updates to "responded" with the wake's output
 *
 * No prompt hacking. No file swapping. Directives are a first-class
 * primitive.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DirectiveScope =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "circle"; readonly circleId: string }
  | { readonly kind: "all" };

export type DirectiveStatus = "pending" | "responded" | "expired";

export interface Directive {
  readonly id: string;
  readonly from: "source";
  readonly scope: DirectiveScope;
  readonly kind: "question" | "instruction" | "decision";
  readonly body: string;
  readonly createdAt: string; // ISO
  readonly status: DirectiveStatus;
  readonly responses?: readonly DirectiveResponse[];
}

export interface DirectiveResponse {
  readonly agentId: string;
  readonly wakeId: string;
  readonly respondedAt: string; // ISO
  readonly excerpt: string; // first 200 chars of wake summary
}

// ---------------------------------------------------------------------------
// DirectiveStore — reads/writes .murmuration/directives/
// ---------------------------------------------------------------------------

export class DirectiveStore {
  readonly #dir: string;

  public constructor(rootDir: string) {
    this.#dir = join(rootDir, ".murmuration", "directives");
  }

  /** Create a new directive. Returns the created directive. */
  public async create(
    scope: DirectiveScope,
    kind: Directive["kind"],
    body: string,
  ): Promise<Directive> {
    await mkdir(this.#dir, { recursive: true });
    const directive: Directive = {
      id: randomUUID().slice(0, 8),
      from: "source",
      scope,
      kind,
      body,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await writeFile(
      join(this.#dir, `${directive.id}.json`),
      JSON.stringify(directive, null, 2) + "\n",
      "utf8",
    );
    return directive;
  }

  /** Read all directives. */
  public async list(): Promise<readonly Directive[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const directives: Directive[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(this.#dir, file), "utf8");
        directives.push(JSON.parse(content) as Directive);
      } catch {
        // skip malformed
      }
    }
    return directives;
  }

  /** Get pending directives that match a given agentId + circleIds. */
  public async pending(
    agentId: string,
    circleIds: readonly string[],
  ): Promise<readonly Directive[]> {
    const all = await this.list();
    return all.filter((d) => {
      if (d.status !== "pending") return false;
      if (d.scope.kind === "all") return true;
      if (d.scope.kind === "agent") return d.scope.agentId === agentId;
      return circleIds.includes(d.scope.circleId);
    });
  }

  /** Mark a directive as responded by a specific agent. */
  public async recordResponse(
    directiveId: string,
    agentId: string,
    wakeId: string,
    excerpt: string,
  ): Promise<void> {
    const filePath = join(this.#dir, `${directiveId}.json`);
    try {
      const content = await readFile(filePath, "utf8");
      const directive = JSON.parse(content) as Directive & {
        responses?: DirectiveResponse[];
        status: string;
      };
      const responses = directive.responses ?? [];
      responses.push({
        agentId,
        wakeId,
        respondedAt: new Date().toISOString(),
        excerpt: excerpt.slice(0, 200),
      });
      directive.responses = responses;
      // Keep status as "pending" until we decide when to mark "responded"
      // For now: if any agent has responded, mark it.
      directive.status = "responded";
      await writeFile(filePath, JSON.stringify(directive, null, 2) + "\n", "utf8");
    } catch {
      // Directive file may have been removed — ignore.
    }
  }
}
