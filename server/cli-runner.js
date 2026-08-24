import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLI_LIMITS = Object.freeze({ prompt:32 * 1024, schema:64 * 1024, stdout:1024 * 1024, stderr:16 * 1024, result:256 * 1024 });
const safeEnvironmentNames = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'USERPROFILE', 'SystemRoot', 'ComSpec'];
const safeErrorCodes = new Set(['unavailable', 'busy', 'timeout', 'aborted', 'nonzero', 'unsupported_argument', 'auth_failed', 'environment_error', 'schema_transport', 'malformed_output', 'absent_output', 'oversize_output', 'schema_invalid', 'rate_limited']);

function safeExitReason(stderr) {
  const text = stderr.toLowerCase();
  if (/unknown (option|argument)|unrecognized option|invalid option/.test(text)) return 'unsupported_argument';
  if (/auth|login|credential|oauth|subscription/.test(text)) return 'auth_failed';
  if (/json.?schema|structured.?output|schema/.test(text)) return 'schema_transport';
  if (/home|keychain|environment|config/.test(text)) return 'environment_error';
  return 'nonzero';
}

export class CliRunnerError extends Error {
  constructor(code) { super(code); this.code = safeErrorCodes.has(code) ? code : 'nonzero'; }
}

function boundedBuffer(onOverflow, limit) {
  const chunks = []; let size = 0; let exceeded = false;
  return {
    push(chunk) { if (exceeded) return; size += chunk.length; if (size > limit) { exceeded = true; onOverflow(); return; } chunks.push(chunk); },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    get exceeded() { return exceeded; },
  };
}

function safeEnv(env) {
  const kept = Object.fromEntries(safeEnvironmentNames.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  return { ...kept, TERM:'dumb', NO_COLOR:'1' };
}

async function readBounded(filename, maximum) {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (stat.size > maximum) throw new CliRunnerError('oversize_output');
    const output = Buffer.alloc(stat.size);
    await handle.read(output, 0, stat.size, 0);
    return output.toString('utf8');
  } catch (error) {
    if (error instanceof CliRunnerError) throw error;
    if (error?.code === 'ENOENT') throw new CliRunnerError('absent_output');
    throw new CliRunnerError('nonzero');
  } finally { await handle?.close(); }
}

export function createCliRunner({ spawn = defaultSpawn, fileSystem = fs, tempDirectory = os.tmpdir(), env = process.env, timeoutMs = 60000, maxConcurrency = 1, maxQueue = 3 } = {}) {
  let running = 0; const queue = [];
  const schedule = (task, signal) => new Promise((resolve, reject) => {
    if (queue.length + running >= maxConcurrency + maxQueue) return reject(new CliRunnerError('busy'));
    if (signal?.aborted) return reject(new CliRunnerError('aborted'));
    const item = { task, resolve, reject, signal, onAbort:null };
    item.onAbort = () => { const index = queue.indexOf(item); if (index >= 0) { queue.splice(index, 1); reject(new CliRunnerError('aborted')); } };
    signal?.addEventListener('abort', item.onAbort, { once:true }); queue.push(item); drain();
  });
  const drain = () => { while (running < maxConcurrency && queue.length) { const item = queue.shift(); item.signal?.removeEventListener('abort', item.onAbort); running += 1; item.task().then(item.resolve, item.reject).finally(() => { running -= 1; drain(); }); } };

  async function execute({ executable, argv, prompt = '', schema = null, output = false, signal }) {
    if (!executable || !Array.isArray(argv)) throw new CliRunnerError('unavailable');
    if (Buffer.byteLength(prompt) > CLI_LIMITS.prompt || (schema && Buffer.byteLength(schema) > CLI_LIMITS.schema)) throw new CliRunnerError('oversize_output');
    if (signal?.aborted) throw new CliRunnerError('aborted');
    return schedule(async () => {
      if (signal?.aborted) throw new CliRunnerError('aborted');
      const workspace = await fileSystem.mkdtemp(path.join(tempDirectory, 'pagent-cli-'));
      const schemaFile = path.join(workspace, 'schema.json'); const outputFile = path.join(workspace, 'output.json'); const mcpFile = path.join(workspace, 'mcp.json');
      let child; let timer; let killed = false;
      const stop = () => {
        if (!child || killed) return; killed = true;
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 250).unref();
      };
      try {
        await fileSystem.chmod(workspace, 0o700);
        if (schema) await fileSystem.writeFile(schemaFile, schema, { mode:0o600 });
        await fileSystem.writeFile(mcpFile, '{"mcpServers":{}}', { mode:0o600 });
        const expandedArgv = argv.map(value => value === '{workspace}' ? workspace : value === '{schemaFile}' ? schemaFile : value === '{outputFile}' ? outputFile : value === '{mcpFile}' ? mcpFile : value);
        if (signal?.aborted) throw new CliRunnerError('aborted');
        const completed = await new Promise((resolve, reject) => {
          let endCode = 'nonzero'; let settled = false;
          const settle = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
          const stdout = boundedBuffer(() => { endCode = 'oversize_output'; stop(); }, CLI_LIMITS.stdout);
          const stderr = boundedBuffer(() => { endCode = 'oversize_output'; stop(); }, CLI_LIMITS.stderr);
          const abort = () => { endCode = 'aborted'; stop(); };
          if (signal?.aborted) return settle(reject, new CliRunnerError('aborted'));
          try {
            child = spawn(executable, expandedArgv, { cwd:workspace, shell:false, detached:process.platform !== 'win32', env:safeEnv(env), stdio:['pipe','pipe','pipe'] });
          } catch { return settle(reject, new CliRunnerError('unavailable')); }
          child.once('error', () => settle(reject, new CliRunnerError('unavailable')));
          child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
          child.once('close', code => { if (endCode !== 'nonzero') return settle(reject, new CliRunnerError(endCode)); if (code !== 0) return settle(reject, new CliRunnerError(safeExitReason(stderr.text()))); settle(resolve, stdout.text()); });
          timer = setTimeout(() => { endCode = 'timeout'; stop(); }, timeoutMs);
          signal?.addEventListener('abort', abort, { once:true });
          child.stdin.on('error', () => {}); child.stdin.end(prompt, 'utf8');
        });
        return output ? await readBounded(outputFile, CLI_LIMITS.result) : completed;
      } finally {
        clearTimeout(timer); stop(); await fileSystem.rm(workspace, { recursive:true, force:true });
      }
    }, signal);
  }
  return { execute, safeEnv: () => safeEnv(env), pending: () => ({ running, queued:queue.length }) };
}
