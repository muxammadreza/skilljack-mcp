#!/usr/bin/env node
/**
 * Skilljack MCP - "I know kung fu."
 *
 * MCP server that jacks Agent Skills directly into your LLM's brain.
 * Provides global skills with tools for progressive disclosure.
 *
 * Usage:
 *   skilljack-mcp /path/to/skills [/path2 ...]           # Local directories
 *   skilljack-mcp --static /path/to/skills               # Static mode (no file watching)
 *   skilljack-mcp github.com/owner/repo                  # GitHub repository
 *   skilljack-mcp /local github.com/owner/repo           # Mixed local + GitHub
 *   SKILLS_DIR=/path,github.com/owner/repo skilljack-mcp # Via environment
 *   SKILLJACK_STATIC=true skilljack-mcp                  # Static mode via env
 *   (or configure local directories via the skill-config UI)
 *
 * Options:
 *   --static  Freeze skills list at startup. Disables file watching and
 *             tools/prompts listChanged notifications. Resource subscriptions
 *             remain fully dynamic.
 */

import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import chokidar from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, createSkillMap, applyInvocationOverrides, SkillSource, DEFAULT_SKILL_SOURCE, BUNDLED_SKILL_SOURCE, warnLargeSkillCount } from "./skill-discovery.js";
import { registerSkillTool, getToolDescription, SkillState } from "./skill-tool.js";
import { registerSkillResources } from "./skill-resources.js";
import { registerSkillPrompts, refreshPrompts, PromptRegistry } from "./skill-prompts.js";
import {
  createSubscriptionManager,
  registerSubscriptionHandlers,
  refreshSubscriptions,
  SubscriptionManager,
} from "./subscriptions.js";
import { getActiveDirectories, getSkillInvocationOverrides, getStaticModeFromConfig } from "./skill-config.js";
import { registerSkillConfigTool } from "./skill-config-tool.js";
import { registerSkillDisplayTool } from "./skill-display-tool.js";
import {
  isGitHubUrl,
  parseGitHubUrl,
  isRepoAllowed,
  getGitHubConfig,
  GitHubRepoSpec,
  getRepoCachePath,
} from "./github-config.js";
import { syncAllRepos, SyncOptions } from "./github-sync.js";
import { createPollingManager, PollingManager } from "./github-polling.js";

/**
 * Subdirectories to check for skills within the configured directory.
 */
const SKILL_SUBDIRS = [".claude/skills", "skills"];

/**
 * Get the path to bundled skills directory.
 * Resolves relative to the compiled module location.
 */
function getBundledSkillsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // From dist/index.js, go up one level to package root, then into skills/
  return path.resolve(currentDir, "..", "skills");
}

/**
 * Map from directory path to its source information.
 * Used to tag discovered skills with their origin.
 */
interface DirectorySourceMap {
  [dirPath: string]: SkillSource;
}

/**
 * Build a directory-to-source map from current configuration.
 * Maps both main directories and their standard subdirectories.
 *
 * @param localDirs - Local skill directories
 * @param githubSpecs - GitHub repository specifications
 * @param cacheDir - GitHub cache directory path
 * @param bundledDir - Optional bundled skills directory
 */
function buildDirectorySourceMap(
  localDirs: string[],
  githubSpecs: GitHubRepoSpec[],
  cacheDir: string,
  bundledDir?: string
): DirectorySourceMap {
  const map: DirectorySourceMap = {};

  // Map local directories
  for (const dir of localDirs) {
    const source: SkillSource = {
      type: "local",
      displayName: "Local",
      prefix: path.basename(dir),
    };
    map[dir] = source;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(dir, subdir)] = source;
    }
  }

  // Map GitHub cache directories
  for (const spec of githubSpecs) {
    const cachePath = getRepoCachePath(spec, cacheDir);
    const source: SkillSource = {
      type: "github",
      displayName: `${spec.owner}/${spec.repo}`,
      prefix: `${spec.owner}-${spec.repo}`,
      owner: spec.owner,
      repo: spec.repo,
    };
    map[cachePath] = source;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(cachePath, subdir)] = source;
    }
  }

  // Map bundled skills directory
  if (bundledDir) {
    map[bundledDir] = BUNDLED_SKILL_SOURCE;
    // Also map standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      map[path.join(bundledDir, subdir)] = BUNDLED_SKILL_SOURCE;
    }
  }

  return map;
}

