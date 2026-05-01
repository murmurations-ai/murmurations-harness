/**
 * OpenAI Codex CLI adapter — wraps `codex exec`.
 *
 * STUB. ADR-0034 BU-1/BU-2 unresolved for Codex CLI:
 *   - JSON output shape (--json includes token counts?)
 *   - Auth failure mode (ChatGPT subscription session expiry behavior)
 *
 * Interface locked (matches Claude); implementation is placeholder.
 */

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type { AuthError, AuthStatus, ParseError, SubprocessLLMAdapter } from "../types.js";

export class CodexCliAdapter implements SubprocessLLMAdapter {
  public readonly command = "codex";
  public readonly providerId = "codex-cli";

  public buildFlags(req: LLMRequest): readonly string[] {
    const flags: string[] = ["exec", "--json", "--full-auto"];
    if (req.model) flags.push("--model", req.model);
    return flags;
  }

  public parseOutput(_raw: string): Result<LLMResponse, ParseError> {
    return {
      ok: false,
      error: {
        kind: "parse-error",
        message:
          "CodexCliAdapter.parseOutput is a stub — ADR-0034 BU-1 must be resolved before this adapter is production-ready",
        raw: "",
      },
    };
  }

  public async authCheck(): Promise<Result<AuthStatus, AuthError>> {
    return Promise.resolve({
      ok: true,
      value: {
        kind: "unavailable",
        message:
          "CodexCliAdapter is a stub. ADR-0034 BU-1/BU-2 unresolved; use provider 'openai' (API) until the spike lands.",
      },
    });
  }
}
