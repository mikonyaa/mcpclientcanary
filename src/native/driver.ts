import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Recorder, digest } from '../evidence/collector.js';
import { nativeArgs } from '../adapters/claude-code/index.js';
import { childEnvironment, type Owned } from './isolation.js';
import { type Loopback } from '../model/loopback.js';
import { CanaryError, MAX_BYTES, obj, arr, type Data } from '../types.js';
export class NativeDriver {
  readonly recorder = new Recorder('native');
  child: ChildProcessWithoutNullStreams | undefined;
  sessionId: string | undefined;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private failure: CanaryError | undefined;
  private record(...args: Parameters<Recorder['add']>): void {
    try {
      this.recorder.add(...args);
    } catch (e) {
      this.failure =
        e instanceof CanaryError ? e : new CanaryError('Native evidence recorder I/O error');
      this.rejectTurn?.(this.failure);
      this.stop(this.child);
    }
  }
  private bytes = 0;
  private resolveTurn: ((v: Data) => void) | undefined;
  private rejectTurn: ((e: Error) => void) | undefined;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  private stop(
    child: ChildProcessWithoutNullStreams | undefined,
    signal: NodeJS.Signals = 'SIGTERM',
  ) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
  }
  private abort = () => {
    this.stop(this.child);
    this.rejectTurn?.(new CanaryError('Cancelled', 130));
  };
  constructor(
    readonly executable: string,
    readonly owned: Owned,
    readonly model: Loopback,
    readonly timeoutMs: number,
    readonly signal?: AbortSignal,
  ) {}
  start(mcp: string, resume?: string): void {
    if (this.signal?.aborted) throw new CanaryError('Cancelled', 130);
    const args = nativeArgs(mcp, resume);
    const child = spawn(this.executable, args, {
      cwd: this.owned.project,
      env: childEnvironment(this.owned.config, this.model.url),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.recorder.pidOverride = child.pid;
    this.record(
      'spawn',
      {
        pid: child.pid,
        argv: args.map((x) => (x === mcp ? '<case>/mcp.json' : x)),
        resumeRequested: resume ?? null,
        environmentKeys: Object.keys(childEnvironment(this.owned.config, this.model.url)).sort(),
      },
      this.model.phase,
      this.model.generation,
    );
    this.exited = new Promise((r) =>
      child.once('close', (code, signal) => {
        this.buffer += this.decoder.end();
        this.record(
          'process-exit',
          { pid: child.pid, code, signal, stdoutComplete: this.buffer.trim() === '' },
          this.model.phase,
          this.model.generation,
        );
        r({ code, signal });
        if (this.rejectTurn)
          this.rejectTurn(new CanaryError('Native process exited before a completed turn'));
      }),
    );
    child.on('error', () => this.rejectTurn?.(new CanaryError('Native executable launch failed')));
    child.stderr.on('data', (c: Buffer) => {
      this.bytes += c.length;
      if (this.bytes > MAX_BYTES) {
        this.rejectTurn?.(new CanaryError('Native output exceeded 16 MiB'));
        this.stop(child);
        return;
      }
      this.record(
        'stderr',
        { bytes: c.length, sha256: digest(c.toString()) },
        this.model.phase,
        this.model.generation,
        'in',
      );
    });
    child.stdout.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > MAX_BYTES) {
        this.rejectTurn?.(new CanaryError('Native output exceeded 16 MiB'));
        this.stop(child);
        return;
      }
      this.buffer += this.decoder.write(chunk);
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          this.onMessage(obj(JSON.parse(line)), resume);
        } catch (e) {
          this.failure =
            e instanceof CanaryError ? e : new CanaryError('Malformed native stream-json');
          this.rejectTurn?.(
            e instanceof CanaryError ? e : new CanaryError('Malformed native stream-json'),
          );
          this.stop(child);
        }
      }
    });
    this.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private onMessage(x: Data, resume?: string) {
    if (x.type === 'system' && x.subtype === 'init') {
      if (typeof x.session_id !== 'string' || !/^[-a-f0-9]{36}$/.test(x.session_id))
        throw new CanaryError('Missing native structured session ID', 3);
      this.sessionId = x.session_id;
      const inventory = arr(x.tools).filter((t) => typeof t === 'string');
      if (
        inventory.some(
          (t) => t !== 'ToolSearch' && !/^mcp__canary__lookup_(record|summary)$/.test(String(t)),
        )
      )
        throw new CanaryError('Unrelated tool or integration in isolated native inventory', 3);
      this.record(
        'init',
        {
          sessionId: x.session_id,
          resumeRequested: resume ?? null,
          nativeTools: inventory,
          mcpServers: arr(x.mcp_servers).map((s) => ({ name: obj(s).name, status: obj(s).status })),
        },
        this.model.phase,
        this.model.generation,
        'in',
      );
    }
    for (const block of arr(obj(x.message).content).map(obj))
      if (block.type === 'tool_result' && this.model.ids.has(String(block.tool_use_id))) {
        this.record(
          'loaded-result',
          {
            stage: this.model.stage,
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            references: arr(block.content)
              .map(obj)
              .filter((b) => b.type === 'tool_reference')
              .map((b) => ({ type: b.type, tool_name: b.tool_name })),
          },
          this.model.phase,
          this.model.generation,
          'in',
        );
      }
    if (x.type === 'result') {
      const result = { sessionId: x.session_id, isError: x.is_error === true, subtype: x.subtype };
      this.record(
        'turn-complete',
        { stage: this.model.stage, ...result },
        this.model.phase,
        this.model.generation,
        'in',
      );
      if (this.model.error) {
        this.rejectTurn?.(this.model.error);
      } else if (result.isError || x.subtype !== 'success') {
        this.rejectTurn?.(new CanaryError('Native turn ended with an error result'));
      } else this.resolveTurn?.(result);
    }
  }
  async turn(prompt: string): Promise<Data> {
    if (this.failure) throw this.failure;
    if (this.signal?.aborted) throw new CanaryError('Cancelled', 130);
    if (!this.child) throw new CanaryError('Native process not running');
    return new Promise<Data>((resolve, reject) => {
      const finish = (fn: (x: never) => void, x: unknown) => {
        clearTimeout(timer);
        this.resolveTurn = undefined;
        this.rejectTurn = undefined;
        fn(x as never);
      };
      const timer = setTimeout(() => {
        this.stop(this.child);
        finish(reject, new CanaryError('Native phase deadline expired; coverage incomplete', 3));
      }, this.timeoutMs);
      this.resolveTurn = (x) => finish(resolve, x);
      this.rejectTurn = (e) => finish(reject, e);
      this.child?.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
        (e) => {
          if (e) this.rejectTurn?.(new CanaryError('Native stdin I/O error'));
        },
      );
    });
  }
  async close(graceful = true): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    this.resolveTurn = undefined;
    this.rejectTurn = undefined;
    if (graceful) child.stdin.end();
    else this.stop(child);
    const timer = setTimeout(() => this.stop(child), 5000);
    const kill = setTimeout(() => this.stop(child, 'SIGKILL'), 7000);
    const result = await this.exited;
    clearTimeout(timer);
    clearTimeout(kill);
    this.signal?.removeEventListener('abort', this.abort);
    this.child = undefined;
    if (graceful && this.failure) throw this.failure;
    if (graceful && (result.code !== 0 || result.signal || this.buffer.trim()))
      throw new CanaryError('Native process did not close with complete structured output');
  }
}
