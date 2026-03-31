import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationMessage, Session, SessionMetadata } from "../types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".agent-app", "sessions");

/**
 * Manages session persistence — saves and loads conversation history to disk.
 * Sessions are stored as JSON files: <sessionDir>/<sessionId>.json
 */
export class SessionManager {
  private sessionDir: string;

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir ?? process.env["AGENT_SESSION_DIR"] ?? DEFAULT_SESSION_DIR;
  }

  /** Create a new session with a fresh ID */
  async create(metadata: Omit<SessionMetadata, "sessionId" | "createdAt" | "updatedAt">): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      metadata: {
        ...metadata,
        sessionId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        turns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      },
      messages: [],
    };
    return session;
  }

  /** Load an existing session by ID */
  async load(sessionId: string): Promise<Session | null> {
    const filePath = this.filePath(sessionId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  /** Save a session to disk */
  async save(session: Session): Promise<void> {
    try {
      await fs.mkdir(this.sessionDir, { recursive: true });
      const filePath = this.filePath(session.metadata.sessionId);
      const updated: Session = {
        ...session,
        metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
      };
      await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
    } catch (err) {
      logger.warn(`Failed to save session: ${String(err)}`);
    }
  }

  /** Update session metadata (usage stats, title, etc.) */
  async updateMetadata(
    session: Session,
    update: Partial<SessionMetadata>
  ): Promise<Session> {
    const updated: Session = {
      ...session,
      metadata: { ...session.metadata, ...update, updatedAt: new Date().toISOString() },
    };
    return updated;
  }

  /** Append messages to a session */
  appendMessages(session: Session, messages: ConversationMessage[]): Session {
    return {
      ...session,
      messages: [...session.messages, ...messages],
    };
  }

  /** List all saved sessions (sorted newest first) */
  async list(): Promise<SessionMetadata[]> {
    try {
      const files = await fs.readdir(this.sessionDir);
      const metas: SessionMetadata[] = [];

      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => {
            try {
              const raw = await fs.readFile(path.join(this.sessionDir, f), "utf-8");
              const session = JSON.parse(raw) as Session;
              metas.push(session.metadata);
            } catch {
              // Skip corrupted files
            }
          })
      );

      return metas.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch {
      return [];
    }
  }

  /** Delete a session */
  async delete(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(sessionId));
    } catch {
      // Already gone
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }
}
