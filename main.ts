// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0. Keep this file as it is:
// the suite scores the server app.ts builds, and the lifecycle is the harness's, not the contest's.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports its own server plus the node:http/https built-ins for the env calls, and nothing
// else: no package, no model call. The env calls deliberately avoid fetch(): Node 22 fetch() routes
// through EnvHttpProxyAgent, so a sandbox HTTP(S)_PROXY/no_proxy can swallow register/done forever
// and the trial dies at the wall with working 0. A raw http.request ignores the proxy env entirely.

import { createApp } from './app.ts';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}
try {
  // Fail fast on a malformed env origin: every register and poll attempt would fail on it
  // and the process would only spin until the trial wall, so say so at once.
  new URL(ENV_URL);
} catch {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not a valid URL; cannot reach the env\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * One env request over a raw socket, no proxy: node:http(s) never reads HTTP_PROXY,
 * HTTPS_PROXY or no_proxy, so the call always goes straight to the env origin. Same
 * 30 s timeout per request as fetch() had before; a timeout destroys the request.
 */
function envRequest(path: string, method: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(ENV_URL + path);
    const secure = url.protocol === 'https:';
    const req = (secure ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: url.pathname + url.search,
        method,
        headers: body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`env request ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting. Every failed
 * attempt is logged to stderr with its attempt number, so a stuck register is visible in the trial log.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envRequest('/register', 'POST', JSON.stringify({ port }));
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${res.text}`);
      process.stderr.write(`[entry] register attempt ${attempt + 1} failed: HTTP ${res.status}\n`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      process.stderr.write(`[entry] register attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envRequest('/done', 'GET');
      if (res.status >= 200 && res.status < 300) {
        const body = JSON.parse(res.text) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
