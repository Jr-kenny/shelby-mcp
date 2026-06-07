import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DOCS_URL = "https://docs.shelby.xyz/llms-full.txt";
const DEFAULT_CACHE_FILE = path.join(os.homedir(), ".gemini", "antigravity", "cache", "shelby-llms-full.txt");
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 15000;

// Offline fallback shipped with the package (see package.json "files": ["data"]).
// Populated from a known-good capture of https://docs.shelby.xyz/llms-full.txt so the
// server still works when the live source is unreachable or gated behind a bot challenge.
const BUNDLED_FALLBACK_FILE = fileURLToPath(new URL("../data/shelby-llms-full.txt", import.meta.url));

// The live docs site can sit behind a bot/security checkpoint that returns an HTML page
// with HTTP 200. That is not the docs bundle, so we must never cache or serve it.
function looksLikeDocsBundle(text: string): boolean {
  if (!text || !text.trim()) {
    return false;
  }

  const head = text.slice(0, 4000).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html") || head.includes("security checkpoint")) {
    return false;
  }

  // A valid bundle has multiple "# Title (/path)" page markers.
  const marker = /^#\s+(.+?)\s+\((\/[^)\s]*)\)\s*/gm;
  let count = 0;
  while (marker.exec(text)) {
    count += 1;
    if (count >= 2) {
      return true;
    }
  }

  return false;
}

async function readBundledFallback(): Promise<string | undefined> {
  try {
    return await fs.readFile(BUNDLED_FALLBACK_FILE, "utf8");
  } catch {
    return undefined;
  }
}

export interface ShelbyDocPage {
  id: string;
  path: string;
  slug: string;
  title: string;
  text: string;
  url: string;
  summary: string;
}

export interface ShelbyDocsSnapshot {
  fetchedAt: string;
  pages: ShelbyDocPage[];
  source: string;
}

interface ServiceOptions {
  cacheFile?: string;
  docsSource?: string;
  refreshHours?: number;
  timeoutMs?: number;
}

interface SearchResult {
  page: ShelbyDocPage;
  score: number;
  snippet: string;
}

export class ShelbyDocsService {
  private readonly cacheFile: string;
  private readonly docsSource: string;
  private readonly refreshHours: number;
  private readonly timeoutMs: number;
  private snapshot: ShelbyDocsSnapshot | undefined;
  private loadPromise: Promise<ShelbyDocsSnapshot> | undefined;

