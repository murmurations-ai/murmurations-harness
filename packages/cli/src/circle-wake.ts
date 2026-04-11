/**
 * `murmuration circle-wake` — trigger a circle meeting on demand.
 *
 * Usage:
 *   murmuration circle-wake --root ../my-murmuration --circle content
 *   murmuration circle-wake --root ../my-murmuration --circle content --governance
 *   murmuration circle-wake --root ../my-murmuration --circle content --directive "What's our top priority?"
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  makeSecretKey,
  runCircleWake,
  type CircleConfig,
  type CircleWakeContext,
  type CircleWakeKind,
  type GovernanceItem,
  GovernanceStateStore,
} from "@murmuration/core";
import { createLLMClient, type LLMClient } from "@murmuration/llm";
import { DotenvSecretsProvider } from "@murmuration/secrets-dotenv";

const GEMINI_KEY = makeSecretKey("GEMINI_API_KEY");

/** Parse a simple circle config from a circle doc's content. */
const parseCircleConfig = (circleId: string, content: string): CircleConfig => {
  // Extract members from "- agent-id" lines under "## Members"
  const membersMatch = /## Members\n([\s\S]*?)(?=\n##|\n---|\n$)/i.exec(content);
  const members: string[] = [];
  if (membersMatch) {
    for (const line of membersMatch[1]?.split("\n") ?? []) {
      const m = /^\s*-\s*(.+)/.exec(line);
      if (m) members.push(m[1]!.trim());
    }
  }

  // Extract facilitator from "facilitator:" in frontmatter or body
  const facMatch = /facilitator:\s*"?([^"\n]+)"?/i.exec(content);
  const facilitator = facMatch?.[1]?.trim() ?? members[0] ?? circleId;

  // Extract name from first heading
  const nameMatch = /^#\s+(.+)/m.exec(content);
  const name = nameMatch?.[1]?.trim() ?? circleId;

  return { circleId, name, members, facilitator };
};

