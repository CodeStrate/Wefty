import * as fs from "fs";
import * as path from "path";

import type { MemorySummary, SessionSummary, TranscriptEntry } from "../../shared/types.js";
import { readMarkdownMemory } from "../memory-files.js";
import { OPENCODE_CONFIG_DIR, OPENCODE_DATA_DIR } from "../platform.js";
import {
  describeTool,
  isRecord,
  parseTimestamp,
  pathExists,
  querySqlite,
  readDirSafe,
  shellQuote,
  str,
  toolResultText,
  truncate,
} from "../util.js";
import { MAX_ENTRY_CHARS, MAX_RESULT_CHARS } from "./limits.js";

export { OPENCODE_CONFIG_DIR };

const MAX_MESSAGES = 1500;
export const OPENCODE_V2_DB = path.join(OPENCODE_DATA_DIR, "opencode.db");

// Top-level, unarchived sessions; subagents have a parent_id.
const DB_LIST_SQL = `select s.id, s.title, s.directory, s.model,
  s.time_created as created, s.time_updated as updated,
  (select count(*) from session_message m
    where m.session_id = s.id and m.type in ('user', 'assistant')) as messages,
  (select json_extract(m.data, '$.text') from session_message m
    where m.session_id = s.id and m.type = 'user' order by m.seq limit 1) as firstPrompt
from session_v2 s
where s.parent_id is null and s.time_archived is null`;

async function scanOpencodeV2Db(): Promise<SessionSummary[]> {
  if (!(await pathExists(OPENCODE_V2_DB))) return [];
  const rows = await querySqlite(OPENCODE_V2_DB, DB_LIST_SQL);
  return rows.flatMap((row): SessionSummary[] => {
    const id = str(row.id);
    const messageCount = Number(row.messages) || 0;
    if (!id || messageCount === 0) return [];
    let model: string | null = null;
    try {
      const parsed = JSON.parse(str(row.model) ?? "null");
      if (isRecord(parsed) && str(parsed.id)) {
        model = str(parsed.providerID) ? `${parsed.providerID}/${parsed.id}` : str(parsed.id);
      }
    } catch {
      // No model recorded.
    }
    const updatedAt = parseTimestamp(row.updated) || parseTimestamp(row.created);
    return [
      {
        id: `opencode:${id}`,
        kind: "session",
        harness: "opencode",
        nativeId: id,
        title: str(row.title) ?? "Untitled session",
        firstPrompt: truncate(str(row.firstPrompt) ?? "", 400),
        cwd: str(row.directory),
        startedAt: parseTimestamp(row.created) || updatedAt,
        updatedAt,
        messageCount,
        gitBranch: null,
        model,
        filesTouched: [],
        // The reader uses this to tell database sessions from storage/ ones.
        sourcePath: OPENCODE_V2_DB,
        resumeCommand: `opencode --session ${id}`,
      },
    ];
  });
}

