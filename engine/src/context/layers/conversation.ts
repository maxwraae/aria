import Database from "better-sqlite3";
import {
  getConversation,
  getSenderRelation,
  type InboxMessage,
} from "../../db/queries.js";

function formatSender(
  db: Database.Database,
  msg: InboxMessage,
  objectiveId: string
): string {
  const tag = getSenderRelation(db, msg.sender, objectiveId);
  const suffix = msg.type === "reply" ? " (reply)" : "";
  return `${tag.label}${suffix}`;
}

export function getConversationContext(
  db: Database.Database,
  objectiveId: string
): string {
  const messages = getConversation(db, objectiveId, 10);

  if (messages.length === 0) {
    return `# RECENT CONVERSATION\n\n(no messages yet)`;
  }

  const lines: string[] = [`# RECENT CONVERSATION`, ``];

  for (const msg of messages) {
    const sender = formatSender(db, msg, objectiveId);
    lines.push(`[${sender}] ${msg.message}`);
  }

  return lines.join("\n");
}
