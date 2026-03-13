/**
 * Remote mode for CLI — makes HTTP requests to coordinator instead of local SQLite.
 * Activated when ARIA_COORDINATOR env var is set.
 */

const isTTY = process.stdout.isTTY ?? false;

const color = {
  dim:       (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  yellow:    (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:      (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  green:     (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:       (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  magenta:   (s: string) => isTTY ? `\x1b[35m${s}\x1b[0m` : s,
  blue:      (s: string) => isTTY ? `\x1b[34m${s}\x1b[0m` : s,
  strikethrough: (s: string) => isTTY ? `\x1b[2m\x1b[9m${s}\x1b[0m` : s,
};

function colorStatus(status: string): string {
  switch (status) {
    case 'idle':        return color.dim(`[${status}]`);
    case 'thinking':    return color.yellow(`[${status}]`);
    case 'needs-input': return color.cyan(`[${status}]`);
    case 'resolved':    return color.green(`[${status}]`);
    case 'failed':      return color.red(`[${status}]`);
    case 'abandoned':   return color.strikethrough(`[${status}]`);
    default:            return `[${status}]`;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ── HTTP helpers ──────────────────────────────────────────────────

async function api(coordinator: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const url = `${coordinator.replace(/\/$/, '')}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  return { status: res.status, data };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ── Flag parsing (duplicated to keep remote.ts self-contained) ───

function parseFlags(args: string[]): { positional: string[], flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

// ── Tree formatting ──────────────────────────────────────────────

interface TreeNode {
  id: string;
  objective: string;
  status: string;
  children: TreeNode[];
}

function buildTreeFromFlat(objectives: Array<{ id: string; objective: string; status: string; parent: string | null }>): TreeNode[] {
  const byParent = new Map<string, typeof objectives>();
  for (const obj of objectives) {
    const key = obj.parent ?? '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(obj);
  }

  function build(parentId: string | null): TreeNode[] {
    const key = parentId ?? '__root__';
    const children = byParent.get(key) ?? [];
    return children.map(obj => ({
      id: obj.id,
      objective: obj.objective,
      status: obj.status,
      children: build(obj.id),
    }));
  }

  return build(null);
}

function printTree(nodes: TreeNode[], prefix: string = ''): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = prefix === '' ? '' : (isLast ? '└── ' : '├── ');
    console.log(`${prefix}${connector}${node.objective} ${colorStatus(node.status)}`);
    const childPrefix = prefix === '' ? '' : prefix + (isLast ? '    ' : '│   ');
    printTree(node.children, childPrefix);
  }
}

function treeToJson(nodes: TreeNode[]): unknown[] {
  return nodes.map(n => ({
    id: n.id,
    objective: n.objective,
    status: n.status,
    children: treeToJson(n.children),
  }));
}

// ── Remote commands ──────────────────────────────────────────────

export async function remoteTree(coordinator: string): Promise<void> {
  const { data } = await api(coordinator, 'GET', '/api/objectives');
  const objectives = data as Array<{ id: string; objective: string; status: string; parent: string | null }>;
  const tree = buildTreeFromFlat(objectives);

  if (isTTY) {
    printTree(tree);
  } else {
    console.log(JSON.stringify(treeToJson(tree), null, 2));
  }
}

export async function remoteShow(coordinator: string, id: string): Promise<void> {
  if (!id) die('Usage: aria show <id>');

  const { status, data } = await api(coordinator, 'GET', `/api/objectives/${id}`);
  if (status === 404) die(`Objective not found: ${id}`);
  const obj = data as Record<string, unknown>;
  const children = (obj.children as unknown[]) ?? [];

  if (isTTY) {
    console.log(`ID:          ${obj.id}`);
    console.log(`Objective:   ${obj.objective}`);
    console.log(`Status:      ${obj.status}`);
    console.log(`Parent:      ${obj.parent ?? 'none'}`);
    console.log(`Children:    ${children.length}`);
    if (obj.description) console.log(`Description: ${obj.description}`);
    if (obj.waiting_on) console.log(`Waiting on:  ${obj.waiting_on}`);
    console.log(`Created:     ${formatTimestamp(obj.created_at as number)}`);
    console.log(`Updated:     ${formatTimestamp(obj.updated_at as number)}`);
    if (obj.resolved_at) console.log(`Resolved:    ${formatTimestamp(obj.resolved_at as number)}`);
  } else {
    console.log(JSON.stringify({ ...obj, children_count: children.length }, null, 2));
  }
}

export async function remoteCreate(coordinator: string, rawArgs: string[]): Promise<void> {
  const { positional, flags } = parseFlags(rawArgs);
  const objectiveText = positional[0];
  if (!objectiveText) die('Usage: aria create "desired state" ["instructions"]');

  const instructions = positional[1] ?? undefined;
  const parentId = process.env.ARIA_OBJECTIVE_ID ?? 'root';
  const model = (flags['model'] as string) ?? 'sonnet';

  const { status, data } = await api(coordinator, 'POST', '/api/objectives', {
    objective: objectiveText,
    parent: parentId,
    model,
    instructions,
  });

  if (status >= 400) {
    die(`Create failed: ${JSON.stringify(data)}`);
  }

  const newObj = data as Record<string, unknown>;

  if (isTTY) {
    const shortId = (newObj.id as string).slice(0, 8);
    console.log(`Created: ${color.cyan(shortId)} "${objectiveText}"`);
  } else {
    console.log(JSON.stringify({
      id: newObj.id,
      objective: newObj.objective,
      parent: newObj.parent,
      status: newObj.status,
    }, null, 2));
  }
}

export async function remoteSend(coordinator: string, rawArgs: string[]): Promise<void> {
  const id = rawArgs[0];
  const message = rawArgs[1];
  if (!id || !message) die('Usage: aria send <id> "message"');

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${id}/message`, {
    message,
    sender: 'max',
  });

  if (status >= 400) die(`Send failed: ${JSON.stringify(data)}`);

  if (isTTY) {
    const shortId = id.slice(0, 8);
    console.log(`Sent to ${color.cyan(shortId)}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function remoteInbox(coordinator: string, rawArgs: string[]): Promise<void> {
  const { positional, flags } = parseFlags(rawArgs);
  const id = positional[0];
  if (!id) die('Usage: aria inbox <id> [--limit <n>]');

  const limit = flags['limit'] ? parseInt(flags['limit'] as string, 10) : 50;
  const { status, data } = await api(coordinator, 'GET', `/api/objectives/${id}/conversation?limit=${limit}`);

  if (status === 404) die(`Objective not found: ${id}`);

  const messages = data as Array<{ message: string; sender: string; created_at: number; turn_id: string | null }>;

  if (isTTY) {
    if (messages.length === 0) {
      console.log(color.dim('No messages.'));
    } else {
      for (const msg of messages) {
        const ts = formatTimestamp(msg.created_at);
        const marker = msg.turn_id === null ? '• ' : '  ';
        console.log(`${marker}[${msg.sender}] ${color.dim(ts)}   ${msg.message}`);
      }
    }
  } else {
    console.log(JSON.stringify(messages, null, 2));
  }
}

export async function remoteSucceed(coordinator: string, rawArgs: string[]): Promise<void> {
  const targetId = rawArgs[0];
  const summary = rawArgs[1];
  if (!targetId || !summary) die('Usage: aria succeed <id> "summary"');

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${targetId}/succeed`, {
    summary,
    caller: process.env.ARIA_OBJECTIVE_ID,
  });

  if (status >= 400) die(`Succeed failed: ${JSON.stringify(data)}`);
  const result = data as Record<string, unknown>;

  if (isTTY) {
    const shortId = targetId.slice(0, 8);
    console.log(`Resolved: ${color.green(shortId)} "${result.objective ?? ''}"`);
    if ((result.abandoned_children as number) > 0) {
      console.log(color.dim(`  ${result.abandoned_children} child(ren) abandoned`));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function remoteFail(coordinator: string, rawArgs: string[]): Promise<void> {
  const targetId = rawArgs[0];
  const reason = rawArgs[1];
  if (!targetId || !reason) die('Usage: aria fail <id> "reason"');

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${targetId}/fail`, {
    reason,
    caller: process.env.ARIA_OBJECTIVE_ID,
  });

  if (status >= 400) die(`Fail failed: ${JSON.stringify(data)}`);

  if (isTTY) {
    const shortId = targetId.slice(0, 8);
    console.log(`Failed: ${color.red(shortId)}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function remoteReject(coordinator: string, rawArgs: string[]): Promise<void> {
  const targetId = rawArgs[0];
  const feedback = rawArgs[1];
  if (!targetId || !feedback) die('Usage: aria reject <id> "feedback"');

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${targetId}/reject`, {
    feedback,
    caller: process.env.ARIA_OBJECTIVE_ID,
  });

  if (status >= 400) die(`Reject failed: ${JSON.stringify(data)}`);

  if (isTTY) {
    const shortId = targetId.slice(0, 8);
    console.log(`Rejected: ${color.yellow(shortId)} — sent feedback`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function remoteWait(coordinator: string, rawArgs: string[]): Promise<void> {
  const { positional } = parseFlags(rawArgs);
  const reason = positional[0];
  const id = process.env.ARIA_OBJECTIVE_ID;

  if (!reason) die('Usage: aria wait "reason" (requires ARIA_OBJECTIVE_ID)');
  if (!id) die('wait requires ARIA_OBJECTIVE_ID to be set');

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${id}/wait`, {
    reason,
  });

  if (status >= 400) die(`Wait failed: ${JSON.stringify(data)}`);

  if (isTTY) {
    const shortId = id.slice(0, 8);
    console.log(`Waiting: ${color.yellow(shortId)} — ${reason}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function remoteTell(coordinator: string, rawArgs: string[]): Promise<void> {
  const targetId = rawArgs[0];
  const message = rawArgs[1];
  if (!targetId || !message) die('Usage: aria tell <id> "message"');

  const senderId = process.env.ARIA_OBJECTIVE_ID ?? 'max';

  const { status, data } = await api(coordinator, 'POST', `/api/objectives/${targetId}/message`, {
    message,
    sender: senderId,
  });

  if (status >= 400) die(`Tell failed: ${JSON.stringify(data)}`);

  if (isTTY) {
    const shortId = targetId.slice(0, 8);
    console.log(`Told ${color.cyan(shortId)}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function remoteNotify(coordinator: string, rawArgs: string[]): Promise<void> {
  const { positional, flags } = parseFlags(rawArgs);
  const message = positional[0];
  if (!message) die('Usage: aria notify "message" --important/--urgent');

  const important = 'important' in flags;
  const urgent = 'urgent' in flags;

  const { status, data } = await api(coordinator, 'POST', '/api/notify', {
    message,
    important,
    urgent,
    sender: process.env.ARIA_OBJECTIVE_ID ?? 'system',
  });

  if (status >= 400) die(`Notify failed: ${JSON.stringify(data)}`);

  const markers = [
    urgent ? 'URGENT' : '',
    important ? 'IMPORTANT' : '',
  ].filter(Boolean).join(' ');
  const prefix = markers ? `[NOTIFY ${markers}]` : '[NOTIFY]';
  console.log(`${prefix} ${message}`);

  if (!isTTY) {
    console.log(JSON.stringify({ message, important, urgent }, null, 2));
  }
}

export async function remoteFind(coordinator: string, rawArgs: string[]): Promise<void> {
  const query = rawArgs[0];
  if (!query) die('Usage: aria find "query"');

  const { data } = await api(coordinator, 'GET', `/api/search?q=${encodeURIComponent(query)}`);
  const results = data as Array<{ id: string; objective: string; status: string; parent: string | null }>;

  if (results.length === 0) {
    console.log('No objectives found.');
    return;
  }

  if (isTTY) {
    for (const obj of results) {
      const shortId = obj.id.slice(0, 8);
      const name = obj.objective.length > 50
        ? obj.objective.slice(0, 50) + '...'
        : obj.objective;
      console.log(`${color.cyan(shortId)}  "${name}"  ${colorStatus(obj.status)}`);
    }
  } else {
    console.log(JSON.stringify(results.map(obj => ({
      id: obj.id,
      objective: obj.objective,
      status: obj.status,
      parent: obj.parent,
    })), null, 2));
  }
}
