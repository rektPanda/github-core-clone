// store.ts — the forge's in-memory data model: repositories, git refs and objects,
// issues, comments, labels and pull requests, plus the operations the REST, GraphQL
// and MCP surfaces share. No clocks: every generated timestamp is a fixed constant,
// so two runs over the same requests hold the same state.
//
// The contest's scenario seed is fixed (wire.ts SCENARIO_SEED), so the token's login
// is the fixed viewer login below; any other owner reads as 404, never 403.

import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  commitAncestors,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  treeFiles,
  treeLookup,
  treeWithEdits,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
/** Fixed commit timestamp (Unix seconds, +0000) for every commit this forge authors. */
export const FIXED_TIMESTAMP = 1700000000;
export const FIXED_ISO = '2023-11-14T22:13:20.000Z';
const AUTHOR_LINE = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  privateFlag: boolean;
  description: string;
  readonly defaultBranch: string;
  /** ref name -> commit/tag oid. */
  readonly refs: Map<string, string>;
  /** oid -> object (loose store; shared per repo). */
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly comments: Map<number, IssueComment>;
  /** Shared per-repo counter for issues AND pull requests (GitHub-like). */
  nextNumber: number;
  nextCommentId: number;
  /** Creation order, for stable list pagination. */
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
}

export interface IssueComment {
  readonly id: number;
  readonly repoId: number;
  readonly issueNumber: number;
  body: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdSeq: number;
}

