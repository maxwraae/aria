export interface UserMessage {
  id: string;
  kind: "user";
  text: string;
  sender?: string; // defaults to "Max" if omitted
  timestamp: number;
}

export interface AgentMessage {
  id: string;
  kind: "agent";
  /** Markdown-ish text. Code fences rendered as CodeBlocks. */
  text: string;
  /** Inline trace summary, rendered as muted text at the end of the last prose line. */
  whisper?: string;
  /** Display name of the sending child objective, if this message came from a child agent. */
  sender?: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  kind: "tool_call";
  name: string;
  input: Record<string, any>;
  result?: string;
  status: "running" | "completed" | "failed";
  timestamp: number;
}

export interface ImageFigure {
  id: string;
  kind: "image";
  uri: string;
  width: number;
  height: number;
  caption?: string;
  timestamp: number;
}

export interface FileFigure {
  id: string;
  kind: "file";
  name: string;
  size: string;
  mimeType?: string;
  timestamp: number;
}

export interface ActionAnnotation {
  id: string;
  kind: "action";
  summary: string;
  tool: string;
  timestamp: number;
}

export type ChatMessage = UserMessage | AgentMessage | ToolCall | ImageFigure | FileFigure | ActionAnnotation;

export interface ChatSession {
  id: string;
  name: string;
  status: "idle" | "thinking" | "needs-input" | "resolved" | "failed";
  model?: string;
  messages: ChatMessage[];
  work?: string | null;
}

/** One tool entry within a TracePill group */
export interface TraceTool {
  name: string;
  detail: string;
  status: "running" | "completed" | "failed";
}

/** Data shape for TracePill (collapsed group of tool calls) */
export interface TraceToolGroup {
  tools: TraceTool[];
}

/** Data shape for PromotedPill (single prominent tool call) */
export interface PromotedTool {
  icon: "edit" | "bash" | "agent" | "mcp" | "batch";
  summary: string;
  input?: string;
  result?: string;
  status: "running" | "completed" | "failed";
}