  constructor(options: ServiceOptions = {}) {
    this.cacheFile = options.cacheFile ?? process.env.SHELBY_DOCS_CACHE_FILE ?? DEFAULT_CACHE_FILE;
    this.docsSource = options.docsSource ?? process.env.SHELBY_DOCS_URL ?? DEFAULT_DOCS_URL;
    this.refreshHours = options.refreshHours ?? readNumber(process.env.SHELBY_DOCS_REFRESH_HOURS, DEFAULT_REFRESH_HOURS);
    this.timeoutMs = options.timeoutMs ?? readNumber(process.env.SHELBY_DOCS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  }

  async getSnapshot(forceRefresh = false): Promise<ShelbyDocsSnapshot> {
    const snapshotIsFresh = this.snapshot ? isFresh(Date.parse(this.snapshot.fetchedAt), this.refreshHours) : false;

    if (this.snapshot && !forceRefresh && snapshotIsFresh) {
      return this.snapshot;
    }

    if (!this.loadPromise || forceRefresh || !snapshotIsFresh) {
      const load = this.loadSnapshot();
      this.loadPromise = load.finally(() => {
        if (this.loadPromise === load) {
          this.loadPromise = undefined;
        }
      });
    }

    this.snapshot = await this.loadPromise;
    return this.snapshot;
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const snapshot = await this.getSnapshot();
    const normalizedQuery = normalize(query);
    const tokens = tokenize(normalizedQuery);

    return snapshot.pages
      .map((page) => {
        const title = normalize(page.title);
        const path = normalize(page.path);
        const url = normalize(page.url);
        const body = normalize(page.text);

        let score = 0;
        if (title.includes(normalizedQuery)) {
          score += 40;
        }
        if (path.includes(normalizedQuery) || url.includes(normalizedQuery)) {
          score += 25;
        }
        if (body.includes(normalizedQuery)) {
          score += 15;
        }

        for (const token of tokens) {
          if (title.includes(token)) {
            score += 10;
          }
          if (path.includes(token) || url.includes(token)) {
            score += 6;
          }
          score += Math.min(countOccurrences(body, token), 5);
        }

        if (score === 0) {
          return undefined;
        }

        return {
          page,
          score,
          snippet: makeSnippet(page, tokens, normalizedQuery)
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.page.title.localeCompare(right.page.title);
      })
      .slice(0, limit);
  }

  async readPage(query: string): Promise<ShelbyDocPage | undefined> {
    const snapshot = await this.getSnapshot();
    const normalizedQuery = normalize(query);
    const cleanedPath = cleanPath(query);

    const exact = snapshot.pages.find((page) => {
      return [
        page.id,
        page.path,
        page.slug,
        page.title,
        page.url
      ].map(normalize).includes(normalizedQuery) || cleanedPath === page.path || cleanedPath === page.slug;
    });

    if (exact) {
      return exact;
    }

    return this.search(query, 1).then((results) => results[0]?.page);
  }

  async getPageById(id: string): Promise<ShelbyDocPage | undefined> {
    const snapshot = await this.getSnapshot();
    return snapshot.pages.find((page) => page.id === id.trim());
  }

  async listPages(prefix?: string, limit = 50): Promise<ShelbyDocPage[]> {
    const snapshot = await this.getSnapshot();
    const normalizedPrefix = normalize(prefix ?? "");

    const pages = normalizedPrefix
      ? snapshot.pages.filter((page) => {
          const haystack = normalize(`${page.title} ${page.path} ${page.slug}`);
          return haystack.includes(normalizedPrefix);
        })
      : snapshot.pages;

    return pages.slice(0, limit);
  }

  private async loadSnapshot(): Promise<ShelbyDocsSnapshot> {
    const rawText = await this.loadRawBundle();
    return {
      fetchedAt: new Date().toISOString(),
      pages: parseShelbyDocsBundle(rawText),
      source: this.docsSource
    };
  }

  private async loadRawBundle(): Promise<string> {
    const cache = await readCacheFile(this.cacheFile);
    // Only trust a fresh cache if it actually looks like the docs bundle (not a stale
    // capture of a bot-checkpoint HTML page from a previous broken run).
    if (cache && isFresh(cache.updatedAtMs, this.refreshHours) && looksLikeDocsBundle(cache.text)) {
      return cache.text;
    }

    try {
      const freshText = await readSourceText(this.docsSource, this.timeoutMs);
      if (!looksLikeDocsBundle(freshText)) {
        // Source returned something that isn't the docs bundle (commonly a bot/security
        // checkpoint page served with HTTP 200). Do not cache it — fall through to fallbacks.
        throw new Error(
          "fetched content does not look like the Shelby docs bundle (the source may be gated behind a bot/security challenge)"
        );
      }
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.writeFile(this.cacheFile, freshText, "utf8");
      return freshText;
    } catch (error) {
      // 1) A stale but still-valid cache beats nothing.
      if (cache && looksLikeDocsBundle(cache.text)) {
        return cache.text;
      }

      // 2) The offline snapshot shipped with the package.
      const bundled = await readBundledFallback();
      if (bundled && looksLikeDocsBundle(bundled)) {
        return bundled;
      }

      const details = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to load Shelby documentation from ${this.docsSource} and no valid cache or bundled fallback was available: ${details}`
      );
    }
  }
}

export function formatSearchResults(query: string, snapshot: ShelbyDocsSnapshot, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No Shelby documentation matches found for "${query}".`;
  }

  const lines = [
    `Top Shelby documentation matches for "${query}":`,
    `Source: ${snapshot.source}`,
    `Pages indexed: ${snapshot.pages.length}`,
    ""
  ];

  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.page.title}`);
    lines.push(`   ID: ${result.page.id}`);
    lines.push(`   Path: ${result.page.path}`);
    lines.push(`   URL: ${result.page.url}`);
    lines.push(`   Snippet: ${result.snippet}`);
  });

  return lines.join("\n");
}

export function formatPage(page: ShelbyDocPage, maxChars = 6000): string {
  const header = [
    `# ${page.title}`,
    `ID: ${page.id}`,
    `Path: ${page.path}`,
    `URL: ${page.url}`,
    ""
  ].join("\n");

  const budget = Math.max(maxChars - header.length, 400);
  const body = page.text.length > budget ? `${page.text.slice(0, budget).trimEnd()}\n\n[truncated]` : page.text;
  return `${header}${body}`.trimEnd();
}

export function formatPageList(pages: ShelbyDocPage[], prefix?: string): string {
  if (pages.length === 0) {
    return prefix
      ? `No Shelby documentation pages matched "${prefix}".`
      : "No Shelby documentation pages are currently available.";
  }

  const lines = [
    prefix ? `Shelby documentation pages matching "${prefix}" (${pages.length}):` : `Shelby documentation pages (${pages.length}):`,
    ""
  ];

  pages.forEach((page, index) => {
    lines.push(`${index + 1}. ${page.title} | ${page.path} | ${page.id}`);
  });

  return lines.join("\n");
}

function parseShelbyDocsBundle(rawText: string): ShelbyDocPage[] {
  const marker = /^#\s+(.+?)\s+\((\/[^)\s]*)\)\s*/gm;
  const matches = Array.from(rawText.matchAll(marker));
  const pages: ShelbyDocPage[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) {
      continue;
    }

    const markerTitle = stripMarkdown(match[1] ?? "").trim();
    const path = normalizeDocPath(match[2] ?? "/");
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? rawText.length;
    const text = rawText.slice(start, end).trim();
    const slug = path === "/" ? "index" : path.replace(/^\/+/, "");
    const title = extractPrimaryTitle(text) ?? markerTitle;

    pages.push({
      id: String(index).padStart(5, "0"),
      path,
      slug,
      title: title || titleFromPath(path),
      text,
      url: toDocUrl(path),
      summary: extractSummary(text)
    });
  }

