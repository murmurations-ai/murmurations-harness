import { z } from "zod";
import { Octokit } from "@octokit/rest";

export const id = "github-extras";
export const name = "GitHub Extras";
export const description = "Extra GitHub tools not provided by the official MCP server.";

export const register = (api) => {
  api.registerTool({
    name: "github__get_issue_comments",
    description: "Get comments for a GitHub issue or pull request",
    parameters: z.object({
      owner: z.string().describe("Repository owner (e.g. 'murmurations-ai')"),
      repo: z.string().describe("Repository name (e.g. 'murmurations-harness')"),
      issue_number: z.number().describe("Issue or pull request number"),
    }),
    execute: async (input) => {
      const token = api.getSecret("GITHUB_TOKEN");
      if (!token) {
        throw new Error("GITHUB_TOKEN secret is required");
      }

      const octokit = new Octokit({ auth: token });
      try {
        const { data } = await octokit.rest.issues.listComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          per_page: 100,
        });

        return JSON.stringify(
          data.map((c) => ({
            id: c.id,
            user: c.user.login,
            created_at: c.created_at,
            body: c.body,
          })),
          null,
          2,
        );
      } catch (err) {
        throw new Error(`Failed to fetch comments: ${err.message}`);
      }
    },
  });
};