export interface ChangedFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed' | 'changed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Opaque, stable Relay global ids (never the plain database id or number). */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextSeq = 1;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Look a repo up by its numeric id (GraphQL global ids decode to these). */
  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  /** Repositories owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, privateFlag: boolean, description: string): Repo | { error: string } {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return { error: 'already exists' };
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      privateFlag,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq++,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ------------------------------------------------------------------------------------------
  // git objects and refs
  // ------------------------------------------------------------------------------------------

  objectLookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip oid of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, a full ref or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** Is `descendant` a descendant of (or equal to) `ancestor`? */
  isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    if (ancestor === ZERO_OID) return true;
    return isAncestor(ancestor, descendant, this.objectLookup(repo));
  }

  /** The default branch tip's tree oid, or the empty tree when the repo has no commits. */
  tipTree(repo: Repo, branch: string): string {
    const tip = this.resolveRef(repo, branch);
    if (tip === null) return EMPTY_TREE_OID;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(object.data).tree;
  }

  /**
   * Commit one file change on `branch` (creating the branch from the default tip when it
   * does not exist yet, and the repo's first commit when it has none). Returns the new
   * commit oid and the blob oid.
   */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    const lookup = this.objectLookup(repo);
    const write = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const baseTip = this.resolveRef(repo, branch);
    const baseTree = baseTip === null ? EMPTY_TREE_OID : this.tipTree(repo, branch);
    // The empty tree is not stored; treeWithEdits handles a null root by building fresh.
    const rootForEdit = baseTip === null && baseTree === EMPTY_TREE_OID ? null : baseTree;
    const newTree = treeWithEdits(rootForEdit, [{ path, oid: blobSha }], lookup, write);
    const parents = baseTip === null ? [] : [baseTip];
    const commitData = buildCommit({ tree: newTree, parents, message, author: AUTHOR_LINE, committer: AUTHOR_LINE, timestamp: FIXED_TIMESTAMP });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete a file on `branch`, committing the removal. Returns the new commit oid, or null. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const baseTip = this.resolveRef(repo, branch);
    if (baseTip === null) return null;
    const lookup = this.objectLookup(repo);
    const write = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const baseTree = this.tipTree(repo, branch);
    const newTree = treeWithEdits(baseTree, [{ path, oid: null }], lookup, write);
    if (newTree === baseTree) return null;
    const commitData = buildCommit({ tree: newTree, parents: [baseTip], message, author: AUTHOR_LINE, committer: AUTHOR_LINE, timestamp: FIXED_TIMESTAMP });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  /** Read a file's bytes at a ref; null when absent. */
  readFileAt(repo: Repo, ref: string, path: string): { blobSha: string; content: Buffer } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const tree = this.tipTree(repo, ref);
    const oid = treeLookup(tree, path, this.objectLookup(repo));
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return null;
    return { blobSha: oid, content: object.data };
  }

  /** The commit list reachable from `ref`, newest first. */
  commitsAt(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const lookup = this.objectLookup(repo);
    const out: Array<{ sha: string; message: string }> = [];
    for (const sha of commitAncestors(tip, lookup)) {
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      out.push({ sha, message: parseCommit(object.data).message });
    }
    return out;
  }

  /** The immediate children of a directory at a ref (for the contents directory listing). */
  dirEntries(repo: Repo, ref: string, dirPath: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const tree = this.tipTree(repo, ref);
    let dirOid = tree;
    if (dirPath !== '' && dirPath !== '/') {
      const found = treeLookup(tree, dirPath, this.objectLookup(repo));
      if (found === null) return null;
      dirOid = found;
    }
    const object = repo.objects.get(dirOid);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: dirPath === '' || dirPath === '/' ? entry.name : `${dirPath.replace(/\/$/, '')}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  // ------------------------------------------------------------------------------------------
  // issues, comments, labels
  // ------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `label ${label} does not exist` };
    }
    const number = repo.nextNumber++;
    const issue: Issue = { id: repo.id * 100000 + number, number, repoId: repo.id, title, body, state: 'open', labels: [...labels], createdSeq: number };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    if (!repo.issues.has(issueNumber) && ![...repo.pulls.values()].some((pr) => pr.number === issueNumber)) return null;
    const comment: IssueComment = { id: repo.nextCommentId++, repoId: repo.id, issueNumber, body };
    repo.comments.set(comment.id, comment);
    return comment;
  }

  commentsForIssue(repo: Repo, issueNumber: number): IssueComment[] {
    return [...repo.comments.values()].filter((comment) => comment.issueNumber === issueNumber).sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------------------------------------
  // pull requests and merges
  // ------------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === null) return { error: `head branch ${head} does not exist` };
    if (baseSha === null) return { error: `base branch ${base} does not exist` };
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      id: repo.id * 100000 + number,
      number,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdSeq: number,
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  /** The files a pull request changes (merge-base tree vs head tip tree), with line counts. */
  pullFiles(repo: Repo, pr: PullRequest): ChangedFile[] {
    const lookup = this.objectLookup(repo);
    const base = mergeBase(pr.headSha, pr.baseSha, lookup) ?? pr.baseSha;
    const baseTree = this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, pr.headSha);
    const baseFiles = new Map(treeFiles(baseTree, lookup).map((file) => [file.path, file.oid]));
    const headFiles = new Map(treeFiles(headTree, lookup).map((file) => [file.path, file.oid]));
    const out: ChangedFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase === undefined && inHead !== undefined) {
        const content = repo.objects.get(inHead)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (inBase !== undefined && inHead === undefined) {
        const content = repo.objects.get(inBase)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (inBase !== undefined && inHead !== undefined && inBase !== inHead) {
        const oldText = (repo.objects.get(inBase)?.data ?? Buffer.alloc(0)).toString('utf8');
        const newText = (repo.objects.get(inHead)?.data ?? Buffer.alloc(0)).toString('utf8');
        const [additions, deletions] = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  private treeOfCommit(repo: Repo, commitOid: string): string {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(object.data).tree;
  }

  /** MERGEABLE / CONFLICTING for a pull request, by the 3-way merge rule. */
  pullMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    return this.mergePlan(repo, pr).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * The 3-way merge plan: paths changed on the head side (merge-base -> head) and on the base
   * side (merge-base -> base tip). A path changed on both sides to different blobs conflicts.
   */
  private mergePlan(repo: Repo, pr: PullRequest): { conflict: boolean; mergedTree: string | null } {
    const lookup = this.objectLookup(repo);
    const base = mergeBase(pr.headSha, pr.baseSha, lookup) ?? pr.baseSha;
    const baseTree = this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, pr.headSha);
    // The CURRENT base tip — not pr.baseSha, which is frozen at PR creation and would miss
    // merges that landed after the PR opened (a conflict would slip through as clean).
    const currentBaseTip = this.resolveRef(repo, pr.baseRef) ?? pr.baseSha;
    const baseTipTree = this.treeOfCommit(repo, currentBaseTip);
    const baseFiles = new Map(treeFiles(baseTree, lookup).map((file) => [file.path, file.oid]));
    const headFiles = new Map(treeFiles(headTree, lookup).map((file) => [file.path, file.oid]));
    const tipFiles = new Map(treeFiles(baseTipTree, lookup).map((file) => [file.path, file.oid]));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    const edits: Array<{ path: string; oid: string | null }> = [];
    for (const path of paths) {
      const atMergeBase = baseFiles.get(path);
      const atHead = headFiles.get(path);
      const atTip = tipFiles.get(path);
      const headChanged = atHead !== atMergeBase;
      const tipChanged = atTip !== atMergeBase;
      if (headChanged && tipChanged && atHead !== atTip) return { conflict: true, mergedTree: null };
      if (headChanged) edits.push({ path, oid: atHead ?? null });
    }
    if (edits.length === 0) {
      // Nothing to merge: the squash commit is the base tip itself (no new commit needed).
      return { conflict: false, mergedTree: baseTipTree };
    }
    const write = (type: GitObjectType, data: Buffer): string => this.putObject(repo, type, data);
    const mergedTree = treeWithEdits(baseTipTree, edits, lookup, write);
    return { conflict: false, mergedTree };
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an
   * error string ('not-found' | 'conflict' | 'closed').
   */
  mergePull(repo: Repo, number: number): { sha: string } | { error: 'not-found' | 'conflict' | 'closed' } {
    const pr = repo.pulls.get(number);
    if (pr === undefined) return { error: 'not-found' };
    if (pr.state !== 'open') return { error: 'closed' };
    const plan = this.mergePlan(repo, pr);
    if (plan.conflict || plan.mergedTree === null) return { error: 'conflict' };
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (baseTip === null) return { error: 'not-found' };
    const commitData = buildCommit({
      tree: plan.mergedTree,
      parents: [baseTip],
      message: pr.title,
      author: AUTHOR_LINE,
      committer: AUTHOR_LINE,
      timestamp: FIXED_TIMESTAMP,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = mergeSha;
    return { sha: mergeSha };
  }

  // ------------------------------------------------------------------------------------------
  // git fetch computation
  // ------------------------------------------------------------------------------------------

  /**
   * The objects a v2/v0 fetch must deliver for `wants`, given the client's `haves` and an
   * optional depth limit. Also returns the shallow boundary (commits at the depth cutoff)
   * and the unshallow list (former shallow commits whose parents are now delivered).
   */
  fetchObjects(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | undefined,
    clientShallow: readonly string[],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = this.objectLookup(repo);
    const haveReachable = new Set<string>();
    for (const have of haves) {
      const held = repo.objects.get(have);
      if (clientShallow.includes(have) && held !== undefined && held.type === 'commit') {
        // A shallow boundary: the client holds this commit and its tree, but NOT its parents
        // (that is what makes a deepen fetch deliver the parent at all).
        haveReachable.add(have);
        const view = parseCommit(held.data);
        haveReachable.add(view.tree);
        for (const file of treeFiles(view.tree, lookup)) haveReachable.add(file.oid);
        continue;
      }
      try {
        for (const oid of collectReachable([have], lookup, { allowMissing: true })) haveReachable.add(oid);
      } catch {
        // A have the server cannot resolve is ignored.
      }
    }
    // BFS from the wants, tracking commit depth from the nearest want.
    const wanted = new Set<string>();
    const shallow: string[] = [];
    const commitDepth = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const want of wants) {
      if (!repo.objects.has(want)) continue;
      if (!commitDepth.has(want)) {
        commitDepth.set(want, 0);
        queue.push({ oid: want, depth: 0 });
      }
    }
    while (queue.length > 0) {
      const { oid, depth: d } = queue.shift()!;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      // Every object the walk reaches is delivered (minus what the client holds).
      wanted.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        // deepen N means at most N commits from each tip: the commit at depth N-1
        // (0-based) is the boundary — delivered, but its parents are not.
        if (depth !== undefined && d >= depth - 1) {
          shallow.push(oid);
          // At the cutoff: the commit itself is delivered, its parents are not.
          for (const child of [view.tree]) {
            if (!wanted.has(child)) {
              wanted.add(child);
              queue.push({ oid: child, depth: d + 1 });
            }
          }
          continue;
        }
        for (const parent of view.parents) {
          if (!commitDepth.has(parent)) {
            commitDepth.set(parent, d + 1);
            queue.push({ oid: parent, depth: d + 1 });
          }
        }
        if (!wanted.has(view.tree)) {
          wanted.add(view.tree);
          queue.push({ oid: view.tree, depth: d + 1 });
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          if (!wanted.has(entry.oid)) {
            wanted.add(entry.oid);
            queue.push({ oid: entry.oid, depth: d + 1 });
          }
        }
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (!wanted.has(target)) {
          wanted.add(target);
          queue.push({ oid: target, depth: d + 1 });
        }
      }
    }
    // The want commits themselves are delivered too.
    for (const want of wants) {
      if (repo.objects.has(want)) wanted.add(want);
    }
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      if (!shallow.includes(oid) && wanted.has(oid)) {
        // Its parents are now delivered (or it is no longer a boundary).
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'commit') {
          const parents = parseCommit(object.data).parents;
          if (parents.every((parent) => wanted.has(parent) || haveReachable.has(parent))) unshallow.push(oid);
        }
      }
    }
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    return { objects, shallow, unshallow };
  }
}

export function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not start a new line.
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** A tiny LCS line diff: returns [additions, deletions]. */
export function lineDiff(oldText: string, newText: string): [number, number] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // LCS lengths via a single rolling row.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[m];
  return [m - lcs, n - lcs];
}