export const runCircleWakeCommand = async (args: readonly string[], rootDir: string): Promise<void> => {
  const root = resolve(rootDir);

  // Parse args
  const circleIdx = args.indexOf("--circle");
  const circleId = circleIdx >= 0 ? args[circleIdx + 1] : undefined;
  if (!circleId) {
    console.error("murmuration circle-wake: --circle <id> is required");
    process.exit(2);
  }

  const isGovernance = args.includes("--governance");
  const kind: CircleWakeKind = isGovernance ? "governance" : "operational";

  const directiveIdx = args.indexOf("--directive");
  const directiveBody = directiveIdx >= 0 ? args[directiveIdx + 1] : undefined;

  // Load circle config
  const circleDocPath = join(root, "governance", "circles", `${circleId}.md`);
  if (!existsSync(circleDocPath)) {
    console.error(`murmuration circle-wake: circle doc not found at ${circleDocPath}`);
    process.exit(1);
  }
  const circleContent = await readFile(circleDocPath, "utf8");
  const config = parseCircleConfig(circleId, circleContent);

  console.log(`Circle wake: ${config.name} (${kind})`);
  console.log(`  Members: ${config.members.join(", ")}`);
  console.log(`  Facilitator: ${config.facilitator}`);
  if (directiveBody) console.log(`  Directive: "${directiveBody}"`);
  console.log("");

  // Load LLM client
  const envPath = join(root, ".env");
  let llmClient: LLMClient | undefined;
  if (existsSync(envPath)) {
    const provider = new DotenvSecretsProvider({ envPath });
    await provider.load({ required: [], optional: [GEMINI_KEY] });
    if (provider.has(GEMINI_KEY)) {
      llmClient = createLLMClient({
        provider: "gemini",
        token: provider.get(GEMINI_KEY),
        model: "gemini-2.5-flash",
      });
    }
  }

  if (!llmClient) {
    console.error("murmuration circle-wake: GEMINI_API_KEY not found in .env");
    process.exit(1);
  }

  // Load governance queue if governance meeting
  const governanceQueue: GovernanceItem[] = [];
  if (isGovernance) {
    const store = new GovernanceStateStore({
      persistDir: join(root, ".murmuration", "governance"),
    });
    await store.load();
    const pending = store.query();
    governanceQueue.push(...pending.filter((i) => !["resolved", "ratified", "rejected", "withdrawn", "completed"].includes(i.currentState)));
  }

  // Build context
  const context: CircleWakeContext = {
    circleId,
    kind,
    members: config.members,
    facilitator: config.facilitator,
    signals: [],
    governanceQueue,
    ...(directiveBody ? { directiveBody } : {}),
  };

  // Run the circle wake
  const client = llmClient;
  const result = await runCircleWake(context, {
    callLLM: async ({ systemPrompt, userPrompt, agentId }) => {
      console.log(`  [${agentId}] contributing...`);
      const r = await client.complete({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: userPrompt }],
        systemPromptOverride: systemPrompt,
        maxOutputTokens: 4000,
        temperature: 0.3,
      });
      if (!r.ok) throw new Error(`LLM failed for ${agentId}: ${r.error.code}`);
      return {
        content: r.value.content,
        inputTokens: r.value.inputTokens,
        outputTokens: r.value.outputTokens,
      };
    },
  });

  // Output
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Circle Meeting: ${config.name} (${kind})`);
  console.log(`${"=".repeat(60)}\n`);

  for (const c of result.contributions) {
    console.log(`--- ${c.agentId} ---`);
    console.log(c.content);
    console.log("");
  }

  console.log(`--- ${config.facilitator} (facilitator synthesis) ---`);
  console.log(result.synthesis);
  console.log("");

  // Print consent round tallies for governance meetings
  if (result.tallies.length > 0) {
    console.log(`\n--- Consent Round Tallies ---\n`);
    for (const tally of result.tallies) {
      const rec = tally.recommendation === "ratify"
        ? "\x1b[32mRATIFY\x1b[0m"
        : tally.recommendation === "amend"
          ? "\x1b[33mAMEND\x1b[0m"
          : "\x1b[31mESCALATE\x1b[0m";
      console.log(`  Item ${tally.itemId}: ${String(tally.consents)} consent, ${String(tally.concerns)} concern, ${String(tally.objections)} objection → ${rec}`);
      for (const p of tally.positions) {
        const posColor = p.position === "consent" ? "\x1b[32m" : p.position === "objection" ? "\x1b[31m" : "\x1b[33m";
        console.log(`    ${p.agentId}: ${posColor}${p.position}\x1b[0m — ${p.reasoning.slice(0, 60)}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Tokens: ${String(result.totalInputTokens)} in / ${String(result.totalOutputTokens)} out`);
  console.log(`Cost: ~$${(((result.totalInputTokens * 0.15 + result.totalOutputTokens * 0.6) / 1_000_000)).toFixed(4)}`);

  // Write meeting minutes to .murmuration/runs/<circleId>/
  const { writeFile: wf, mkdir } = await import("node:fs/promises");
  const dayUtc = new Date().toISOString().slice(0, 10);
  const meetingDir = join(root, ".murmuration", "runs", `circle-${circleId}`, dayUtc);
  await mkdir(meetingDir, { recursive: true });
  const meetingId = `meeting-${randomUUID().slice(0, 8)}`;
  const minutes = [
    `# ${config.name} — ${kind} meeting — ${dayUtc}`,
    "",
    `**Members:** ${config.members.join(", ")}`,
    `**Facilitator:** ${config.facilitator}`,
    directiveBody ? `**Directive:** ${directiveBody}` : "",
    "",
    ...result.contributions.map((c) => `## ${c.agentId}\n\n${c.content}\n`),
    `## Facilitator Synthesis\n\n${result.synthesis}`,
    ...(result.tallies.length > 0
      ? [
          "\n## Consent Round Tallies\n",
          ...result.tallies.map((t) =>
            `### Item ${t.itemId}\n- Consent: ${String(t.consents)}, Concern: ${String(t.concerns)}, Objection: ${String(t.objections)}\n- Recommendation: **${t.recommendation.toUpperCase()}**\n${t.positions.map((p) => `  - ${p.agentId}: ${p.position}${p.reasoning ? ` — ${p.reasoning}` : ""}`).join("\n")}`,
          ),
        ]
      : []),
  ].join("\n");
  await wf(join(meetingDir, `${meetingId}.md`), minutes, "utf8");
  console.log(`\nMeeting minutes: .murmuration/runs/circle-${circleId}/${dayUtc}/${meetingId}.md`);
};
