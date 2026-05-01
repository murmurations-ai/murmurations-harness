/**
 * Gemini CLI adapter — wraps `gemini -p`.
 *
 * STUB. ADR-0034 BU-1/BU-2 unresolved for Gemini CLI:
 *   - JSON output shape (does --output-format json include token counts?)
 *   - Auth failure mode (exit code? stdin prompt?)
 *
 * The interface is locked (matches Claude adapter); the implementation
 * is a placeholder. Adding the real behavior is copy-the-template work
 * once a spike answers BU-1/BU-2.
 */

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type { AuthError, AuthStatus, ParseError, SubprocessLLMAdapter } from "../types.js";

export class GeminiCliAdapter implements SubprocessLLMAdapter {
  public readonly command = "gemini";
  public readonly providerId = "gemini-cli";

  public buildFlags(req: LLMRequest): readonly string[] {
    const flags: string[] = ["-p", "--output-format", "json", "--yolo"];
    if (req.model) flags.push("--model", req.model);
    return flags;
  }

  public parseOutput(_raw: string): Result<LLMResponse, ParseError> {
    return {
      ok: false,
      error: {
        kind: "parse-error",
        message:
          "GeminiCliAdapter.parseOutput is a stub — ADR-0034 BU-1 must be resolved before this adapter is production-ready",
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
          "GeminiCliAdapter is a stub. ADR-0034 BU-1/BU-2 unresolved; use provider 'gemini' (API) until the spike lands.",
      },
    });
  }
}
