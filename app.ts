// app.ts — the forge's HTTP surface: git smart HTTP (upload-pack v2 + receive-pack v0),
// REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp. One in-memory Store backs
// all four surfaces, so an object created over any of them reads back over the others.
//
// main.ts (untouched starter) owns the lifecycle: createApp() here only builds the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, DEFAULT_BRANCH, globalId, type Repo } from './store.ts';
import {
  ZERO_OID,
  encodePktLine,
  encodePktLines,
  pktFlush,
  pktDelim,
  decodePktLines,
  readPack,
  writePack,
  parseCommit,
  parseTag,
  isObjectId,
  type GitObject,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.ts';

const AGENT = `${MCP_SERVER_NAME}/${MCP_SERVER_VERSION}`;
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();

// -------------------------------------------------------------------------------------------
// transport helpers
// -------------------------------------------------------------------------------------------

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The Bearer token the trial hands the entry, or '' when it is not set. */
function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (token === '') return presented.length > 0;
  return presented === token;
}

/** The request URL, parsed once; '/' when it does not parse (never a throw from a request). */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

// -------------------------------------------------------------------------------------------
// REST shapes (shared with the MCP tools)
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.privateFlag,
    default_branch: repo.defaultBranch,
    description: repo.description,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN },
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: {
  id: number; number: number; title: string; body: string; state: string; merged: boolean;
  mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string;
  headSha: string; baseSha: string;
}): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    user: { login: VIEWER_LOGIN },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

