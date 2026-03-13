export interface Objective {
  id: string;
  objective: string;
  description: string | null;
  parent: string | null;
  status: string;
  waiting_on: string | null;
  resolution_summary: string | null;
  important: number;
  urgent: number;
  model: string;
  cwd: string | null;
  fail_count: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface InboxMessage {
  id: string;
  objective_id: string;
  message: string;
  sender: string;
  type: string;
  turn_id: string | null;
  created_at: number;
}
