/**
 * Antigravity CLI (`agy`). Each conversation keeps a step-by-step log at
 * brain/<id>/.system_generated/logs/transcript.jsonl, which is the transcript source. The list
 * comes from conversation_summaries.db when the sqlite3 CLI can read it (titles, workspaces,
 * and which conversations are subagents); without sqlite3 (a stock Windows machine) it is built
 * from the brain/ folders, annotations/<id>.pbtxt titles, and history.jsonl workspaces instead.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { SessionSummary, TranscriptEntry } from "../../shared/types.js";
import { ANTIGRAVITY_CLI_DIR } from "../platform.js";
import {
  assertSafeId,
  isRecord,
  oneLine,
  parseTimestamp,
  pathExists,
  querySqliteLive,
  readDirSafe,
  readJsonLines,
  statOrNull,
  str,
  truncate,
} from "../util.js";

export { ANTIGRAVITY_CLI_DIR };
/** Antigravity's index of conversations, including a plain-text copy of each for its search. */
const SUMMARIES_DB = path.join(ANTIGRAVITY_CLI_DIR, "conversation_summaries.db");
const BRAIN_DIR = path.join(ANTIGRAVITY_CLI_DIR, "brain");
const ANNOTATIONS_DIR = path.join(ANTIGRAVITY_CLI_DIR, "annotations");
const HISTORY_FILE = path.join(ANTIGRAVITY_CLI_DIR, "history.jsonl");

const MAX_ENTRIES = 3000;
const MAX_ENTRY_CHARS = 12_000;
/** Tool output kept per entry: enough for an error message, small enough for IPC. */
const MAX_RESULT_CHARS = 1200;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// Top-level conversations only: nested ones are an agent's own subagents.
const LIST_SQL = `select conversation_id as id, title, preview, step_count as steps,
  last_modified_time as updatedAt, workspace_uris as workspaces
from conversation_summaries
where nesting_depth = 0 and step_count > 0`;

/** Tools that write a file; their target counts as a file the session touched. */
const WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);
/** The argument that best describes each tool call, in order of preference. */
const KEY_ARGS = [
  "CommandLine",
  "AbsolutePath",
  "TargetFile",
  "DirectoryPath",
  "SearchDirectory",
  "Url",
  "query",
  "Pattern",
  "ToolName",
];

function transcriptPath(id: string): string {
  return path.join(BRAIN_DIR, id, ".system_generated", "logs", "transcript.jsonl");
}

/** The first workspace folder of a conversation (stored as a JSON array of file:// URIs). */
function firstWorkspace(raw: unknown): string | null {
  try {
    const uris: unknown = JSON.parse(str(raw) ?? "[]");
    const uri = Array.isArray(uris)
      ? uris.find((item): item is string => typeof item === "string" && item.startsWith("file://"))
      : undefined;
    return uri ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

/** What you typed: the text inside <USER_REQUEST>, without agy's injected metadata. */
function userRequest(content: string): string {
  const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1];
  return (
    request ?? content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
  ).trim();
}

/** Tool arguments are stored as an object whose values are JSON-encoded strings. */
function toolArgs(raw: unknown): Record<string, string> {
  const args: Record<string, string> = {};
  if (!isRecord(raw)) return args;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      args[key] = typeof parsed === "string" ? parsed : value;
    } catch {
      args[key] = value;
    }
  }
  return args;
}

function describeCall(name: string, args: Record<string, string>): string {
  const key = KEY_ARGS.find((candidate) => args[candidate]);
  if (name === "call_mcp_tool" && args.ToolName)
    return `${args.ServerName ? `${args.ServerName}: ` : ""}${args.ToolName}`;
  return oneLine(key ? args[key] : (args.toolSummary ?? ""), 200);
}

/** A tool's output, without agy's timing header; failed commands report a non-zero exit code. */
function toolOutput(content: string): { text: string; failed: boolean } {
  const text = content.replace(/^(Created At|Completed At):.*\n/gm, "").trim();
  const code = /exited with code (-?\d+)/.exec(text)?.[1];
  return { text, failed: code !== undefined && code !== "0" };
}

interface TranscriptFacts {
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  firstPrompt: string;
  filesTouched: string[];
}