/** Look a repo up by owner/name; any other owner reads as 404, never 403. */
function lookupRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badJson(res: ServerResponse): void {
  sendJson(res, 400, { message: 'the request body is not valid JSON' });
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function pageLink(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const host = req.headers.host ?? 'entry';
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  const last = new URLSearchParams(query);
  last.set('per_page', String(perPage));
  last.set('page', String(totalPages));
  return `<http://${host}${path}?${next.toString()}>; rel="next", <http://${host}${path}?${last.toString()}>; rel="last"`;
}

// -------------------------------------------------------------------------------------------
// REST v3 handlers
// -------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, path: string): Promise<void> {
  const method = req.method ?? 'GET';

  // GET /api/v3/user — the viewer.
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name must not be empty' });
        return;
      }
      const created = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if ('error' in created) {
        sendJson(res, 422, { message: `Validation Failed: a repository named ${name} already exists` });
        return;
      }
      sendJson(res, 201, repoJson(created));
      return;
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const repos = store.viewerRepos();
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      const link = pageLink(req, path, query, perPage, page, repos.length);
      sendJson(res, 200, slice.map(repoJson), link === null ? {} : { link });
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: MCP_SERVER_VERSION });
    return;
  }

  // Everything below is /api/v3/repos/:owner/:name[/...].
  if (segments.length < 3 || segments[0] !== 'repos') {
    notFound(res);
    return;
  }
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = lookupRepo(owner, repoName);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateFlag = body.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      if (repo === undefined) {
        notFound(res);
        return;
      }
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  if (repo === undefined) {
    notFound(res);
    return;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
      }
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[1]}`);
      if (tip === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: tip } });
      return;
    }
    notFound(res);
    return;
  }

  // Commits (first-parent walk from the requested ref, default branch by default).
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    const commits: Array<{ sha: string; commit: { message: string } }> = [];
    let current = tip;
    const seen = new Set<string>();
    while (current !== null && commits.length < 1000 && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      const view = parseCommit(object.data);
      commits.push({ sha: current, commit: { message: view.message } });
      current = view.parents[0] ?? null;
    }
    sendJson(res, 200, commits);
    return;
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Validation Failed: ref and sha must name an existing object' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: `Validation Failed: ${ref} already exists` });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[3]}`);
      if (tip === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: tip } });
      return;
    }
    notFound(res);
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    const ref = query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const file = store.readFileAt(repo, ref, filePath);
      if (file !== null) {
        const name = filePath.split('/').pop() ?? '';
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: file.content.length, name, path: filePath,
          content: file.content.toString('base64'), sha: file.blobSha,
        });
        return;
      }
      const dir = store.dirEntries(repo, ref, filePath);
      if (dir !== null) {
        sendJson(res, 200, dir);
        return;
      }
      notFound(res);
      return;
    }
    if (method === 'PUT') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : null;
      if (content === null) {
        sendJson(res, 422, { message: 'Validation Failed: content must be base64' });
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const existing = store.readFileAt(repo, branch, filePath);
      if (existing !== null) {
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.blobSha) {
          sendJson(res, 409, { message: 'the file was changed since the sha you passed' });
          return;
        }
      } else if (typeof body.sha === 'string' && body.sha !== '') {
        sendJson(res, 409, { message: 'the file does not exist yet, so no sha can match' });
        return;
      }
      const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
      const { commitSha, blobSha } = store.commitFile(repo, branch, filePath, content, message);
      const name = filePath.split('/').pop() ?? '';
      sendJson(res, existing === null ? 201 : 200, {
        content: { name, path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: commitSha },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const existing = store.readFileAt(repo, branch, filePath);
      if (existing === null) {
        notFound(res);
        return;
      }
      if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.blobSha) {
        sendJson(res, 409, { message: 'the file was changed since the sha you passed' });
        return;
      }
      const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
      const commitSha = store.deleteFile(repo, branch, filePath, message);
      if (commitSha === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { commit: { sha: commitSha } });
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name must not be empty' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: `Validation Failed: label ${name} already exists` });
        return;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    notFound(res);
    return;
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (a.number - b.number) * direction);
      sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed: title must not be empty' });
        return;
      }
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const entry of rawLabels) {
        const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
        if (name === '') continue;
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: `Validation Failed: label ${name} does not exist` });
          return;
        }
        labels.push(name);
      }
      const created = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      if ('error' in created) {
        sendJson(res, 422, { message: `Validation Failed: ${created.error}` });
        return;
      }
      sendJson(res, 201, issueJson(repo, created));
      return;
    }
    const issueNumber = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(issueNumber)) {
      const issue = repo.issues.get(issueNumber);
      if (rest.length === 2 && method === 'GET') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        const body = parseJsonBody(await readBody(req));
        if (!isRecord(body)) {
          badJson(res);
          return;
        }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, store.commentsForIssue(repo, issueNumber).map((comment) => ({ id: comment.id, body: comment.body })));
          return;
        }
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (!isRecord(body)) {
            badJson(res);
            return;
          }
          const comment = store.createComment(repo, issueNumber, typeof body.body === 'string' ? body.body : '');
          if (comment === null) {
            notFound(res);
            return;
          }
          sendJson(res, 201, { id: comment.id, body: comment.body });
          return;
        }
      }
    }
    notFound(res);
    return;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      const pulls = [...repo.pulls.values()]
        .filter((pr) => state === 'all' || (state === 'closed' ? pr.state === 'closed' : pr.state === 'open'))
        .sort((a, b) => a.number - b.number);
      sendJson(res, 200, pulls.map((pr) => pullJson(repo, pr)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (!isRecord(body)) {
        badJson(res);
        return;
      }
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') {
        sendJson(res, 422, { message: 'Validation Failed: title and head are required' });
        return;
      }
      const created = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      if ('error' in created) {
        sendJson(res, 422, { message: `Validation Failed: ${created.error}` });
        return;
      }
      sendJson(res, 201, pullJson(repo, created));
      return;
    }
    const prNumber = Number(rest[1]);
    if (rest.length >= 2 && Number.isInteger(prNumber)) {
      const pr = repo.pulls.get(prNumber);
      if (rest.length === 2 && method === 'GET') {
        if (pr === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, pullJson(repo, pr));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pr === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, store.pullFiles(repo, pr).map((file) => ({
          filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes,
        })));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr === undefined) {
          notFound(res);
          return;
        }
        const body = parseJsonBody(await readBody(req));
        if (body !== undefined && !isRecord(body)) {
          badJson(res);
          return;
        }
        const merged = store.mergePull(repo, prNumber);
        if ('error' in merged) {
          if (merged.error === 'not-found') {
            notFound(res);
            return;
          }
          if (merged.error === 'conflict') {
            sendJson(res, 405, { message: 'the pull request cannot be merged: it has a merge conflict' });
            return;
          }
          sendJson(res, 409, { message: `the pull request cannot be merged: it is ${merged.error}` });
          return;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: pr.title });
        return;
      }
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => ({ name, oid }));
}