/**
 * Current skill directories (mutable to support UI-driven changes).
 * This includes both local directories and GitHub cache directories.
 */
let currentSkillsDirs: string[] = [];

/**
 * GitHub specs that are currently being polled.
 */
let currentGithubSpecs: GitHubRepoSpec[] = [];

/**
 * Current directory-to-source map for skill discovery.
 * Maps directory paths to their source info (local or GitHub).
 */
let currentSourceMap: DirectorySourceMap = {};

/**
 * Check if static mode is enabled.
 * Static mode freezes the skills list at startup - no file watching,
 * no listChanged notifications for tools/prompts.
 * Priority: CLI flag > env var > config file
 */
export function getStaticMode(): boolean {
  // Check CLI flag (highest priority)
  const args = process.argv.slice(2);
  if (args.includes("--static")) {
    return true;
  }

  // Check environment variable
  const envValue = process.env.SKILLJACK_STATIC?.toLowerCase();
  if (envValue === "true" || envValue === "1" || envValue === "yes") {
    return true;
  }

  // Check config file (lowest priority)
  return getStaticModeFromConfig();
}

export type SkilljackTransportMode = "stdio" | "http";

/**
 * Select the MCP transport mode.
 *
 * stdio remains the default for desktop MCP clients. ChatGPT connectors require
 * a reachable Streamable HTTP endpoint, enabled via --http or SKILLJACK_TRANSPORT=http.
 */
export function getTransportMode(): SkilljackTransportMode {
  const args = process.argv.slice(2);
  const envValue = process.env.SKILLJACK_TRANSPORT?.toLowerCase();

  if (args.includes("--http") || args.includes("--streamable-http")) {
    return "http";
  }

  const transportArg = args.find((arg) => arg.startsWith("--transport="));
  if (transportArg) {
    const value = transportArg.split("=", 2)[1]?.toLowerCase();
    if (value === "http" || value === "streamable-http") {
      return "http";
    }
    if (value === "stdio") {
      return "stdio";
    }
  }

  if (envValue === "http" || envValue === "streamable-http") {
    return "http";
  }

  return "stdio";
}

function getHttpHost(): string {
  return process.env.SKILLJACK_HOST || "127.0.0.1";
}

function getHttpPort(): number {
  const rawPort = process.env.SKILLJACK_PORT || process.env.PORT || "3099";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HTTP port: ${rawPort}`);
  }
  return port;
}

function getMcpPath(): string {
  const rawPath = process.env.SKILLJACK_MCP_PATH || "/mcp";
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  jsonResponse(res, 404, { error: "not_found" });
}

interface RegisteredSkilljackServer {
  server: McpServer;
  skillTool: RegisteredTool;
  promptRegistry: PromptRegistry;
  subscriptionManager: SubscriptionManager;
  dispose?: () => void;
}

type SkilljackServerFactory = () => Promise<RegisteredSkilljackServer>;

interface HttpSession extends RegisteredSkilljackServer {
  transport: StreamableHTTPServerTransport;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function isInitializeMessage(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(isInitializeMessage);
  }
  if (!body || typeof body !== "object") {
    return false;
  }
  return (body as { method?: unknown }).method === "initialize";
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcpPath: string,
  sessions: Map<string, HttpSession>,
  createServerForSession: SkilljackServerFactory
): Promise<void> {
  const baseUrl = `http://${req.headers.host || "localhost"}`;
  const url = new URL(req.url || "/", baseUrl);

  if (url.pathname === "/healthz") {
    jsonResponse(res, 200, { ok: true, transport: "http", path: mcpPath });
    return;
  }

  if (url.pathname !== mcpPath) {
    notFound(res);
    return;
  }

  const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
  let session = sessionId ? sessions.get(sessionId) : undefined;
  let parsedBody: unknown | undefined;

  if (!session && req.method === "POST") {
    try {
      parsedBody = await readJsonRequestBody(req);
    } catch {
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return;
    }

    if (!isInitializeMessage(parsedBody)) {
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid MCP session ID provided" },
        id: null,
      });
      return;
    }

    session = await createHttpSession(sessions, createServerForSession);
  }

  if (!session) {
    jsonResponse(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid MCP session ID provided" },
      id: null,
    });
    return;
  }

  await session.transport.handleRequest(req, res, parsedBody);
}