const factsCache = new Map<string, { mtimeMs: number; size: number; facts: TranscriptFacts }>();

/** Start and end times, message count, first prompt, and files written, from the transcript. */
async function transcriptFacts(file: string): Promise<TranscriptFacts | null> {
  const stat = await statOrNull(file);
  if (!stat) return null;
  const cached = factsCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.facts;

  const facts: TranscriptFacts = {
    startedAt: 0,
    updatedAt: 0,
    messageCount: 0,
    firstPrompt: "",
    filesTouched: [],
  };
  const files = new Set<string>();
  await readJsonLines(file, (record) => {
    const at = parseTimestamp(record.created_at);
    if (at) {
      if (!facts.startedAt || at < facts.startedAt) facts.startedAt = at;
      if (at > facts.updatedAt) facts.updatedAt = at;
    }
    const content = str(record.content);
    if (record.type === "USER_INPUT" && content) {
      facts.messageCount++;
      facts.firstPrompt ||= truncate(userRequest(content), 400);
    } else if (record.type === "PLANNER_RESPONSE") {
      if (content?.trim()) facts.messageCount++;
      for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
        if (!isRecord(call) || !WRITE_TOOLS.has(str(call.name) ?? "")) continue;
        const args = toolArgs(call.args);
        const target = args.TargetFile ?? args.AbsolutePath;
        if (target && path.isAbsolute(target)) files.add(target);
      }
    }
  });
  facts.filesTouched = [...files];
  factsCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
  return facts;
}

interface ListedConversation {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number;
  steps: number;
}

/** The list from Antigravity's own index: best metadata, but needs the sqlite3 CLI. */
async function listFromIndex(): Promise<ListedConversation[]> {
  const rows = await querySqliteLive(SUMMARIES_DB, LIST_SQL);
  return rows.flatMap((row) => {
    const id = str(row.id);
    if (!id || !SAFE_ID.test(id)) return [];
    return [
      {
        id,
        title: str(row.title),
        cwd: firstWorkspace(row.workspaces),
        updatedAt: parseTimestamp(row.updatedAt),
        steps: Number(row.steps) || 0,
      },
    ];
  });
}

/** Titles from annotations/<id>.pbtxt (a one-line text proto: title:"…"). */
async function annotationTitle(id: string): Promise<string | null> {
  try {
    const text = await fs.promises.readFile(path.join(ANNOTATIONS_DIR, `${id}.pbtxt`), "utf8");
    const title = /title:"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    return title ? title.replace(/\\(.)/g, "$1") : null;
  } catch {
    return null;
  }
}

/** The folder each conversation was started in, from the prompt history. */
async function historyWorkspaces(): Promise<Map<string, string>> {
  const workspaces = new Map<string, string>();
  if (!(await pathExists(HISTORY_FILE))) return workspaces;
  await readJsonLines(HISTORY_FILE, (record) => {
    const id = str(record.conversationId);
    const workspace = str(record.workspace);
    if (id && workspace && path.isAbsolute(workspace)) workspaces.set(id, workspace);
  });
  return workspaces;
}

/**
 * The list without SQLite: every brain/ folder that has a transcript. It can't tell subagent
 * conversations apart (only the index knows), so a few extra entries may appear.
 */
async function listFromFiles(): Promise<ListedConversation[]> {
  const workspaces = await historyWorkspaces();
  const dirs = (await readDirSafe(BRAIN_DIR)).filter(
    (entry) => entry.isDirectory() && SAFE_ID.test(entry.name),
  );
  const listed = await Promise.all(
    dirs.map(async (dir): Promise<ListedConversation | null> => {
      if (!(await pathExists(transcriptPath(dir.name)))) return null;
      return {
        id: dir.name,
        title: await annotationTitle(dir.name),
        cwd: workspaces.get(dir.name) ?? null,
        updatedAt: 0,
        steps: 0,
      };
    }),
  );
  return listed.filter((item): item is ListedConversation => item !== null);
}