function uploadPackCapsV0(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
}

function receivePackCapsV0(): string {
  return `report-status side-band-64k delete-refs agent=${AGENT}`;
}

/** The v0 advertisement: service line, flush, ref lines (caps on the first line only). */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? receivePackCapsV0() : uploadPackCapsV0(repo);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(({ name, oid }, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${oid} ${name}${suffix}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(encodePktLine(`${parseTag(object.data).object} ${name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement: service line, flush, `version 2`, capability lines, flush. */
function v2Advertisement(service: string): Buffer {
  return Buffer.concat([
    encodePktLine(`# service=${service}\n`),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

/** Split a v2 request body into its command line and the argument lines after the delim. */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      command = text;
      continue;
    }
    if (seenDelim) args.push(text);
  }
  return command === '' ? null : { command, args };
}

/** The v2 ls-refs answer: ref lines (HEAD first, with symref-target), then flush. */
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let wantUnborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'unborn') wantUnborn = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (refs.length === 0) {
    // Only the HEAD unborn line — never a `unborn refs/heads/main` line.
    if (wantUnborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  } else {
    if (defaultTip !== null && keep('HEAD')) lines.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    for (const { name, oid } of refs) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
      lines.push(line);
    }
  }
  const parts = lines.map((line) => encodePktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Split a packfile into sideband band-1 packets (each pkt-line ≤ 65,520 bytes total). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxData = 65515; // 65520 - 4 (pkt-line header) - 1 (band byte)
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(offset + maxData, pack.length));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** The haves the server shares with the client, for ACK lines (a have equal to, or an ancestor of, a want). */
function commonHaves(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  const common: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (wants.includes(have)) {
      common.push(have);
      continue;
    }
    for (const want of wants) {
      if (store.isDescendant(repo, want, have)) {
        common.push(have);
        break;
      }
    }
  }
  return common;
}

function wantedRefLines(repo: Repo, wants: readonly string[]): string[] {
  const lines: string[] = [];
  for (const want of wants) {
    for (const { name, oid } of sortedRefs(repo)) {
      if (oid === want) lines.push(`${want} ${name}`);
    }
  }
  return lines;
}

/** The v2 fetch answer: acknowledgments, shallow-info, wanted-refs, packfile — each section delimited. */
function buildFetchResponseV2(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | undefined): Buffer {
  const { objects, shallow, unshallow } = store.fetchObjects(repo, wants, haves, depth, clientShallow);
  const common = commonHaves(repo, wants, haves);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (common.length > 0) {
    for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs = wantedRefLines(repo, wants);
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(encodePktLine(`${line}\n`));
    parts.push(pktDelim());
  }
  if (objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    for (const packet of sidebandPackets(writePack(objects))) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK lines, shallow/unshallow lines, sideband pack, flush. */
function buildFetchResponseV0(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | undefined): Buffer {
  const { objects, shallow, unshallow } = store.fetchObjects(repo, wants, haves, depth, clientShallow);
  const common = commonHaves(repo, wants, haves);
  const parts: Buffer[] = [];
  if (common.length > 0) {
    for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    for (const packet of sidebandPackets(writePack(objects))) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v0 upload-pack request: wants/shallow/deepen, flush, haves/done, flush. */
function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    if (section === 0) {
      // In v0 the first want line carries capabilities after a SPACE (not NUL): only the
      // first token is the wanted oid.
      if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(/\s+/)[0]!);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    }
  }
  return { wants, haves, shallow, depth };
}

/** The byte offset just past the first flush packet, or -1 when the body has none. */
function firstFlushEnd(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) return -1;
    if (length === 0) return offset + 4;
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) return -1;
    offset += length;
  }
  return -1;
}