async function createHttpSession(
  sessions: Map<string, HttpSession>,
  createServerForSession: SkilljackServerFactory
): Promise<HttpSession> {
  let session: HttpSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
    },
  });
  const registeredServer = await createServerForSession();
  session = { ...registeredServer, transport };

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
    registeredServer.dispose?.();
  };

  await registeredServer.server.connect(transport);
  return session;
}

async function connectHttp(createServerForSession: SkilljackServerFactory): Promise<void> {
  const host = getHttpHost();
  const port = getHttpPort();
  const mcpPath = getMcpPath();
  const sessions = new Map<string, HttpSession>();

  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res, mcpPath, sessions, createServerForSession).catch((error: unknown) => {
      console.error("Error handling MCP HTTP request:", error);
      if (!res.headersSent) {
        jsonResponse(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.error(`Skilljack HTTP MCP endpoint ready at http://${host}:${port}${mcpPath}`);
}

/**
 * Classify paths as local directories or GitHub repositories.
 * GitHub URLs are detected by checking for "github.com" in the path.
 */
export function classifyPaths(paths: string[]): {
  localDirs: string[];
  githubSpecs: GitHubRepoSpec[];
} {
  const localDirs: string[] = [];
  const githubSpecs: GitHubRepoSpec[] = [];

  for (const p of paths) {
    if (isGitHubUrl(p)) {
      try {
        const spec = parseGitHubUrl(p);
        githubSpecs.push(spec);
      } catch (error) {
        console.error(`Warning: Invalid GitHub URL "${p}": ${error}`);
      }
    } else {
      // Local directory - resolve the path
      localDirs.push(path.resolve(p));
    }
  }

  // Deduplicate local dirs
  const uniqueLocalDirs = [...new Set(localDirs)];

  // Deduplicate GitHub specs by owner/repo
  const seenRepos = new Set<string>();
  const uniqueGithubSpecs = githubSpecs.filter((spec) => {
    const key = `${spec.owner}/${spec.repo}`;
    if (seenRepos.has(key)) {
      return false;
    }
    seenRepos.add(key);
    return true;
  });

  return { localDirs: uniqueLocalDirs, githubSpecs: uniqueGithubSpecs };
}

/**
 * Shared state for skill management.
 * Tools and resources reference this state.
 */
const skillState: SkillState = {
  skillMap: new Map(),
};

/**
 * Discover skills from multiple configured directories.
 * Each directory is checked along with its standard subdirectories.
 * Handles duplicate skill names by keeping first occurrence.
 *
 * @param skillsDirs - The skill directories to scan
 * @param sourceMap - Map from directory paths to source info
 */
function discoverSkillsFromDirs(
  skillsDirs: string[],
  sourceMap: DirectorySourceMap
): ReturnType<typeof discoverSkills> {
  const allSkills: ReturnType<typeof discoverSkills> = [];
  const seenNames = new Map<string, string>(); // name -> source directory

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) {
      console.error(`Warning: Skills directory not found: ${skillsDir}`);
      continue;
    }

    console.error(`Scanning skills directory: ${skillsDir}`);

    // Get source info for this directory (default to local if not in map)
    const dirSource = sourceMap[skillsDir] || DEFAULT_SKILL_SOURCE;

    // Check if the directory itself contains skills
    const dirSkills = discoverSkills(skillsDir, dirSource);

    // Also check standard subdirectories
    for (const subdir of SKILL_SUBDIRS) {
      const subPath = path.join(skillsDir, subdir);
      if (fs.existsSync(subPath)) {
        // Use subpath source if available, otherwise inherit from parent
        const subSource = sourceMap[subPath] || dirSource;
        dirSkills.push(...discoverSkills(subPath, subSource));
      }
    }

    // Add skills, checking for duplicates
    for (const skill of dirSkills) {
      if (seenNames.has(skill.name)) {
        console.error(
          `Warning: Duplicate skill "${skill.name}" found in ${path.dirname(skill.path)} ` +
            `(already loaded from ${seenNames.get(skill.name)})`
        );
        continue; // Skip duplicate
      }
      seenNames.set(skill.name, path.dirname(skill.path));
      allSkills.push(skill);
    }
  }

  return allSkills;
}

/**
 * Debounce delay for skill directory changes (ms).
 * Multiple rapid changes are coalesced into one refresh.
 */
const SKILL_REFRESH_DEBOUNCE_MS = 500;

/**
 * Refresh skills and notify clients of changes.
 * Called when skill files change on disk.
 *
 * @param skillsDirs - The configured skill directories
 * @param server - The MCP server instance
 * @param skillTool - The registered skill tool to update
 * @param promptRegistry - For refreshing skill prompts
 * @param subscriptionManager - For refreshing resource subscriptions
 */
function refreshSkills(
  skillsDirs: string[],
  server: McpServer,
  skillTool: RegisteredTool,
  promptRegistry: PromptRegistry,
  subscriptionManager: SubscriptionManager
): void {
  console.error("Refreshing skills...");

  // Re-discover all skills using current source map
  let skills = discoverSkillsFromDirs(skillsDirs, currentSourceMap);
  const oldCount = skillState.skillMap.size;

  // Apply invocation overrides from config
  const overrides = getSkillInvocationOverrides();
  skills = applyInvocationOverrides(skills, overrides);

  // Update shared state
  skillState.skillMap = createSkillMap(skills);

  console.error(`Skills refreshed: ${oldCount} -> ${skills.length} skill(s)`);
  warnLargeSkillCount(skills.length);

  // Update the skill tool description with new instructions
  skillTool.update({
    description: getToolDescription(skillState),
  });

  // Refresh prompts to match new skill state
  refreshPrompts(server, skillState, promptRegistry);

  // Refresh resource subscriptions to match new skill state
  refreshSubscriptions(subscriptionManager, skillState, (uri) => {
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  });

  // Notify clients that tools have changed
  // This prompts clients to call tools/list again
  server.sendToolListChanged();

  // Also notify that resources have changed
  server.sendResourceListChanged();

  // The SEP-2640 index resource always changes when the skill list changes,
  // even when no individual SKILL.md was modified (e.g., a skill was added
  // or removed). Emit an explicit update notification so subscribed clients
  // refetch.
  server.server.notification({
    method: "notifications/resources/updated",
    params: { uri: "skill://index.json" },
  });
}

/**
 * Set up file watchers on skill directories to detect changes.
 * Watches for SKILL.md additions, modifications, and deletions.
 *
 * @param skillsDirs - The configured skill directories
 * @param onChange - Callback that refreshes all active MCP server instances.
 */
function watchSkillDirectories(
  skillsDirs: string[],
  onChange: () => void
): void {
  let refreshTimeout: NodeJS.Timeout | null = null;

  const debouncedRefresh = () => {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refreshTimeout = null;
      onChange();
    }, SKILL_REFRESH_DEBOUNCE_MS);
  };

  // Build list of paths to watch
  const watchPaths: string[] = [];
  for (const dir of skillsDirs) {
    if (fs.existsSync(dir)) {
      watchPaths.push(dir);
      // Also watch standard subdirectories
      for (const subdir of SKILL_SUBDIRS) {
        const subPath = path.join(dir, subdir);
        if (fs.existsSync(subPath)) {
          watchPaths.push(subPath);
        }
      }
    }
  }

  if (watchPaths.length === 0) {
    console.error("No skill directories to watch");
    return;
  }

  console.error(`Watching for skill changes in: ${watchPaths.join(", ")}`);

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 2, // Watch skill subdirectories but not too deep
    ignored: ["**/node_modules/**", "**/.git/**"],
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  // Watch for SKILL.md changes specifically
  watcher.on("add", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill added: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("change", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill modified: ${filePath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlink", (filePath) => {
    if (path.basename(filePath).toLowerCase() === "skill.md") {
      console.error(`Skill removed: ${filePath}`);
      debouncedRefresh();
    }
  });

  // Also watch for directory additions (new skill folders)
  watcher.on("addDir", (dirPath) => {
    // Check if this might be a new skill directory
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const skillMdPathLower = path.join(dirPath, "skill.md");
    if (fs.existsSync(skillMdPath) || fs.existsSync(skillMdPathLower)) {
      console.error(`Skill directory added: ${dirPath}`);
      debouncedRefresh();
    }
  });

  watcher.on("unlinkDir", (dirPath) => {
    // A skill directory was removed
    console.error(`Directory removed: ${dirPath}`);
    debouncedRefresh();
  });
}

