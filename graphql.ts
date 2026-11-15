// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send (see program/env/src/checks-graphql.ts): a recursive-descent
// parser for the query language subset in use (operations, variables, aliases, inline
// fragments, enum/input-object/list arguments) and resolvers over the shared Store.
// Unknown fields answer HTTP 200 with an `errors` array naming the field.

import { globalId, parseGlobalId, type PullRequest, type Repo, type Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlSelection {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: GqlValue }>;
  readonly children: GqlSelection[] | null;
  /** Inline fragment: `... on Type { ... }` — name is the type condition. */
  readonly fragmentOn: string | null;
}

export interface GqlOperation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; type: string; required: boolean; defaultValue?: GqlValue }>;
  readonly selections: GqlSelection[];
}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${JSON.stringify(ch)} at ${this.pos}, got ${JSON.stringify(this.text[this.pos] ?? '')}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new Error(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipWs();
    if (this.text[this.pos] !== '"') throw new Error(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1] ?? '';
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        out += escapes[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== '') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    if (this.text.startsWith('query', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 5] ?? '')) {
      this.pos += 5;
      kind = 'query';
    } else if (this.text.startsWith('mutation', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 8] ?? '')) {
      this.pos += 8;
      kind = 'mutation';
    }
    let name: string | null = null;
    if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    const variables: GqlOperation['variables'] = [];
    if (this.peek() === '(') {
      this.pos += 1;
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.readName();
        this.expect(':');
        let type = '';
        if (this.peek() === '[') {
          this.pos += 1;
          type += `[${this.readName()}]`;
          if (this.peek() === '!') {
            this.pos += 1;
            type += '!';
          }
        } else {
          type = this.readName();
        }
        let required = false;
        if (this.peek() === '!') {
          this.pos += 1;
          required = true;
        }
        let defaultValue: GqlValue | undefined;
        if (this.peek() === '=') {
          this.pos += 1;
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type, required, defaultValue });
        this.skipWs();
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    this.skipWs();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      let fragmentOn: string | null = null;
      if (this.text.startsWith('on', this.pos) && /[^A-Za-z0-9_]/.test(this.text[this.pos + 2] ?? '')) {
        this.pos += 2;
        fragmentOn = this.readName();
      }
      const children = this.parseSelectionSet();
      return { alias: null, name: '', args: [], children, fragmentOn };
    }
    let name = this.readName();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = name;
      name = this.readName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.pos += 1;
      while (this.peek() !== ')') {
        const argName = this.readName();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        this.skipWs();
      }
      this.expect(')');
    }
    let children: GqlSelection[] | null = null;
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias, name, args, children, fragmentOn: null };
  }

  private parseValue(): GqlValue {
    this.skipWs();
    const ch = this.text[this.pos] ?? '';
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: GqlValue[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        this.skipWs();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        this.skipWs();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
      if (match === null) throw new Error(`bad number at ${this.pos}`);
      this.pos += match[0].length;
      const num = Number(match[0]);
      return match[0].includes('.') || /[eE]/.test(match[0]) ? { kind: 'float', value: num } : { kind: 'int', value: num };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
}

export function parseDocument(text: string): GqlOperation[] {
  return new Parser(text).parseDocument();
}

// -------------------------------------------------------------------------------------------
// values
// -------------------------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueOf(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(selection: GqlSelection, name: string, variables: Record<string, unknown>): unknown {
  const arg = selection.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return valueOf(arg.value, variables);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// -------------------------------------------------------------------------------------------
// schema (introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'author', 'createdAt', 'mergedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface Ctx {
  readonly store: Store;
  readonly viewerLogin: string;
  readonly errors: Array<{ message: string }>;
}

interface TypedValue {
  readonly type: string;
  readonly value: unknown;
}

export function executeGraphQL(store: Store, viewerLogin: string, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, viewerLogin, entry));
  }
  return executeOne(store, viewerLogin, body);
}

