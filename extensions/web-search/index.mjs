/**
 * Built-in web search + web fetch extension.
 *
 * Providers (in priority order):
 * 1. Tavily (if TAVILY_API_KEY is set) — best for AI agents
 * 2. DuckDuckGo HTML scrape (keyless fallback) — always available
 *
 * Also provides web_fetch for reading URLs.
 */

import { z } from "zod";

/** @type {import("@murmurations-ai/core").ExtensionEntry} */
export default {
  id: "web-search",
  name: "Web Search & Fetch",
  description: "Web search (Tavily or DuckDuckGo) and URL fetching for agents",

  register(api) {
    const tavilyKey = api.getSecret("TAVILY_API_KEY");

    // --- web_search tool ---
    api.registerTool({
      name: "web_search",
      description:
        "Search the web for information. Returns a list of results with titles, URLs, and snippets.",
      parameters: z.object({
        query: z.string().describe("The search query"),
        maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
      }),
      execute: tavilyKey
        ? async (input) => tavilySearch(tavilyKey, input)
        : async (input) => duckduckgoSearch(input),
    });

    // --- web_fetch tool ---
    api.registerTool({
      name: "web_fetch",
      description:
        "Fetch the content of a web page and return it as plain text. Use this to read articles, documentation, or any URL.",
      parameters: z.object({
        url: z.string().url().describe("The URL to fetch"),
      }),
      execute: async (input) => fetchUrl(input),
    });
  },
};

// ---------------------------------------------------------------------------
// Tavily search (preferred — clean, structured results)
// ---------------------------------------------------------------------------

async function tavilySearch(apiKey, input) {
  const query = input.query;
  const maxResults = input.maxResults ?? 5;

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const results = (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));

  let output = `## Search results for: ${query}\n\n`;
  if (data.answer) {
    output += `**Answer:** ${data.answer}\n\n`;
  }
  for (const r of results) {
    output += `- **${r.title}**\n  ${r.url}\n  ${r.snippet}\n\n`;
  }
  return output || "No results found.";
}

// ---------------------------------------------------------------------------
// DuckDuckGo search (keyless fallback — HTML scrape)
// ---------------------------------------------------------------------------

async function duckduckgoSearch(input) {
  const query = input.query;
  const maxResults = input.maxResults ?? 5;

  // Use DuckDuckGo's HTML-only lite endpoint
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MurmurationHarness/0.3; +https://github.com/murmurations-ai)",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const html = await response.text();

  // Extract results from the lite HTML page
  const results = [];
  // DuckDuckGo lite: href may come before or after class='result-link'
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  let linkMatch;
  const links = [];
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let url = linkMatch[1] || "";
    const title = (linkMatch[2] || "").replace(/<[^>]*>/g, "").trim();
    // Extract actual URL from DuckDuckGo redirect: //duckduckgo.com/l/?uddg=<encoded_url>&...
    const uddgMatch = url.match(/uddg=([^&]*)/);
    if (uddgMatch?.[1]) {
      url = decodeURIComponent(uddgMatch[1]);
    }
    if (title) links.push({ url, title });
  }

  let snippetMatch;
  const snippets = [];
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(snippetMatch[1].replace(/<[^>]*>/g, "").trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i]?.title || "",
      url: links[i]?.url || "",
      snippet: snippets[i] || "",
    });
  }

  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  let output = `## Search results for: ${query}\n\n`;
  for (const r of results) {
    output += `- **${r.title}**\n  ${r.url}\n  ${r.snippet}\n\n`;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Web fetch (read a URL as text)
// ---------------------------------------------------------------------------

async function fetchUrl(input) {
  const url = input.url;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MurmurationHarness/0.3; +https://github.com/murmurations-ai)",
      Accept: "text/html,application/xhtml+xml,text/plain,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  // Basic HTML to text conversion
  if (contentType.includes("html")) {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000); // cap at 10k chars
  }

  return text.slice(0, 10000);
}
