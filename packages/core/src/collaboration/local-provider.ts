/**
 * LocalCollaborationProvider — filesystem-based provider for offline
 * development, testing, and personal murmurations (ADR-0021 §4).
 *
 * Coordination items are YAML frontmatter files in a configurable directory.
 * Artifacts are direct file writes to the murmuration root.
 * Signals are collected by reading the items directory.
 *
 * No network calls, no API keys, no external dependencies.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Signal } from "../execution/index.js";
import type {
  CollaborationProvider,
  CollaborationItem,
  ItemRef,
  ItemFilter,
  ItemState,
  CommentRef,
  ArtifactRef,
  CollabResult,
} from "./types.js";
import { CollaborationError } from "./types.js";

// ---------------------------------------------------------------------------
// Item file format (YAML frontmatter + body)
// ---------------------------------------------------------------------------

interface ItemFile {
  id: string;
  title: string;
  state: ItemState;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: { id: string; body: string; createdAt: string }[];
  body: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LocalProviderOptions {
  /** Directory for coordination items. Default: `{rootDir}/.murmuration/items` */
  readonly itemsDir: string;
  /** Root directory for artifact writes. */
  readonly artifactsDir: string;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class LocalCollaborationProvider implements CollaborationProvider {
  readonly id = "local";
  readonly displayName = "Local Filesystem";

  readonly #itemsDir: string;
  readonly #artifactsDir: string;

  constructor(options: LocalProviderOptions) {
    this.#itemsDir = resolve(options.itemsDir);
    this.#artifactsDir = resolve(options.artifactsDir);
  }

  async createItem(input: {
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<CollabResult<ItemRef>> {
    try {
      await mkdir(this.#itemsDir, { recursive: true });
      const id = randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const item: ItemFile = {
        id,
        title: input.title,
        state: "open",
        labels: input.labels ? [...input.labels] : [],
        createdAt: now,
        updatedAt: now,
        comments: [],
        body: input.body,
      };
      const filePath = join(this.#itemsDir, `${id}.json`);
      await writeFile(filePath, JSON.stringify(item, null, 2), "utf8");
      return { ok: true, value: { id, url: `file://${filePath}` } };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async listItems(filter?: ItemFilter): Promise<CollabResult<readonly CollaborationItem[]>> {
    try {
      await mkdir(this.#itemsDir, { recursive: true });
      const files = await readdir(this.#itemsDir);
      const items: CollaborationItem[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await readFile(join(this.#itemsDir, file), "utf8");
          const data = JSON.parse(content) as ItemFile;
          const item = this.#toCollaborationItem(data);

          // Apply filters
          if (filter?.state && filter.state !== "all" && item.state !== filter.state) continue;
          if (filter?.labels && !filter.labels.every((l) => item.labels.includes(l))) continue;
          if (filter?.since && item.updatedAt < filter.since) continue;

          items.push(item);
        } catch {
          // Skip unreadable files
        }
      }

      // Sort by updatedAt descending
      items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      const limit = filter?.limit ?? 30;
      return { ok: true, value: items.slice(0, limit) };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async postComment(ref: ItemRef, body: string): Promise<CollabResult<CommentRef>> {
    try {
      const item = await this.#loadItem(ref.id);
      if (!item)
        return {
          ok: false,
          error: new CollaborationError("local", "NOT_FOUND", `Item ${ref.id} not found`),
        };

      const commentId = randomUUID().slice(0, 8);
      item.comments.push({ id: commentId, body, createdAt: new Date().toISOString() });
      item.updatedAt = new Date().toISOString();
      await this.#saveItem(item);

      return { ok: true, value: { id: commentId } };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async updateItemState(ref: ItemRef, state: ItemState): Promise<CollabResult<void>> {
    try {
      const item = await this.#loadItem(ref.id);
      if (!item)
        return {
          ok: false,
          error: new CollaborationError("local", "NOT_FOUND", `Item ${ref.id} not found`),
        };

      item.state = state;
      item.updatedAt = new Date().toISOString();
      await this.#saveItem(item);

      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async addLabels(ref: ItemRef, labels: readonly string[]): Promise<CollabResult<void>> {
    try {
      const item = await this.#loadItem(ref.id);
      if (!item)
        return {
          ok: false,
          error: new CollaborationError("local", "NOT_FOUND", `Item ${ref.id} not found`),
        };

      for (const label of labels) {
        if (!item.labels.includes(label)) item.labels.push(label);
      }
      item.updatedAt = new Date().toISOString();
      await this.#saveItem(item);

      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async removeLabel(ref: ItemRef, label: string): Promise<CollabResult<void>> {
    try {
      const item = await this.#loadItem(ref.id);
      if (!item)
        return {
          ok: false,
          error: new CollaborationError("local", "NOT_FOUND", `Item ${ref.id} not found`),
        };

      item.labels = item.labels.filter((l) => l !== label);
      item.updatedAt = new Date().toISOString();
      await this.#saveItem(item);

      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async commitArtifact(input: {
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<CollabResult<ArtifactRef>> {
    try {
      const fullPath = join(this.#artifactsDir, input.path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, input.content, "utf8");

      return {
        ok: true,
        value: {
          id: `local-${String(Date.now())}`,
          url: `file://${fullPath}`,
          path: input.path,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: new CollaborationError("local", "UNKNOWN", String(err), { cause: err }),
      };
    }
  }

  async collectSignals(filter?: ItemFilter): Promise<readonly Signal[]> {
    const result = await this.listItems(filter);
    if (!result.ok) return [];

    const now = new Date();
    return result.value.map((item) => ({
      kind: "custom" as const,
      id: `local-item-${item.ref.id}`,
      trust: "trusted" as const,
      fetchedAt: now,
      sourceId: "local-item",
      data: {
        id: item.ref.id,
        title: item.title,
        body: item.body,
        state: item.state,
        labels: [...item.labels],
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async #loadItem(id: string): Promise<ItemFile | null> {
    try {
      const filePath = join(this.#itemsDir, `${id}.json`);
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as ItemFile;
    } catch {
      return null;
    }
  }

  async #saveItem(item: ItemFile): Promise<void> {
    const filePath = join(this.#itemsDir, `${item.id}.json`);
    await writeFile(filePath, JSON.stringify(item, null, 2), "utf8");
  }

  #toCollaborationItem(data: ItemFile): CollaborationItem {
    return {
      ref: { id: data.id, url: `file://${join(this.#itemsDir, `${data.id}.json`)}` },
      title: data.title,
      body: data.body,
      state: data.state,
      labels: data.labels,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
  }
}