export async function scanAntigravity(): Promise<SessionSummary[]> {
  if (!(await pathExists(ANTIGRAVITY_CLI_DIR))) return [];
  let listed: ListedConversation[];
  try {
    listed = (await pathExists(SUMMARIES_DB)) ? await listFromIndex() : await listFromFiles();
  } catch {
    // No sqlite3 on this machine, or the index can't be read: list from plain files instead.
    listed = await listFromFiles();
  }

  const sessions = await Promise.all(
    listed.map(async (item): Promise<SessionSummary | null> => {
      const transcript = transcriptPath(item.id);
      const facts = await transcriptFacts(transcript);
      const updatedAt = Math.max(item.updatedAt, facts?.updatedAt ?? 0);
      if (!updatedAt) return null;
      return {
        id: `antigravity:${item.id}`,
        kind: "session",
        harness: "antigravity",
        nativeId: item.id,
        title: item.title || facts?.firstPrompt.split("\n")[0] || "Untitled conversation",
        firstPrompt: facts?.firstPrompt ?? "",
        cwd: item.cwd,
        startedAt: facts?.startedAt || updatedAt,
        updatedAt,
        // Prompts plus replies, like the other harnesses; the step count includes every tool call.
        messageCount: facts?.messageCount ?? item.steps,
        gitBranch: null,
        model: null,
        filesTouched: facts?.filesTouched ?? [],
        sourcePath: facts
          ? transcript
          : path.join(ANTIGRAVITY_CLI_DIR, "conversations", `${item.id}.db`),
        resumeCommand: `agy --conversation ${item.id}`,
      };
    }),
  );
  return sessions.filter((session): session is SessionSummary => session !== null);
}

/** The transcript from agy's step log: prompts, replies, and tool calls with their output. */
async function readTranscript(file: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  // agy doesn't link output to its call: outputs follow a step's calls in order. Some calls
  // write no output, so only the latest step's calls are waiting; anything older is dropped
  // rather than matched to the wrong call.
  const waiting: TranscriptEntry[] = [];
  await readJsonLines(file, (record) => {
    if (entries.length >= MAX_ENTRIES) return false;
    const content = str(record.content) ?? "";
    switch (record.type) {
      case "USER_INPUT": {
        waiting.length = 0;
        const text = userRequest(content);
        if (text)
          entries.push({
            id: String(entries.length),
            role: "user",
            text: truncate(text, MAX_ENTRY_CHARS),
          });
        break;
      }
      case "PLANNER_RESPONSE": {
        waiting.length = 0;
        if (content.trim()) {
          entries.push({
            id: String(entries.length),
            role: "assistant",
            text: truncate(content.trim(), MAX_ENTRY_CHARS),
          });
        }
        for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
          if (!isRecord(call)) continue;
          const name = str(call.name) ?? "Tool";
          const tool: TranscriptEntry = {
            id: String(entries.length),
            role: "tool",
            toolName: name,
            text: describeCall(name, toolArgs(call.args)),
          };
          entries.push(tool);
          waiting.push(tool);
        }
        break;
      }
      case "GENERIC": {
        const tool = waiting.shift();
        if (!tool) break;
        const output = toolOutput(content);
        tool.result = truncate(output.text, MAX_RESULT_CHARS);
        tool.isError = output.failed;
        break;
      }
      // SYSTEM_MESSAGE is agy's own injection, not part of the conversation.
      default:
        waiting.length = 0;
    }
  });
  return entries;
}

/** Fallback for conversations without a step log: the search index's plain-text chunks. */
async function readFromIndex(id: string): Promise<TranscriptEntry[]> {
  const rows = await querySqliteLive(
    SUMMARIES_DB,
    `select user_body as user, agent_body as agent from conversations_fts
     where conversation_id = '${id}' and chunk_index >= 0 order by chunk_index`,
  );
  const entries: TranscriptEntry[] = [];
  for (const row of rows) {
    for (const [role, text] of [
      ["user", str(row.user)],
      ["assistant", str(row.agent)],
    ] as const) {
      const trimmed = text?.trim();
      if (trimmed)
        entries.push({
          id: String(entries.length),
          role,
          text: truncate(trimmed, MAX_ENTRY_CHARS),
        });
    }
  }
  return entries;
}

export async function readAntigravitySession(session: SessionSummary): Promise<TranscriptEntry[]> {
  const id = assertSafeId(session.nativeId);
  const file = transcriptPath(id);
  if (await pathExists(file)) return readTranscript(file);
  return readFromIndex(id).catch(() => []);
}