/** For opencode v1 */
export function opencodeStorageDir(): string {
  return path.join(OPENCODE_DATA_DIR, "storage");
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function scanOpencode(): Promise<{
  sessions: SessionSummary[];
  memories: MemorySummary[];
}> {
  const storage = opencodeStorageDir();
  const sessionRoot = path.join(storage, "session");
  const sessions: SessionSummary[] = [];

  for (const project of await readDirSafe(sessionRoot)) {
    if (!project.isDirectory()) continue;
    for (const entry of await readDirSafe(path.join(sessionRoot, project.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const info = await readJson(path.join(sessionRoot, project.name, entry.name));
      const id = info ? str(info.id) : null;
      if (!info || !id || str(info.parentID)) continue;
      const messageCount = (await readDirSafe(path.join(storage, "message", id))).length;
      if (messageCount === 0) continue;
      const time = isRecord(info.time) ? info.time : {};
      const cwd = str(info.directory);
      const updatedAt = parseTimestamp(time.updated) || parseTimestamp(time.created);
      sessions.push({
        id: `opencode:${id}`,
        kind: "session",
        harness: "opencode",
        nativeId: id,
        title: str(info.title) ?? "Untitled session",
        firstPrompt: "",
        cwd,
        startedAt: parseTimestamp(time.created) || updatedAt,
        updatedAt,
        messageCount,
        gitBranch: null,
        model: null,
        filesTouched: [],
        sourcePath: path.join(sessionRoot, project.name, entry.name),
        resumeCommand: cwd
          ? `cd ${shellQuote(cwd)} && opencode --session ${id}`
          : `opencode --session ${id}`,
      });
    }
  }

  const memories: MemorySummary[] = [];
  const globalAgents = await readMarkdownMemory(path.join(OPENCODE_CONFIG_DIR, "AGENTS.md"), {
    harnesses: ["opencode"],
    memoryType: "instructions",
    scope: "global",
    cwd: null,
    title: "AGENTS.md (opencode global)",
  });
  if (globalAgents) memories.push(globalAgents);

  const fromV2Db = await scanOpencodeV2Db().catch(() => []);
  const seenSessions = new Set(fromV2Db.map((session) => session.nativeId));
  const mergedSessions: SessionSummary[] = [
    ...fromV2Db,
    ...sessions.filter((session) => !seenSessions.has(session.nativeId)),
  ];

  return { sessions: mergedSessions, memories };
}

async function readOpencodeV2Db(session: SessionSummary): Promise<TranscriptEntry[]> {
  const sqlQuery = `select m.id as message, m.type as role, m.data as messageData, p.type as type, p.data as data
     from session_message m left join session_part p on p.message_id = m.id
     where m.session_id = ? and m.type in ('user', 'assistant')
     order by m.seq, p.ordinal`;
  const rows = await querySqlite(OPENCODE_V2_DB, sqlQuery, session.nativeId);
  const entries: TranscriptEntry[] = [];
  const push = (role: TranscriptEntry["role"], text: string) =>
    entries.push({
      id: String(entries.length),
      role,
      text: truncate(text.trim(), MAX_ENTRY_CHARS),
    });
  let lastUser = "";
  for (const row of rows) {
    const parse = (raw: unknown) => {
      try {
        const value: unknown = JSON.parse(str(raw) ?? "null");
        return isRecord(value) ? value : null;
      } catch {
        return null;
      }
    };
    if (row.role === "user") {
      // A prompt has no parts; its text is on the message. One row per prompt (the join adds none).
      const message = parse(row.messageData);
      const text = str(message?.text)?.trim();
      if (text && str(row.message) !== lastUser) push("user", text);
      lastUser = str(row.message) ?? "";
      continue;
    }
    const part = parse(row.data);
    if (!part) continue;
    if (part.type === "text" && str(part.text)?.trim()) push("assistant", str(part.text)!);
    else if (part.type === "tool") {
      const state = isRecord(part.state) ? part.state : {};
      const metadata = isRecord(state.metadata) ? state.metadata : {};
      const exit = typeof metadata.exit === "number" ? metadata.exit : 0;
      const output = toolResultText(state.content) || str(state.error) || "";
      entries.push({
        id: String(entries.length),
        role: "tool",
        toolName: str(part.name) ?? "Tool",
        text: describeTool(state.input, session.cwd),
        result: output ? truncate(output, MAX_RESULT_CHARS) : undefined,
        // A failed command still reports status "completed"; only the exit code shows it.
        isError: state.status === "error" || exit !== 0,
      });
    }
    // "reasoning" parts are the model's private thinking, like Claude's: not shown.
  }
  return entries;
}

export async function readOpencodeSession(session: SessionSummary): Promise<TranscriptEntry[]> {
  if (session.sourcePath === OPENCODE_V2_DB) return await readOpencodeV2Db(session);
  const storage = opencodeStorageDir();
  const messageDir = path.join(storage, "message", session.nativeId);
  const messages: { id: string; role: string; created: number }[] = [];
  for (const entry of (await readDirSafe(messageDir)).slice(0, MAX_MESSAGES)) {
    const message = await readJson(path.join(messageDir, entry.name));
    const id = message ? str(message.id) : null;
    if (!message || !id) continue;
    const time = isRecord(message.time) ? message.time : {};
    messages.push({
      id,
      role: str(message.role) ?? "assistant",
      created: parseTimestamp(time.created),
    });
  }
  messages.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));

  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    const partDir = path.join(storage, "part", message.id);
    const partFiles = (await readDirSafe(partDir)).map((entry) => entry.name).sort();
    let text = "";
    for (const name of partFiles) {
      const part = await readJson(path.join(partDir, name));
      if (!part) continue;
      if (part.type === "text" && part.synthetic !== true && typeof part.text === "string") {
        text += (text ? "\n\n" : "") + part.text;
      } else if (part.type === "tool") {
        const state = isRecord(part.state) ? part.state : {};
        const failed = state.status === "error";
        // Output on success, the error message on failure; absent while the tool is still running.
        const output = str(failed ? state.error : state.output);
        entries.push({
          id: String(entries.length),
          role: "tool",
          toolName: str(part.tool) ?? "Tool",
          text: str(state.title) ?? describeTool(state.input, session.cwd),
          result: output ? truncate(output.trim(), MAX_RESULT_CHARS) : undefined,
          isError: failed,
        });
      }
    }
    if (text.trim()) {
      entries.push({
        id: String(entries.length),
        role: message.role === "user" ? "user" : "assistant",
        text: truncate(text.trim(), MAX_ENTRY_CHARS),
      });
    }
  }
  return entries;
}
