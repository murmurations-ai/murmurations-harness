/**
 * Lightweight `.env` reader for CLI subcommands that need a single env
 * value (e.g. `GITHUB_TOKEN`) without booting the full `secrets-dotenv`
 * package (which wraps values in `SecretValue` and handles allowlists).
 *
 * Two-line parse with quote unwrap. Returns a `Map<string, string>`;
 * callers decide what to do with the values.
 *
 * Used by:
 *   - `doctor.ts` hygiene check
 *   - `list-stale-issues.ts`
 *
 * If a third caller appears that needs allowlisting, scrubbing, or
 * `SecretValue`-typed return, switch to `@murmurations-ai/secrets-dotenv`
 * rather than growing this helper.
 */

export const parseDotEnv = (content: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
};
