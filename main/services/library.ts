import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { app, ipcMain, logger, shell } from "../electron/runtime.js";

import {
  HARNESS_IDS,
  type HandoffResult,
  type HarnessId,
  type LibrarySnapshot,
  type MemoryDetail,
  type MemorySummary,
  type PathMatch,
  type ProjectSummary,
  type ScanError,
  type SessionDetail,
  type SessionSummary,
  type TranscriptEntry,
  type TrashResult,
} from "../shared/types.js";
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_ROOT,
  readClaudeSession,
  scanClaudeCode,
} from "./harnesses/claude-code.js";
import {
  CODEX_ROOT,
  CODEX_SESSION_DIRS,
  isCodexMemoryPath,
  readCodexMemory,
  readCodexSession,
  scanCodex,
} from "./harnesses/codex.js";
import { CURSOR_USER_DIR, readCursorSession, scanCursor } from "./harnesses/cursor.js";
import {
  OPENCODE_CONFIG_DIR,
  opencodeStorageDir,
  deleteOpencodeSession,
  exportOpencodeSession,
  opencodeTrashBlocked,
  readOpencodeSession,
  scanOpencode,
  OPENCODE_V2_DB,
} from "./harnesses/opencode.js";
import { buildHandoff, handoffFileName } from "./handoff.js";
import { scanProjectMemories } from "./memory-files.js";
import { ANTIGRAVITY_CLI_DIR, isAbsolutePath, isInside, TRASH_NAME } from "./platform.js";
import { getPreferences, updatePreferences, type Preferences } from "./preferences.js";
import { HOME, pathExists, statOrNull, writeFileAtomic } from "./util.js";
import { readAntigravitySession, scanAntigravity } from "./harnesses/antigravity.js";
import { MAX_ENTRIES } from "./harnesses/limits.js";
import { HARNESS_NAMES } from "../shared/harnesses.js";

const MAX_MEMORY_READ_BYTES = 2 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 2500;

let snapshot: LibrarySnapshot | null = null;
let inflight: Promise<LibrarySnapshot> | null = null;

async function settle<T>(
  harness: HarnessId,
  errors: ScanError[],
  fallback: T,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("library", `${HARNESS_NAMES[harness]} scan failed: ${message}`);
    errors.push({ harness, message });
    return fallback;
  }
}

async function detectAvailability(): Promise<Record<HarnessId, boolean>> {
  const [claude, codex, cursor, opencodeData, opencodeV2Db, opencodeConfig, antigravityData] =
    await Promise.all([
      pathExists(CLAUDE_ROOT),
      pathExists(CODEX_ROOT),
      pathExists(CURSOR_USER_DIR),
      pathExists(opencodeStorageDir()),
      pathExists(OPENCODE_V2_DB),
      pathExists(OPENCODE_CONFIG_DIR),
      pathExists(ANTIGRAVITY_CLI_DIR),
    ]);
  return {
    "claude-code": claude,
    codex,
    cursor,
    opencode: opencodeData || opencodeConfig || opencodeV2Db,
    antigravity: antigravityData,
  };
}

function projectName(projectPath: string, prefs: Preferences): string {
  const custom = prefs.projectNames[projectPath];
  if (custom) return custom;
  if (projectPath === HOME) return "Home";
  return path.basename(projectPath) || projectPath;
}

function relocate(cwd: string | null, changes: Record<string, string>): string | null {
  let currentDir = cwd;
  // a few hops in our directories is enough, the cap would stop a cycle.
  for (let hop = 0; currentDir && hop < 8; hop++) {
    const from = Object.keys(changes).find((old) => isInside(currentDir!, old));
    if (!from) break;
    currentDir = path.join(changes[from], path.relative(from, currentDir));
  }

  return currentDir;
}