function executeOne(store: Store, viewerLogin: string, body: unknown): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, viewerLogin, errors: [] };
  const record = asRecord(body);
  if (record === null || typeof record.query !== 'string') {
    return { data: null, errors: [{ message: 'the request body must carry a query string' }] };
  }
  const variables = asRecord(record.variables) ?? {};
  let operations: GqlOperation[];
  try {
    operations = parseDocument(record.query);
  } catch (err) {
    return { data: null, errors: [{ message: `the query does not parse: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'the query holds no operation' }] };
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const chosen = operationName === null ? operation : operations.find((entry) => entry.name === operationName) ?? operation;
  const rootType = chosen.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, chosen.selections, variables);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function fieldError(ctx: Ctx, type: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}"` });
}

/** Execute a selection set on an object of `type`; returns the JSON object (or null). */
function executeSelections(
  ctx: Ctx,
  type: string,
  object: TypedValue | null,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentOn !== null) {
      if (selection.fragmentOn !== type) continue;
      const nested = executeSelections(ctx, type, object, selection.children ?? [], variables);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, type, object, selection, variables);
  }
  return out;
}

function resolveField(
  ctx: Ctx,
  type: string,
  object: TypedValue | null,
  selection: GqlSelection,
  variables: Record<string, unknown>,
): unknown {
  const field = selection.name;
  // Root fields.
  if (type === 'Query') {
    if (field === 'viewer') {
      const value: TypedValue = { type: 'User', value: { login: ctx.viewerLogin } };
      return selection.children === null ? value.value : executeSelections(ctx, 'User', value, selection.children, variables);
    }
    if (field === 'repository') {
      const owner = argValue(selection, 'owner', variables);
      const name = argValue(selection, 'name', variables);
      const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      const value: TypedValue = { type: 'Repository', value: repo };
      return selection.children === null ? value.value : executeSelections(ctx, 'Repository', value, selection.children, variables);
    }
    if (field === 'node') {
      const id = argValue(selection, 'id', variables);
      const node = typeof id === 'string' ? nodeById(ctx, id) : null;
      if (node === null) return null;
      return selection.children === null ? node.value : executeSelections(ctx, node.type, node, selection.children, variables);
    }
    if (field === '__type') {
      const name = argValue(selection, 'name', variables);
      if (typeof name !== 'string') return null;
      const fields = TYPE_FIELDS[name];
      const enums = TYPE_ENUMS[name];
      if (fields === undefined && enums === undefined) return null;
      const typeValue: TypedValue = { type: '__Type', value: { name, fields: fields ?? [], enums: enums ?? [] } };
      return selection.children === null ? typeValue.value : executeSelections(ctx, '__Type', typeValue, selection.children, variables);
    }
    fieldError(ctx, type, field);
    return null;
  }
  if (type === 'Mutation') {
    return resolveMutation(ctx, selection, variables);
  }
  if (object === null) {
    fieldError(ctx, type, field);
    return null;
  }
  const value = object.value;
  switch (type) {
    case 'User': {
      const user = value as { login: string };
      if (field === 'login') return user.login;
      if (field === 'id') return globalId('User', user.login);
      if (field === 'name') return user.login;
      break;
    }
    case 'Repository': {
      return resolveRepository(ctx, value as Repo, selection, variables);
    }
    case 'Issue': {
      const issue = value as { id: number; number: number; title: string; state: string; body: string; repoId: number };
      if (field === 'id') return globalId('Issue', issue.repoId, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      return resolvePullRequest(ctx, value as PullRequest, selection, variables);
    }
    case 'IssueConnection': {
      const conn = value as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field === 'nodes') {
        const nodes = conn.nodes as TypedValue[];
        if (selection.children === null) return nodes.map((node) => node.value);
        return nodes.map((node) => executeSelections(ctx, node.type, node, selection.children!, variables));
      }
      if (field === 'pageInfo') {
        const pageInfo: TypedValue = { type: 'PageInfo', value: conn.pageInfo };
        return selection.children === null ? conn.pageInfo : executeSelections(ctx, 'PageInfo', pageInfo, selection.children, variables);
      }
      break;
    }
    case 'PullRequestConnection': {
      const conn = value as { nodes: TypedValue[] };
      if (field === 'nodes') {
        if (selection.children === null) return conn.nodes.map((node) => node.value);
        return conn.nodes.map((node) => executeSelections(ctx, node.type, node, selection.children!, variables));
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = value as { path: string };
      if (field === 'path') return file.path;
      break;
    }
    case 'PageInfo': {
      const pageInfo = value as { hasNextPage: boolean; endCursor: string | null };
      if (field === 'hasNextPage') return pageInfo.hasNextPage;
      if (field === 'endCursor') return pageInfo.endCursor;
      if (field === 'hasPreviousPage') return false;
      if (field === 'startCursor') return pageInfo.endCursor;
      break;
    }
    case 'Ref': {
      const ref = value as { name: string };
      if (field === 'name') return ref.name;
      break;
    }
    case 'IssueComment': {
      const comment = value as { id: number; repoId: number; issueNumber: number; body: string };
      if (field === 'id') return globalId('IssueComment', comment.repoId, comment.issueNumber, comment.id);
      if (field === 'body') return comment.body;
      break;
    }
    case 'AddCommentEdge': {
      const edge = value as { node: TypedValue };
      if (field === 'node') {
        return selection.children === null ? edge.node.value : executeSelections(ctx, 'IssueComment', edge.node, selection.children, variables);
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      const payload = value as Record<string, unknown>;
      if (field in payload) return payload[field];
      break;
    }
    case '__Type': {
      const typeValue = value as { name: string; fields: string[]; enums: string[] };
      if (field === 'name') return typeValue.name;
      if (field === 'fields') {
        return typeValue.fields.map((name) => ({ name }));
      }
      if (field === 'enumValues') {
        return typeValue.enums.map((name) => ({ name }));
      }
      if (field === 'kind') return typeValue.enums.length > 0 ? 'ENUM' : 'OBJECT';
      break;
    }
  }
  fieldError(ctx, type, field);
  return null;
}

function resolveRepository(ctx: Ctx, repo: Repo, selection: GqlSelection, variables: Record<string, unknown>): unknown {
  const field = selection.name;
  if (field === 'id') return globalId('Repository', repo.id);
  if (field === 'databaseId') return repo.id;
  if (field === 'name') return repo.name;
  if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
  if (field === 'description') return repo.description;
  if (field === 'owner') {
    const user: TypedValue = { type: 'User', value: { login: repo.owner } };
    return selection.children === null ? user.value : executeSelections(ctx, 'User', user, selection.children, variables);
  }
  if (field === 'defaultBranchRef') {
    const ref: TypedValue = { type: 'Ref', value: { name: repo.defaultBranch } };
    return selection.children === null ? ref.value : executeSelections(ctx, 'Ref', ref, selection.children, variables);
  }
  if (field === 'viewerPermission') return 'ADMIN';
  if (field === 'hasIssuesEnabled') return true;
  if (field === 'issue') {
    const number = argValue(selection, 'number', variables);
    const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
    if (issue === undefined) return null;
    const value: TypedValue = { type: 'Issue', value: issue };
    return selection.children === null ? value.value : executeSelections(ctx, 'Issue', value, selection.children, variables);
  }
  if (field === 'issues') {
    const conn = issueConnection(ctx, repo, selection, variables);
    const value: TypedValue = { type: 'IssueConnection', value: conn };
    return selection.children === null ? conn : executeSelections(ctx, 'IssueConnection', value, selection.children, variables);
  }
  if (field === 'pullRequests') {
    const first = argValue(selection, 'first', variables);
    const prs = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    const limited = typeof first === 'number' ? prs.slice(0, first) : prs;
    const nodes = limited.map((pr): TypedValue => ({ type: 'PullRequest', value: pr }));
    const value: TypedValue = { type: 'PullRequestConnection', value: { nodes } };
    return selection.children === null ? { nodes: limited } : executeSelections(ctx, 'PullRequestConnection', value, selection.children, variables);
  }
  if (field === 'pullRequest') {
    const number = argValue(selection, 'number', variables);
    const pr = typeof number === 'number' ? repo.pulls.get(number) : undefined;
    if (pr === undefined) return null;
    const value: TypedValue = { type: 'PullRequest', value: pr };
    return selection.children === null ? value.value : executeSelections(ctx, 'PullRequest', value, selection.children, variables);
  }
  fieldError(ctx, 'Repository', field);
  return null;
}

function issueConnection(
  ctx: Ctx,
  repo: Repo,
  selection: GqlSelection,
  variables: Record<string, unknown>,
): { nodes: TypedValue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const first = argValue(selection, 'first', variables);
  const states = argValue(selection, 'states', variables);
  const orderBy = asRecord(argValue(selection, 'orderBy', variables));
  const after = argValue(selection, 'after', variables);
  let issues = [...repo.issues.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy !== null && orderBy.direction === 'DESC' ? -1 : 1;
  const orderField = orderBy !== null ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  void orderField;
  issues.sort((a, b) => (a.number - b.number) * direction);
  let startIndex = 0;
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      const index = issues.findIndex((issue) => issue.number === decoded);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const page = issues.slice(startIndex, typeof first === 'number' ? startIndex + first : undefined);
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  const hasNextPage = startIndex + page.length < issues.length;
  return { nodes: page.map((issue): TypedValue => ({ type: 'Issue', value: issue })), pageInfo: { hasNextPage, endCursor } };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolvePullRequest(ctx: Ctx, pr: PullRequest, selection: GqlSelection, variables: Record<string, unknown>): unknown {
  const field = selection.name;
  if (field === 'id') return globalId('PullRequest', pr.repoId, pr.number);
  if (field === 'number') return pr.number;
  if (field === 'title') return pr.title;
  if (field === 'body') return pr.body;
  if (field === 'state') return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
  if (field === 'merged') return pr.merged;
  if (field === 'headRefName') return pr.headRef;
  if (field === 'baseRefName') return pr.baseRef;
  if (field === 'mergeable') {
    const repo = ctx.store.getRepoById(pr.repoId);
    if (repo === undefined) return 'UNKNOWN';
    return ctx.store.pullMergeable(repo, pr);
  }
  if (field === 'files') {
    const repo = ctx.store.getRepoById(pr.repoId);
    const first = argValue(selection, 'first', variables);
    const files = repo === undefined ? [] : ctx.store.pullFiles(repo, pr);
    const limited = typeof first === 'number' ? files.slice(0, first) : files;
    const nodes = limited.map((file): TypedValue => ({ type: 'PullRequestChangedFile', value: { path: file.filename } }));
    const value: TypedValue = { type: 'PullRequestChangedFileConnection', value: { nodes } };
    if (selection.children === null) return { nodes: limited.map((file) => ({ path: file.filename })) };
    // The files connection's nodes are resolved inline here (its only field is nodes).
    const out: Record<string, unknown> = {};
    for (const child of selection.children) {
      if (child.name === 'nodes') {
        out[child.alias ?? 'nodes'] = nodes.map((node) => executeSelections(ctx, 'PullRequestChangedFile', node, child.children ?? [], variables));
      }
    }
    void value;
    return out;
  }
  fieldError(ctx, 'PullRequest', field);
  return null;
}

function nodeById(ctx: Ctx, id: string): TypedValue | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repoId = Number(parsed.parts[0]);
    const repo = ctx.store.getRepoById(repoId);
    return repo === undefined ? null : { type: 'Repository', value: repo };
  }
  if (parsed.kind === 'Issue') {
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    const repo = ctx.store.getRepoById(repoId);
    const issue = repo?.issues.get(number);
    return issue === undefined ? null : { type: 'Issue', value: issue };
  }
  if (parsed.kind === 'PullRequest') {
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    const repo = ctx.store.getRepoById(repoId);
    const pr = repo?.pulls.get(number);
    return pr === undefined ? null : { type: 'PullRequest', value: pr };
  }
  return null;
}

function resolveMutation(ctx: Ctx, selection: GqlSelection, variables: Record<string, unknown>): unknown {
  const field = selection.name;
  const input = asRecord(argValue(selection, 'input', variables)) ?? {};
  const wrap = (payloadType: string, payload: Record<string, unknown>): unknown => {
    if (selection.children === null) return payload;
    const value: TypedValue = { type: payloadType, value: payload };
    return executeSelections(ctx, payloadType, value, selection.children, variables);
  };
  if (field === 'createIssue') {
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    const repo = parsed !== null && parsed.kind === 'Repository' ? ctx.store.getRepoById(Number(parsed.parts[0])) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: the repositoryId names no repository' });
      return wrap('CreateIssuePayload', { issue: null });
    }
    const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      ctx.errors.push({ message: `createIssue: ${created.error}` });
      return wrap('CreateIssuePayload', { issue: null });
    }
    const value: TypedValue = { type: 'Issue', value: created };
    return wrap('CreateIssuePayload', { issue: selection.children === null ? created : executeSelections(ctx, 'Issue', value, findChild(selection, 'issue'), variables) });
  }
  if (field === 'closeIssue') {
    const issueId = String(input.issueId ?? '');
    const parsed = parseGlobalId(issueId);
    const repo = parsed !== null && parsed.kind === 'Issue' ? ctx.store.getRepoById(Number(parsed.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(parsed?.parts[1] ?? NaN));
    if (issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: the issueId names no issue' });
      return wrap('CloseIssuePayload', { issue: null });
    }
    issue.state = 'closed';
    const value: TypedValue = { type: 'Issue', value: issue };
    return wrap('CloseIssuePayload', { issue: selection.children === null ? issue : executeSelections(ctx, 'Issue', value, findChild(selection, 'issue'), variables) });
  }
  if (field === 'createPullRequest') {
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    const repo = parsed !== null && parsed.kind === 'Repository' ? ctx.store.getRepoById(Number(parsed.parts[0])) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: the repositoryId names no repository' });
      return wrap('CreatePullRequestPayload', { pullRequest: null });
    }
    const created = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) {
      ctx.errors.push({ message: `createPullRequest: ${created.error}` });
      return wrap('CreatePullRequestPayload', { pullRequest: null });
    }
    const value: TypedValue = { type: 'PullRequest', value: created };
    return wrap('CreatePullRequestPayload', { pullRequest: selection.children === null ? created : executeSelections(ctx, 'PullRequest', value, findChild(selection, 'pullRequest'), variables) });
  }
  if (field === 'mergePullRequest') {
    const pullRequestId = String(input.pullRequestId ?? '');
    const parsed = parseGlobalId(pullRequestId);
    const repo = parsed !== null && parsed.kind === 'PullRequest' ? ctx.store.getRepoById(Number(parsed.parts[0])) : undefined;
    const pr = repo?.pulls.get(Number(parsed?.parts[1] ?? NaN));
    if (pr === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: the pullRequestId names no pull request' });
      return wrap('MergePullRequestPayload', { pullRequest: null });
    }
    const merged = ctx.store.mergePull(repo!, pr.number);
    if ('error' in merged) {
      ctx.errors.push({ message: `mergePullRequest: ${merged.error}` });
      return wrap('MergePullRequestPayload', { pullRequest: null });
    }
    const value: TypedValue = { type: 'PullRequest', value: pr };
    return wrap('MergePullRequestPayload', { pullRequest: selection.children === null ? pr : executeSelections(ctx, 'PullRequest', value, findChild(selection, 'pullRequest'), variables) });
  }
  if (field === 'addComment') {
    const subjectId = String(input.subjectId ?? '');
    const parsed = parseGlobalId(subjectId);
    const repo = parsed !== null && parsed.kind === 'Issue' ? ctx.store.getRepoById(Number(parsed.parts[0])) : undefined;
    const comment = repo === undefined ? null : ctx.store.createComment(repo, Number(parsed?.parts[1] ?? NaN), String(input.body ?? ''));
    if (comment === null) {
      ctx.errors.push({ message: 'addComment: the subjectId names no issue' });
      return wrap('AddCommentPayload', { commentEdge: null });
    }
    const edgeValue: TypedValue = { type: 'IssueComment', value: comment };
    const edge = selection.children === null
      ? { node: comment }
      : executeSelections(ctx, 'AddCommentEdge', { type: 'AddCommentEdge', value: { node: edgeValue } }, findChild(selection, 'commentEdge'), variables);
    return wrap('AddCommentPayload', { commentEdge: edge });
  }
  fieldError(ctx, 'Mutation', field);
  return null;
}

/** The sub-selections of a child field, or [] when absent. */
function findChild(selection: GqlSelection, name: string): GqlSelection[] {
  if (selection.children === null) return [];
  const child = selection.children.find((entry) => entry.name === name);
  return child?.children ?? [];
}
