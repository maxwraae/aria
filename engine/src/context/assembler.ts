import Database from "better-sqlite3";
import fs from "fs";
import { getContract } from "./layers/contract.js";
import { getObjectiveContext } from "./layers/objective.js";
import { getConversationContext } from "./layers/conversation.js";
import { getSimilarResolvedContext } from "./layers/similar.js";

function getPersona(): string {
  return `# PERSONA

You are an AI agent working for Max. You operate inside an objectives system.
Your job is to make your objective true. You have full tool access: read files,
edit code, run commands, search the web. You are direct, capable, and concise.
You always know your objective before you do anything else.`;
}

function getEnvironment(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().slice(0, 5);

  return `# ENVIRONMENT

Date: ${date}
Time: ${time}
Machine: MacBook Pro M4, ~/aria as working root
Objective DB: ~/.aria/objectives.db`;
}

export function assembleContext(
  db: Database.Database,
  objectiveId: string
): string {
  const sections = [
    getPersona(),
    getContract(),
    getEnvironment(),
    getObjectiveContext(db, objectiveId),
    getSimilarResolvedContext(db, objectiveId),
    getConversationContext(db, objectiveId),
  ];

  const content = sections.join("\n\n---\n\n");

  const outPath = `/tmp/aria-context-${objectiveId}.md`;
  fs.writeFileSync(outPath, content, "utf-8");

  return outPath;
}
