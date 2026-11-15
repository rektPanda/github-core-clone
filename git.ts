// git.ts — the git object layer: pkt-line framing, object hashing/parsing/building,
// packfile reading (plain + OFS/REF deltas) and writing (plain objects only), and
// reachability over the commit/tree/tag graph. Stdlib only (node:crypto, node:zlib).
// Every byte here mirrors the formats program/env/src/git-client.ts speaks.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  // The callers already hold a Buffer (inflate output, built objects): hashing it in place
  // avoids a full copy per object.
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// --------------------------------------------------------------------------------------------
// pkt-line framing
// --------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole pkt-line stream. Throws on a bad length prefix or a truncated packet. */
export function decodePktLines(bytes: Uint8Array): PktPacket[] {
  const buf = Buffer.from(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line stream ends mid-length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line stream ends mid-packet');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}

/** The data-packet payloads as lines (trailing newline stripped), in order. */
export function pktDataLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(bytes)) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// --------------------------------------------------------------------------------------------
// trees, commits, tags
// --------------------------------------------------------------------------------------------

/**
 * Parsed views of immutable objects, cached by the object's own bytes. Commits, trees and
 * tags never change once stored, so a parse is a pure function of the bytes: the same
 * Buffer always parses to the same view. The fetch/clone/merge paths re-parse the same
 * commits and trees over and over (one parse per ancestor step per walk); the cache turns
 * every repeat into a map lookup. A WeakMap keeps the cache's lifetime tied to the object
 * bytes themselves, so nothing can leak and nothing can go stale.
 */
const commitViewCache = new WeakMap<Uint8Array, CommitView>();
const treeViewCache = new WeakMap<Uint8Array, TreeEntry[]>();
const tagViewCache = new WeakMap<Uint8Array, TagView>();

export function parseTree(data: Uint8Array): TreeEntry[] {
  const cached = treeViewCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseTreeFresh(data);
  treeViewCache.set(data, parsed);
  return parsed;
}

function parseTreeFresh(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const cached = commitViewCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseCommitFresh(data);
  commitViewCache.set(data, parsed);
  return parsed;
}

function parseCommitFresh(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const cached = tagViewCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseTagFresh(data);
  tagViewCache.set(data, parsed);
  return parsed;
}

function parseTagFresh(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return { object, type, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8') };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? 'Conformance <conformance@make.fun>'} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? 'Conformance <conformance@make.fun>'} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// --------------------------------------------------------------------------------------------
// reachability
// --------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries,
 * tag -> its target, blob -> nothing. Throws on a missing object unless allowMissing.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (root === ZERO_OID || seen.has(root)) continue;
    seen.add(root);
    queue.push(root);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    const next: string[] = [];
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      next.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') next.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      next.push(parseTag(object.data).object);
    }
    for (const child of next) {
      if (child === ZERO_OID || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/** The commit ancestry of `tip` (first-parent walk is enough: all our histories are linear). */
export function commitAncestors(tip: string, lookup: ObjectLookup): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && current !== ZERO_OID && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') break;
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? Walks the first-parent chain and stops at the first hit — unlike commitAncestors, this never walks the whole history. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (descendant === ancestor) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  let current: string | undefined = descendant;
  while (current !== undefined && current !== ZERO_OID && !seen.has(current)) {
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') return false;
    const parent = parseCommit(object.data).parents[0];
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}

/** The merge base of two tips: the first ancestor of `a` that is also an ancestor of `b`. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const bAncestors = new Set(commitAncestors(b, lookup));
  for (const oid of commitAncestors(a, lookup)) {
    if (bAncestors.has(oid)) return oid;
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// packfiles
// --------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Read a packfile (version 2 or 3) and resolve every object, including OFS/REF deltas. */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): Map<string, GitObject> {
  // The caller hands over a Buffer already (a subarray of the request body): hashing and
  // slicing it in place avoids copying the whole pack per push.
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.from(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): boolean {
  const buffer = Buffer.from(pack);
  if (buffer.length < 20) return false;
  return buffer.subarray(buffer.length - 20).toString('hex') === packChecksum(buffer);
}

// --------------------------------------------------------------------------------------------
// tree surgery: read and write files in a tree, rebuilding parents
// --------------------------------------------------------------------------------------------

/** The blob oid at `path` in the tree `rootOid`, or null when the path is absent. */
export function treeLookup(rootOid: string, path: string, lookup: ObjectLookup): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current: string | undefined = rootOid;
  for (const segment of segments) {
    const object: GitObject | undefined = current === undefined ? undefined : lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry: TreeEntry | undefined = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current ?? null;
}

/** All files under a tree: `{path, oid}` pairs, depth-first, paths joined with '/'. */
export function treeFiles(rootOid: string, lookup: ObjectLookup): Array<{ path: string; oid: string }> {
  const out: Array<{ path: string; oid: string }> = [];
  const walk: (oid: string, prefix: string) => void = (oid, prefix) => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.push({ path, oid: entry.oid });
    }
  };
  walk(rootOid, '');
  return out;
}

export interface TreeEdit {
  /** New blob oid, or null to delete the path. */
  readonly oid: string | null;
  readonly path: string;
}

/**
 * Apply file edits to a tree, returning the new root tree oid. New objects are written through
 * `write` (which stores and returns the oid). `lookup` reads existing objects.
 */
export function treeWithEdits(
  rootOid: string | null,
  edits: readonly TreeEdit[],
  lookup: ObjectLookup,
  write: (type: GitObjectType, data: Buffer) => string,
): string {
  // Group edits by first path segment, recurse per directory.
  const applyAt = (treeOid: string | null, segmentsList: Array<{ segments: string[]; oid: string | null }>): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = lookup(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const grouped = new Map<string, Array<{ segments: string[]; oid: string | null }>>();
    for (const edit of segmentsList) {
      const [head, ...rest] = edit.segments;
      if (head === undefined) continue;
      const list = grouped.get(head) ?? [];
      list.push({ segments: rest, oid: edit.oid });
      grouped.set(head, list);
    }
    for (const [name, rest] of grouped) {
      if (rest.length === 1 && rest[0]!.segments.length === 0) {
        // A file at this level.
        if (rest[0]!.oid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: rest[0]!.oid });
      } else {
        // A directory: recurse.
        const existing = entries.get(name);
        const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
        const newChild = applyAt(childTree, rest);
        const childObject = lookup(newChild);
        const childEntries = childObject !== undefined && childObject.type === 'tree' ? parseTree(childObject.data) : [];
        if (childEntries.length === 0) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: newChild });
      }
    }
    return write('tree', buildTree([...entries.values()]));
  };
  const expanded = edits.map((edit) => ({ segments: edit.path.split('/').filter((s) => s !== ''), oid: edit.oid }));
  return applyAt(rootOid, expanded);
}

/** The empty tree's oid (constant across git). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
