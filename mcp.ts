// mcp.ts — MCP (Model Context Protocol) endpoint, JSON-RPC 2.0 over Streamable HTTP.
//
// Two eras are served: modern 2026-07-28 (`server/discover`, no handshake) and the legacy
// handshake (`initialize` + `notifications/initialized`). The tool set is a static constant so
// two `tools/list` calls answer byte for byte identically. Every tool acts on the same Store
// instance as the REST and git surfaces, so objects created over MCP read back over /api/v3.

import { Store, VIEWER_LOGIN, type Repo } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

/** The tool list, frozen at module load so repeated `tools/list` answers are identical. */
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.privateFlag,
    default_branch: repo.defaultBranch,
    description: repo.description,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

function pullJson(repo: Repo, pr: { number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string }): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textResult(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(tool: string, arg: string): Record<string, unknown> {
  return errorResult(`tool ${tool} requires the argument "${arg}"`);
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name)
    ?? TOOLS.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    ?? TOOLS.find((entry) => entry.name.toLowerCase().endsWith(name.toLowerCase()));
  if (tool === undefined) return errorResult(`unknown tool "${name}"`);
  const required = tool.inputSchema.required;
  for (const arg of required) {
    if (args[arg] === undefined || args[arg] === null || args[arg] === '') return missingArg(name, arg);
  }
  switch (tool.name) {
    case 'create_repo': {
      const created = store.createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if ('error' in created) return errorResult(`create_repo: repository ${String(args.name)} ${created.error}`);
      return textResult(repoJson(created));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return errorResult(`get_repo: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return errorResult(`create_issue: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const created = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return errorResult(`create_issue: ${created.error}`);
      return textResult(issueJson(repo, created));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return errorResult(`list_issues: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return textResult({ issues });
    }
    case 'get_issue': {
      const repo = resolveRepo(store, args);
      const number = numberArg(args, 'issue_number', 'number', 'issueNumber');
      if (repo === null) return errorResult(`get_issue: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      if (number === null) return missingArg(name, 'issue_number');
      const issue = repo.issues.get(number);
      if (issue === undefined) return errorResult(`get_issue: issue ${number} was not found`);
      return textResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return errorResult(`create_pull_request: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const created = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      if ('error' in created) return errorResult(`create_pull_request: ${created.error}`);
      return textResult(pullJson(repo, created));
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, args);
      if (repo === null) return errorResult(`list_pull_requests: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pr) => state === 'all' || (state === 'closed' ? pr.state === 'closed' : pr.state === 'open'))
        .sort((a, b) => a.number - b.number)
        .map((pr) => pullJson(repo, pr));
      return textResult({ pull_requests: pulls });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      const number = numberArg(args, 'pull_number', 'pullNumber', 'number');
      if (repo === null) return errorResult(`merge_pull_request: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      if (number === null) return missingArg(name, 'pull_number');
      const merged = store.mergePull(repo, number);
      if ('error' in merged) return errorResult(`merge_pull_request: ${merged.error}`);
      const pr = repo.pulls.get(number)!;
      return textResult({ sha: merged.sha, merged: true, message: pr.title, ...pullJson(repo, pr) });
    }
    default:
      return errorResult(`tool "${name}" is not implemented`);
  }
}

export interface McpAnswer {
  readonly status: number;
  /** Undefined means an empty body (notifications). */
  readonly json: unknown;
}

/**
 * Answer one MCP POST. The body is the raw request text (already read by the caller);
 * authentication is the caller's job. Returns the HTTP status and the JSON body to send.
 */
export function handleMcp(store: Store, rawBody: string): McpAnswer {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not JSON' } } };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 400, json: { jsonrpc: '2.0', id: isRecord(request) ? request.id ?? null : null, error: { code: -32600, message: 'Invalid Request: the body must carry a method string' } } };
  }
  const id = request.id ?? null;
  const method = request.method;
  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null) {
    return { status: 202, json: undefined };
  }
  const ok = (result: unknown): McpAnswer => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): McpAnswer => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return ok({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return ok({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === '') return fail(-32602, 'tools/call requires a tool name');
    const known = TOOLS.some((entry) => entry.name === name || entry.name.toLowerCase() === name.toLowerCase() || entry.name.toLowerCase().endsWith(name.toLowerCase()));
    if (!known) return fail(-32602, `unknown tool "${name}"`);
    return ok(callTool(store, name, args));
  }
  return fail(-32601, `Method not found: ${method}`);
}