  return pages;
}

function extractSummary(text: string): string {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = stripMarkdown(line).trim();
    if (!trimmed || trimmed.startsWith("import ")) {
      continue;
    }

    return trimmed.length > 220 ? `${trimmed.slice(0, 217).trimEnd()}...` : trimmed;
  }

  return "No summary available.";
}

function extractPrimaryTitle(text: string): string | undefined {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+/.test(trimmed)) {
      return stripMarkdown(trimmed.replace(/^#\s+/, "")).trim();
    }
  }

  return undefined;
}

function makeSnippet(page: ShelbyDocPage, tokens: string[], normalizedQuery: string): string {
  const candidates = page.text
    .split(/\r?\n/)
    .map((line) => stripMarkdown(line).trim())
    .filter(Boolean);

  const match = candidates.find((line) => {
    const normalizedLine = normalize(line);
    return normalizedLine.includes(normalizedQuery) || tokens.some((token) => normalizedLine.includes(token));
  });

  const snippet = match ?? page.summary;
  return snippet.length > 220 ? `${snippet.slice(0, 217).trimEnd()}...` : snippet;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/.:_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return Array.from(new Set(value.split(/\s+/).filter((part) => part.length >= 2)));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let start = 0;

  while (start >= 0) {
    start = haystack.indexOf(needle, start);
    if (start >= 0) {
      count += 1;
      start += needle.length;
    }
  }

  return count;
}

function normalizeDocPath(path: string): string {
  const value = path.trim();
  if (!value || value === "/") {
    return "/";
  }

  return `/${value.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function cleanPath(input: string): string {
  const value = input.trim();
  if (!value) {
    return "";
  }

  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const url = new URL(value);
      return normalizeDocPath(url.pathname);
    }
  } catch {
    return normalizeDocPath(value);
  }

  return normalizeDocPath(value);
}

function titleFromPath(path: string): string {
  if (path === "/") {
    return "Home";
  }

  const lastSegment = path.split("/").filter(Boolean).at(-1) ?? path;
  return lastSegment
    .split("-")
    .map((part) => (part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function toDocUrl(path: string): string {
  return path === "/" ? "https://docs.shelby.xyz/" : `https://docs.shelby.xyz${path}`;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCacheFile(cacheFile: string): Promise<{ text: string; updatedAtMs: number } | undefined> {
  try {
    const [text, stats] = await Promise.all([
      fs.readFile(cacheFile, "utf8"),
      fs.stat(cacheFile)
    ]);

    return {
      text,
      updatedAtMs: stats.mtimeMs
    };
  } catch {
    return undefined;
  }
}

function isFresh(updatedAtMs: number, refreshHours: number): boolean {
  const maxAgeMs = refreshHours * 60 * 60 * 1000;
  return Date.now() - updatedAtMs <= maxAgeMs;
}

async function readSourceText(source: string, timeoutMs: number): Promise<string> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return readHttpSource(source, timeoutMs);
  }

  if (source.startsWith("file://")) {
    return fs.readFile(fileURLToPath(source), "utf8");
  }

  return fs.readFile(source, "utf8");
}

async function readHttpSource(source: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(source, {
      signal: controller.signal,
      headers: {
        "accept": "text/plain,text/markdown;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 (compatible; shelby-docs-mcp/1.0; +https://github.com/Jr-kenny/shelby-mcp)"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
