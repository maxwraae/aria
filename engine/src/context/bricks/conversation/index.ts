import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import { getConversationContext } from "../../layers/conversation.js";

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