// Wrapper for stat.isDirectory()
export async function isDirectory(target: string): Promise<boolean> {
  return fs.promises.stat(target).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/** Find the closest folder above "target" in the file tree that still exists,
 * it then serves as the starting point for the folder picker.
 */
export async function nearestExistingFolder(target: string): Promise<string> {
  let currentDir = path.dirname(target);
  while (!(await isDirectory(currentDir)) && path.dirname(currentDir) !== currentDir) {
    currentDir = path.dirname(currentDir);
  }

  return currentDir;
}

/**
 * Why a session can't be moved to the Trash from Wefty, or undefined if it can. Claude Code and
 * Codex keep one file per session; Opencode deletes through its own CLI (with a backup).
 */
function trashBlockedReason(session: SessionSummary): string | undefined {
  switch (session.harness) {
    case "claude-code":
    case "codex":
      return undefined;
    case "opencode":
      return opencodeTrashBlocked(session);
    case "antigravity":
      return "Antigravity can't delete a single conversation yet";
    case "cursor":
      return "Cursor keeps every chat in one database: delete it in Cursor";
  }
}

async function buildSnapshot(): Promise<LibrarySnapshot> {
  const startedAt = Date.now();
  const errors: ScanError[] = [];
  const emptyScan = { sessions: [] as SessionSummary[], memories: [] as MemorySummary[] };
  const prefs = await getPreferences();
  const enabled = new Set(prefs.enabledHarnesses);
  const hidden = new Set(prefs.hiddenProjects);
  const isVisible = (cwd: string | null) => !cwd || !hidden.has(cwd);

  /** Only harnesses the user added are scanned. */
  const scanIfEnabled = <T>(harness: HarnessId, fallback: T, task: () => Promise<T>): Promise<T> =>
    enabled.has(harness) ? settle(harness, errors, fallback, task) : Promise.resolve(fallback);

  const [claude, codex, cursorSessions, opencode, antigravitySessions, available] =
    await Promise.all([
      scanIfEnabled("claude-code", emptyScan, scanClaudeCode),
      scanIfEnabled("codex", emptyScan, scanCodex),
      scanIfEnabled("cursor", [] as SessionSummary[], scanCursor),
      scanIfEnabled("opencode", emptyScan, scanOpencode),
      scanIfEnabled("antigravity", [] as SessionSummary[], scanAntigravity),
      detectAvailability(),
    ]);

  const baseSessions = [
    ...claude.sessions,
    ...codex.sessions,
    ...cursorSessions,
    ...opencode.sessions,
    ...antigravitySessions,
  ];

  const changes = prefs.projectChanges;
  for (const session of baseSessions) {
    session.cwd = relocate(session.cwd, changes);
    session.trashBlocked = trashBlockedReason(session);
  }
  for (const memory of [...claude.memories, ...opencode.memories, ...codex.memories])
    memory.cwd = relocate(memory.cwd, changes);

  const projectPaths = new Set<string>();
  for (const session of baseSessions)
    if (session.cwd && isVisible(session.cwd)) projectPaths.add(session.cwd);
  for (const memory of claude.memories)
    if (memory.cwd && isVisible(memory.cwd)) projectPaths.add(memory.cwd);

  const projectMemories = (
    await Promise.all(
      [...projectPaths].map((projectPath) => scanProjectMemories(projectPath).catch(() => [])),
    )
  ).flat();

  const sessions = baseSessions
    .filter((session) => isVisible(session.cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  const memoryMap = new Map<string, MemorySummary>();
  for (const memory of [
    ...claude.memories,
    ...codex.memories,
    ...opencode.memories,
    ...projectMemories,
  ]) {
    // Shared files like AGENTS.md only appear when one of their harnesses is added.
    const harnesses = memory.harnesses.filter((harness) => enabled.has(harness));
    if (harnesses.length === 0) continue;
    const existing = memoryMap.get(memory.id);
    if (existing) {
      existing.harnesses = [...new Set([...existing.harnesses, ...harnesses])];
    } else {
      memoryMap.set(memory.id, { ...memory, harnesses });
    }
  }
  for (const memory of memoryMap.values()) {
    if (!memory.cwd && memory.sessionId)
      memory.cwd = sessionsById.get(memory.sessionId)?.cwd ?? null;
    if (!memory.cwd) memory.scope = "global";
  }
  for (const memory of memoryMap.values()) {
    if (!isVisible(memory.cwd)) memoryMap.delete(memory.id);
  }
  for (const memory of memoryMap.values()) {
    memory.links = memory.links.filter((id) => id !== memory.id && memoryMap.has(id));
  }
  const memories = [...memoryMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  const projects = new Map<string, ProjectSummary>();
  const touchProject = (
    projectPath: string,
    harnesses: HarnessId[],
    updatedAt: number,
    kind: "session" | "memory",
  ) => {
    let project = projects.get(projectPath);
    if (!project) {
      project = {
        id: projectPath,
        path: projectPath,
        name: projectName(projectPath, prefs),
        sessionCount: 0,
        memoryCount: 0,
        harnesses: [],
        updatedAt: 0,
      };
      projects.set(projectPath, project);
    }
    if (kind === "session") project.sessionCount++;
    else project.memoryCount++;
    project.harnesses = [...new Set([...project.harnesses, ...harnesses])];
    project.updatedAt = Math.max(project.updatedAt, updatedAt);
  };
  for (const session of sessions)
    if (session.cwd) touchProject(session.cwd, [session.harness], session.updatedAt, "session");
  for (const memory of memories)
    if (memory.cwd) touchProject(memory.cwd, memory.harnesses, memory.updatedAt, "memory");

  const harnesses = HARNESS_IDS.map((id) => {
    const sessionCount = sessions.filter((session) => session.harness === id).length;
    const memoryCount = memories.filter((memory) => memory.harnesses.includes(id)).length;
    return {
      id,
      name: HARNESS_NAMES[id],
      enabled: enabled.has(id),
      available: available[id] || sessionCount > 0 || memoryCount > 0,
      sessionCount,
      memoryCount,
    };
  });

  logger.info(
    "library",
    `Scanned ${sessions.length} sessions, ${memories.length} memories, ${projects.size} projects in ${Date.now() - startedAt}ms`,
  );

  return {
    home: HOME,
    harnesses,
    sessions,
    memories,
    projects: [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    hiddenProjects: prefs.hiddenProjects.map((projectPath) => ({
      path: projectPath,
      name: projectName(projectPath, prefs),
    })),
    scannedAt: Date.now(),
    errors,
  };
}

function scanLibrary(): Promise<LibrarySnapshot> {
  if (inflight) return inflight;
  inflight = buildSnapshot()
    .then((next) => {
      snapshot = next;
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getLibrary(force = false): Promise<LibrarySnapshot> {
  if (snapshot && !force) return snapshot;
  return scanLibrary();
}

export async function getSessionDetail(id: string): Promise<SessionDetail> {
  const library = await getLibrary();
  const session = library.sessions.find((candidate) => candidate.id === id);
  if (!session) throw new Error(`Session not found: ${id}`);
  let entries: TranscriptEntry[];
  switch (session.harness) {
    case "claude-code":
      entries = await readClaudeSession(session);
      break;
    case "codex":
      entries = await readCodexSession(session);
      break;
    case "cursor":
      entries = await readCursorSession(session);
      break;
    case "opencode":
      entries = await readOpencodeSession(session);
      break;
    case "antigravity":
      entries = await readAntigravitySession(session);
      break;
  }
  return {
    session,
    entries: entries.slice(0, MAX_ENTRIES),
    totalEntries: entries.length,
    truncated: entries.length >= MAX_ENTRIES,
  };
}

function findMemory(library: LibrarySnapshot, id: string): MemorySummary {
  const memory = library.memories.find((candidate) => candidate.id === id);
  if (!memory) throw new Error(`Memory not found: ${id}`);
  return memory;
}

export async function getMemoryDetail(id: string): Promise<MemoryDetail> {
  const memory = findMemory(await getLibrary(), id);
  if (isCodexMemoryPath(memory.path)) {
    return { memory, content: await readCodexMemory(memory.path) };
  }
  const stat = await fs.promises.stat(memory.path);
  if (stat.size > MAX_MEMORY_READ_BYTES) {
    throw new Error(`${memory.path} is too large to open (${Math.round(stat.size / 1024)} KB)`);
  }
  return { memory, content: await fs.promises.readFile(memory.path, "utf8") };
}

export async function saveMemory(id: string, content: string): Promise<MemorySummary> {
  const memory = findMemory(await getLibrary(), id);
  if (!memory.editable || isCodexMemoryPath(memory.path)) {
    throw new Error(`${memory.title} is read-only`);
  }
  await writeFileAtomic(memory.path, content);
  const stat = await fs.promises.stat(memory.path);
  memory.updatedAt = stat.mtimeMs;
  memory.size = stat.size;
  logger.info("library", `Saved memory ${memory.path}`);
  scheduleRescan();
  return memory;
}

/** Rebuilds the snapshot after any in-flight scan settles, then notifies every window. */
async function refreshLibrary(): Promise<LibrarySnapshot> {
  if (inflight) await inflight.catch(() => undefined);
  const next = await scanLibrary();
  ipcMain.broadcast("library:changed", { scannedAt: next.scannedAt });
  return next;
}

// --- Library management -----------------------------------------------------

export async function setHarnessEnabled(id: HarnessId, enabled: boolean): Promise<LibrarySnapshot> {
  const prefs = await getPreferences();
  if (!enabled && prefs.enabledHarnesses.length === 1 && prefs.enabledHarnesses[0] === id) {
    throw new Error("Keep at least one harness in the library");
  }
  await updatePreferences((draft) => {
    const next = new Set(draft.enabledHarnesses);
    if (enabled) next.add(id);
    else next.delete(id);
    draft.enabledHarnesses = HARNESS_IDS.filter((harness) => next.has(harness));
  });
  logger.info("library", `${enabled ? "Added" : "Removed"} harness ${HARNESS_NAMES[id]}`);
  if (watching) {
    stopWatching();
    startWatching();
  }
  return refreshLibrary();
}

export async function renameProject(
  projectPath: string,
  name: string | null,
): Promise<LibrarySnapshot> {
  await updatePreferences((draft) => {
    if (name?.trim()) draft.projectNames[projectPath] = name.trim();
    else delete draft.projectNames[projectPath];
  });
  return refreshLibrary();
}

/** Records where a moved or renamed project lives now; its name carries over. */
export async function relocateProject(from: string, to: string): Promise<LibrarySnapshot> {
  await updatePreferences((draft) => {
    draft.projectChanges[from] = to;
    const name = draft.projectNames[from];
    if (name) {
      draft.projectNames[to] = name;
      delete draft.projectNames[from];
    }
  });
  return refreshLibrary();
}

export async function setProjectHidden(
  projectPath: string,
  hidden: boolean,
): Promise<LibrarySnapshot> {
  await updatePreferences((draft) => {
    const next = new Set(draft.hiddenProjects);
    if (hidden) next.add(projectPath);
    else next.delete(projectPath);
    draft.hiddenProjects = [...next];
  });
  return refreshLibrary();
}

/**
 * Files that make up one item. Only harnesses that keep each session in its own file can trash
 * sessions; Cursor, Opencode, and Antigravity share storage across sessions.
 */
async function trashPathsFor(item: SessionSummary | MemorySummary): Promise<string[]> {
  if (item.kind === "memory") {
    if (!item.editable || !isAbsolutePath(item.path)) throw new Error(`${item.title} is read-only`);
    return [item.path];
  }
  if (item.harness === "codex") return [item.sourcePath];
  if (item.harness === "claude-code") {
    // Claude keeps subagent transcripts and tool output next to the session file.
    const sidecar = item.sourcePath.replace(/\.jsonl$/, "");
    const stat = sidecar !== item.sourcePath ? await statOrNull(sidecar) : null;
    return stat?.isDirectory() ? [item.sourcePath, sidecar] : [item.sourcePath];
  }
  throw new Error(
    `${HARNESS_NAMES[item.harness]} sessions share storage and can't be moved to the ${TRASH_NAME} individually`,
  );
}

async function trashPaths(paths: string[]): Promise<TrashResult> {
  const failed: string[] = [];
  let trashed = 0;
  for (const target of paths) {
    try {
      await shell.trashItem(target);
      trashed++;
    } catch (error) {
      logger.error(
        "library",
        `Could not trash ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed.push(target);
    }
  }
  logger.info("library", `Moved ${trashed} item(s) to the ${TRASH_NAME}`);
  return { library: await refreshLibrary(), trashed, failed };
}

/**
 * Opencode keeps all sessions in one database, so there's no file to move. Instead: export the
 * session, put that copy in the Trash, and only then delete it through opencode. Restoring it is
 * `opencode session import <copy>`.
 */
async function trashOpencodeSession(session: SessionSummary): Promise<TrashResult> {
  const json = await exportOpencodeSession(session.nativeId);
  const name = `Wefty - Opencode - ${
    session.title
      .replace(/[\\/:*?"<>|\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || session.nativeId
  }.json`;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wefty-"));
  const copy = path.join(dir, name);
  try {
    await fs.promises.writeFile(copy, json);
    // If the copy can't reach the Trash, stop here: nothing has been deleted yet.
    await shell.trashItem(copy);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await deleteOpencodeSession(session.nativeId);
  logger.info(
    "library",
    `Deleted Opencode session ${session.nativeId}; a copy is in the ${TRASH_NAME}`,
  );
  return {
    library: await refreshLibrary(),
    trashed: 1,
    failed: [],
    note: `A copy is in the ${TRASH_NAME} as “${name}”. To bring the session back, take that file out and run opencode session import on it.`,
  };
}

export async function trashItem(id: string): Promise<TrashResult> {
  const library = await getLibrary();
  const item =
    library.sessions.find((session) => session.id === id) ??
    library.memories.find((memory) => memory.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  if (item.kind === "session" && item.trashBlocked) throw new Error(item.trashBlocked);
  if (item.kind === "session" && item.harness === "opencode") return trashOpencodeSession(item);
  const result = await trashPaths(await trashPathsFor(item));
  if (result.trashed === 0) throw new Error(`Couldn't move ${item.title} to the ${TRASH_NAME}`);
  return result;
}

export async function trashProject(projectPath: string): Promise<TrashResult> {
  const library = await getLibrary();
  const items = [...library.sessions, ...library.memories].filter(
    (item) => item.cwd === projectPath,
  );
  const paths: string[] = [];
  for (const item of items) {
    const itemPaths = await trashPathsFor(item).catch(() => []);
    paths.push(...itemPaths);
  }
  if (paths.length === 0)
    throw new Error(`Nothing in this project can be moved to the ${TRASH_NAME}`);
  return trashPaths(paths);
}

/** Writes the session's handoff brief under userData/handoffs and returns it. */
export async function getHandoff(id: string): Promise<HandoffResult> {
  const detail = await getSessionDetail(id);
  const library = await getLibrary();
  const { session } = detail;
  const memories = library.memories.filter(
    (memory) => session.filesTouched.includes(memory.path) || memory.sessionId === session.id,
  );
  const markdown = buildHandoff(detail, memories);
  const dir = path.join(app.getPath("userData"), "handoffs");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, handoffFileName(session.id));
  await writeFileAtomic(file, markdown);
  return { sessionId: session.id, path: file, markdown };
}

/** Maps a path dropped from the file manager onto a library item or project. */
export async function matchPath(target: string): Promise<PathMatch> {
  const library = await getLibrary();
  const session = library.sessions.find((candidate) => candidate.sourcePath === target);
  if (session) return { kind: "item", id: session.id };
  const memory = library.memories.find((candidate) => candidate.path === target);
  if (memory) return { kind: "item", id: memory.id };
  const project = library.projects.find((candidate) => candidate.path === target);
  if (project) return { kind: "project", path: project.path };
  return { kind: "none" };
}

/** Only paths the library already knows about may be revealed in the file manager. */
export async function isKnownPath(target: string): Promise<boolean> {
  const library = await getLibrary();
  return (
    library.sessions.some((session) => session.sourcePath === target) ||
    library.memories.some((memory) => memory.path === target) ||
    library.projects.some((project) => project.path === target)
  );
}

// --- Live updates -----------------------------------------------------------

const watchers: fs.FSWatcher[] = [];
let watchTimer: NodeJS.Timeout | null = null;
let watching = false;

function scheduleRescan(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    scanLibrary()
      .then((next) => ipcMain.broadcast("library:changed", { scannedAt: next.scannedAt }))
      .catch((error: unknown) => {
        logger.error(
          "library",
          `Rescan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, WATCH_DEBOUNCE_MS);
}

function watchTargets(enabled: HarnessId[]): { dir: string; recursive: boolean }[] {
  const targets: { dir: string; recursive: boolean }[] = [];
  if (enabled.includes("claude-code")) {
    targets.push(
      { dir: CLAUDE_PROJECTS_DIR, recursive: true },
      { dir: CLAUDE_ROOT, recursive: false },
    );
  }
  if (enabled.includes("codex"))
    targets.push(...CODEX_SESSION_DIRS.map((dir) => ({ dir, recursive: true })));
  if (enabled.includes("opencode")) {
    targets.push({ dir: path.join(opencodeStorageDir(), "session"), recursive: true });
    targets.push({ dir: path.dirname(OPENCODE_V2_DB), recursive: false });
  }
  if (enabled.includes("antigravity")) {
    // The index and history sit in the root; each conversation's step log lives under brain/.
    targets.push(
      { dir: ANTIGRAVITY_CLI_DIR, recursive: false },
      { dir: path.join(ANTIGRAVITY_CLI_DIR, "brain"), recursive: true },
    );
  }
  return targets;
}

export function startWatching(): void {
  if (watching) return;
  watching = true;
  void getPreferences().then((prefs) => {
    if (watching) attachWatchers(watchTargets(prefs.enabledHarnesses));
  });
}

function attachWatchers(targets: { dir: string; recursive: boolean }[]): void {
  for (const { dir, recursive } of targets) {
    try {
      if (!fs.existsSync(dir)) continue;
      const watcher = fs.watch(dir, { recursive }, scheduleRescan);
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch (error) {
      logger.warn(
        "library",
        `Could not watch ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function stopWatching(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  for (const watcher of watchers.splice(0)) watcher.close();
  watching = false;
}