/** Apply one ref update; returns null on success, the `ng` reason on refusal. */
function applyRefUpdate(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): string | null {
  if (!command.ref.startsWith('refs/')) return 'invalid ref name';
  const current = repo.refs.get(command.ref) ?? null;
  if (command.newOid === ZERO_OID) {
    if (current === null) return 'reference does not exist';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'old value mismatch';
    repo.refs.delete(command.ref);
    return null;
  }
  if (!repo.objects.has(command.newOid)) return 'object not found';
  if (command.oldOid === ZERO_OID) {
    if (current !== null) return 'reference already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === null) return 'reference does not exist';
  if (current !== command.oldOid) return 'old value mismatch';
  if (!store.isDescendant(repo, command.newOid, command.oldOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (version2) {
    const parsed = parseV2Request(body);
    if (parsed === null) {
      sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
      return;
    }
    if (parsed.command === 'command=ls-refs') {
      sendBuffer(res, 200, lsRefsResponse(repo, parsed.args), 'application/x-git-upload-pack-result');
      return;
    }
    if (parsed.command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const arg of parsed.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
      }
      sendBuffer(res, 200, buildFetchResponseV2(repo, wants, haves, shallow, depth), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: `unknown v2 command ${parsed.command}` });
    return;
  }
  const parsed = parseV0Fetch(body);
  if (parsed === null) {
    sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
    return;
  }
  sendBuffer(res, 200, buildFetchResponseV0(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const flushEnd = firstFlushEnd(body);
  if (flushEnd < 0) {
    sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body.subarray(0, flushEnd));
  } catch {
    sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
    return;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      sendJson(res, 400, { message: 'a receive-pack command line does not parse' });
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const packBytes = body.subarray(flushEnd);
  if (packBytes.length > 0) {
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(packBytes);
    } catch {
      sendJson(res, 400, { message: 'the packfile does not parse' });
      return;
    }
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const report: string[] = ['unpack ok'];
  for (const command of commands) {
    const reason = applyRefUpdate(repo, command);
    report.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const reportData = encodePktLines(report.map((line) => `${line}\n`));
  const response = Buffer.concat([
    encodePktLine(Buffer.concat([Buffer.from([1]), reportData])),
    pktFlush(),
  ]);
  sendBuffer(res, 200, response, 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    const url = urlOf(req);
    const path = url.pathname;
    const query = url.searchParams;
    const segments = path.split('/').filter((segment) => segment !== '');

    // The env's boot check: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // The GitHub API root: 200 with the token's scopes. No auth (the starter answers it open).
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // Git smart HTTP: /:owner/:repo.git/info/refs | git-upload-pack | git-receive-pack.
    if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -4);
      const repo = lookupRepo(owner, repoName);
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const rest = segments.slice(2);
      if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
        const service = query.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'a service parameter is required' });
          return;
        }
        const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (service === 'git-upload-pack' && version2) {
          sendBuffer(res, 200, v2Advertisement(service), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
        }
        return;
      }
      if (method === 'POST' && rest[0] === 'git-upload-pack') {
        await handleUploadPack(req, res, repo);
        return;
      }
      if (method === 'POST' && rest[0] === 'git-receive-pack') {
        await handleReceivePack(req, res, repo);
        return;
      }
      notFound(res);
      return;
    }

    // Everything else needs the token.
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    if (method === 'POST' && path === '/mcp') {
      const raw = (await readBody(req)).toString('utf8');
      const answer = handleMcp(store, raw);
      if (answer.json === undefined) {
        res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendJson(res, answer.status, answer.json);
      return;
    }

    if (method === 'POST' && path === '/api/graphql') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined) {
        badJson(res);
        return;
      }
      sendJson(res, 200, executeGraphQL(store, VIEWER_LOGIN, body));
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      await handleRest(req, res, segments.slice(2), query, path);
      return;
    }

    notFound(res);
  } catch (err) {
    console.error('[entry]', err instanceof Error ? err.stack ?? err.message : String(err));
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
  }
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
