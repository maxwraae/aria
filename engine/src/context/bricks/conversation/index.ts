import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import Database from "better-sqlite3";
import {
  getConversation,
  getSenderRelation,
  type InboxMessage,
} from "../../../db/queries.js";

function formatSender(
  db: Database.Database,
  msg: InboxMessage,
  objectiveId: string
): string {
  const tag = getSenderRelation(db, msg.sender, objectiveId);
  const suffix = msg.type === "reply" ? " (reply)" : "";
  return `${tag.label}${suffix}`;
}

function getConversationContext(
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

const conversationBrick: Brick = {
  name: "CONVERSATION",
  type: "flex",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const content = getConversationContext(ctx.db, ctx.objectiveId);
    const tokens = countTokens(content);

    return {
      name: "CONVERSATION",
      type: "flex" as const,
      content,
      tokens,
    };
  },
};

export default conversationBrick;
