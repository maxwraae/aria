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

function resolveMaxTokens(
  maxTokens: number | Record<string, number>,
  budget: number
): number {
  if (typeof maxTokens === "number") return maxTokens;
  // Resolve per-model object using budget thresholds
  const modelKey = budget >= 500_000 ? "opus" : "sonnet";
  return maxTokens[modelKey] ?? maxTokens["sonnet"] ?? Math.min(...Object.values(maxTokens));
}

function getConversationContext(
  db: Database.Database,
  objectiveId: string,
  perMessageMax: number,
  maxTokens: number
): string {
  // Fetch more messages than we'll need so we can pack until the cap
  const messages = getConversation(db, objectiveId, 200);

  if (messages.length === 0) {
    return `# RECENT CONVERSATION\n\n(no messages yet)`;
  }

  const header = `# RECENT CONVERSATION\n`;
  let usedTokens = countTokens(header);
  const includedLines: string[] = [];

  for (const msg of messages) {
    const sender = formatSender(db, msg, objectiveId);
    let body = msg.message;

    // Per-message truncation
    if (perMessageMax > 0) {
      const msgTokens = countTokens(body);
      if (msgTokens > perMessageMax) {
        // Rough character truncation: assume ~4 chars per token
        const charLimit = perMessageMax * 4;
        body = body.slice(0, charLimit) + "…";
      }
    }

    const line = `[${sender}] ${body}`;
    const lineTokens = countTokens(line);

    if (usedTokens + lineTokens > maxTokens) {
      break;
    }

    usedTokens += lineTokens;
    includedLines.push(line);
  }

  return [header, ...includedLines].join("\n");
}

const conversationBrick: Brick = {
  name: "CONVERSATION",
  type: "flex",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const brickConfig = (ctx.config as Record<string, unknown>);
    const perMessageMax = typeof brickConfig.per_message_max === "number"
      ? brickConfig.per_message_max
      : 2000;
    const maxTokensRaw = brickConfig.max_tokens as number | Record<string, number> | undefined;
    const maxTokens = maxTokensRaw !== undefined
      ? resolveMaxTokens(maxTokensRaw, ctx.budget)
      : 80000;

    const content = getConversationContext(
      ctx.db,
      ctx.objectiveId,
      perMessageMax,
      maxTokens
    );
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