async function main() {
  // Check if static mode is enabled
  const isStatic = getStaticMode();

  // Get skill directories from CLI args, env var, or config file
  // This returns paths that may include GitHub URLs
  const allPaths = getActiveDirectories();

  // Classify paths as local or GitHub
  const { localDirs, githubSpecs } = classifyPaths(allPaths);

  // Get GitHub configuration
  const githubConfig = getGitHubConfig();

  // Sync GitHub repositories
  let githubDirs: string[] = [];

  if (githubSpecs.length > 0) {
    console.error(`GitHub repos: ${githubSpecs.map((s) => `${s.owner}/${s.repo}`).join(", ")}`);

    // Filter by allowlist
    for (const spec of githubSpecs) {
      if (!isRepoAllowed(spec, githubConfig)) {
        console.error(
          `Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users. ` +
            `Set GITHUB_ALLOWED_ORGS or GITHUB_ALLOWED_USERS to permit.`
        );
        continue;
      }
      currentGithubSpecs.push(spec);
    }

    if (currentGithubSpecs.length > 0) {
      console.error(`Syncing ${currentGithubSpecs.length} GitHub repo(s)...`);

      const syncOptions: SyncOptions = {
        cacheDir: githubConfig.cacheDir,
        token: githubConfig.token,
        shallowClone: true,
      };

      const results = await syncAllRepos(currentGithubSpecs, syncOptions);

      // Collect successful sync paths
      for (const result of results) {
        if (!result.error) {
          githubDirs.push(result.localPath);
        }
      }

      console.error(`Successfully synced ${githubDirs.length}/${currentGithubSpecs.length} repo(s)`);
    }
  }

  // Get bundled skills directory (ships with the package)
  const bundledSkillsDir = getBundledSkillsDir();
  const hasBundledSkills = fs.existsSync(bundledSkillsDir);

  // Combine all skill directories
  // User directories come first so they can override bundled skills (first-wins deduplication)
  currentSkillsDirs = [...localDirs, ...githubDirs, ...(hasBundledSkills ? [bundledSkillsDir] : [])];

  // Build source map for skill discovery
  currentSourceMap = buildDirectorySourceMap(
    localDirs,
    currentGithubSpecs,
    githubConfig.cacheDir,
    hasBundledSkills ? bundledSkillsDir : undefined
  );

  // Log configured directories
  if (localDirs.length > 0) {
    console.error(`Local directories: ${localDirs.join(", ")}`);
  }
  if (githubDirs.length > 0) {
    console.error(`GitHub cache directories: ${githubDirs.join(", ")}`);
  }
  if (hasBundledSkills) {
    console.error(`Bundled skills: ${bundledSkillsDir}`);
  }

  if (isStatic) {
    console.error("Static mode enabled - skills list frozen at startup");
  }

  // Discover skills at startup
  let skills = discoverSkillsFromDirs(currentSkillsDirs, currentSourceMap);

  // Apply invocation overrides from config
  const overrides = getSkillInvocationOverrides();
  skills = applyInvocationOverrides(skills, overrides);

  skillState.skillMap = createSkillMap(skills);
  console.error(`Discovered ${skills.length} skill(s)`);
  warnLargeSkillCount(skills.length);

  const registeredServers = new Set<RegisteredSkilljackServer>();

  const refreshSharedSkillState = () => {
    let refreshedSkills = discoverSkillsFromDirs(currentSkillsDirs, currentSourceMap);
    const overrides = getSkillInvocationOverrides();
    refreshedSkills = applyInvocationOverrides(refreshedSkills, overrides);
    skillState.skillMap = createSkillMap(refreshedSkills);
    warnLargeSkillCount(refreshedSkills.length);
  };

  const refreshRegisteredServer = (registeredServer: RegisteredSkilljackServer) => {
    refreshSkills(
      currentSkillsDirs,
      registeredServer.server,
      registeredServer.skillTool,
      registeredServer.promptRegistry,
      registeredServer.subscriptionManager
    );
  };

  const refreshAllServers = () => {
    if (registeredServers.size === 0) {
      refreshSharedSkillState();
      return;
    }

    for (const registeredServer of registeredServers) {
      refreshRegisteredServer(registeredServer);
    }
  };

  const createRegisteredServer = async (): Promise<RegisteredSkilljackServer> => {
    // Create a fresh MCP protocol/server instance for each transport connection.
    // The MCP SDK Protocol object owns exactly one transport, so Streamable HTTP
    // sessions must not share one McpServer instance.
    const server = new McpServer(
      {
        name: "skilljack-mcp",
        version: "1.0.0",
      },
      {
        instructions:
          "Use the skill tool to load skill instructions when a user's task matches a skill's description. " +
          "First call the skill tool with the matching skill name, then follow the step-by-step instructions it returns. " +
          "Use skill-resource to read supporting files (scripts, templates, references) within a skill directory. " +
          "Consult skill://index.json to discover all available skills and their descriptions.",
        capabilities: {
          tools: { listChanged: !isStatic },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: !isStatic },
          // SEP-2640 (Skills Extension): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
          extensions: {
            "io.modelcontextprotocol/skills": {},
            "io.modelcontextprotocol/ui": {},
          },
        },
      }
    );

    const localSubscriptionManager = createSubscriptionManager();

    // Register tools, resources, and prompts against this server instance.
    const skillTool = registerSkillTool(server, skillState);
    registerSkillResources(server, skillState);
    const promptRegistry = registerSkillPrompts(server, skillState);
    registerSubscriptionHandlers(server, skillState, localSubscriptionManager);

    const registeredServer: RegisteredSkilljackServer = {
      server,
      skillTool,
      promptRegistry,
      subscriptionManager: localSubscriptionManager,
    };
    registeredServer.dispose = () => {
      registeredServers.delete(registeredServer);
    };
    registeredServers.add(registeredServer);

    // Register skill-config tool for UI-based directory configuration.
    // Skip in static mode since skills list is frozen.
    if (!isStatic) {
      registerSkillConfigTool(server, skillState, async () => {
        // Callback when directories or GitHub settings change via UI.
        // Reload directories from config and refresh all active sessions.
        const newPaths = getActiveDirectories();
        const { localDirs: newLocalDirs, githubSpecs: newGithubSpecs } = classifyPaths(newPaths);

        // Get fresh GitHub config (in case allowed orgs/users changed).
        const freshGithubConfig = getGitHubConfig();

        // Filter GitHub specs by allowlist and sync.
        const allowedGithubSpecs: GitHubRepoSpec[] = [];
        for (const spec of newGithubSpecs) {
          if (isRepoAllowed(spec, freshGithubConfig)) {
            allowedGithubSpecs.push(spec);
          } else {
            console.error(`Blocked: ${spec.owner}/${spec.repo} not in allowed orgs/users.`);
          }
        }

        // Sync any GitHub repos.
        let newGithubDirs: string[] = [];
        if (allowedGithubSpecs.length > 0) {
          console.error(`Syncing ${allowedGithubSpecs.length} GitHub repo(s)...`);
          const syncOptions: SyncOptions = {
            cacheDir: freshGithubConfig.cacheDir,
            token: freshGithubConfig.token,
            shallowClone: true,
          };
          const results = await syncAllRepos(allowedGithubSpecs, syncOptions);
          for (const result of results) {
            if (!result.error) {
              newGithubDirs.push(result.localPath);
            }
          }
          console.error(`Successfully synced ${newGithubDirs.length}/${allowedGithubSpecs.length} repo(s)`);
        }

        // Update current shared state.
        currentGithubSpecs = allowedGithubSpecs;
        githubDirs = newGithubDirs;
        // Include bundled skills last, so user skills take precedence.
        currentSkillsDirs = [...newLocalDirs, ...newGithubDirs, ...(hasBundledSkills ? [bundledSkillsDir] : [])];
        currentSourceMap = buildDirectorySourceMap(
          newLocalDirs,
          allowedGithubSpecs,
          freshGithubConfig.cacheDir,
          hasBundledSkills ? bundledSkillsDir : undefined
        );

        console.error(`Config changed via UI. Directories: ${currentSkillsDirs.join(", ") || "(none)"}`);
        refreshAllServers();
      });

      // Register skill-display tool for UI-based invocation settings.
      registerSkillDisplayTool(server, skillState, () => {
        // Callback when invocation settings change via UI.
        console.error("Invocation settings changed via UI. Refreshing skills...");
        refreshAllServers();
      });
    }

    return registeredServer;
  };

  // Set up file watchers for skill directory changes once per process (skip in static mode).
  if (!isStatic && currentSkillsDirs.length > 0) {
    watchSkillDirectories(currentSkillsDirs, refreshAllServers);
  }

  // Set up GitHub polling for updates once per process (skip in static mode).
  let pollingManager: PollingManager | null = null;
  if (!isStatic && currentGithubSpecs.length > 0 && githubConfig.pollIntervalMs > 0) {
    const syncOptions: SyncOptions = {
      cacheDir: githubConfig.cacheDir,
      token: githubConfig.token,
      shallowClone: true,
    };

    pollingManager = createPollingManager(currentGithubSpecs, syncOptions, {
      intervalMs: githubConfig.pollIntervalMs,
      onUpdate: (spec, result) => {
        console.error(`GitHub update detected for ${spec.owner}/${spec.repo}`);
        refreshAllServers();
      },
      onError: (spec, error) => {
        console.error(`GitHub polling error for ${spec.owner}/${spec.repo}: ${error.message}`);
      },
    });

    pollingManager.start();
  }

  const transportMode = getTransportMode();
  if (transportMode === "http") {
    await connectHttp(createRegisteredServer);
  } else {
    const registeredServer = await createRegisteredServer();
    const transport = new StdioServerTransport();
    await registeredServer.server.connect(transport);
    console.error("Skilljack ready over stdio. I know kung fu.");
  }

}

// Only run main() when executed directly (not when imported by tests)
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith("skilljack-mcp") ||
   process.argv[1] === fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
