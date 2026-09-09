import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DesktopOrchestratorRuntime, detectRuntime, desktopProcessListArgs } from '../src/runtime.js';
import { createServer } from '../src/mcp.js';

test('Desktop launch-ID process inspection includes environments on every supported OS', () => {
  assert.deepEqual(desktopProcessListArgs('darwin'), ['eww', '-ax']);
  assert.deepEqual(desktopProcessListArgs('linux'), ['-eww', '-ax']);
  assert.deepEqual(desktopProcessListArgs('win32'), ['-eww', '-ax']);
});

test('Desktop runtime probes /api/projects and never infers write authorization from an env var', async () => {
  const previousFetch = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'test-only';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    const caps = await runtime.capabilities();
    assert.equal(caps.orchestrator, true);
    assert.equal(caps.readOnly, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  }
});

test('Desktop provider errors preserve the actionable API reason', async () => {
  const previousFetch = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'detail-test-launch';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/message')) return new Response(JSON.stringify({ error: 'effort is not supported by the selected model' }), { status: 400 });
    return new Response(null, { status: 200 });
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    await assert.rejects(() => runtime.sendMessage('thread-1', 'hello'), /effort is not supported by the selected model/);
  } finally { globalThis.fetch = previousFetch; if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch; }
});

test('Desktop runtime enables writes only after /healthz verifies the dynamic launch id', async () => {
  const previousFetch = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'dynamic-launch-id';
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/healthz')) { seen.push(String((init?.headers as Record<string, string>)?.['x-freebuff-launch-id'])); return new Response(JSON.stringify({ ok:true }), { status:200 }); }
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status:200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    const caps = await runtime.capabilities();
    assert.equal(caps.readOnly, false);
    assert.deepEqual(seen, ['dynamic-launch-id']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  }
});

test('Desktop refreshes its port and launch ID after a restart and retries the write', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  let activePort = 55354;
  let activeLaunch = 'old-launch-id';
  const seen: string[] = [];
  process.env.FREEBUFF_ORCHESTRATOR_URL = 'http://127.0.0.1:55354';
  process.env.FREEBUFF_LAUNCH_ID = activeLaunch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const launch = String((init?.headers as Record<string, string> | undefined)?.['x-freebuff-launch-id'] ?? '');
    if (url.port !== String(activePort)) return new Response('offline', { status: 503 });
    if (url.pathname === '/api/projects') return launch === activeLaunch ? new Response(JSON.stringify({ projects: [] }), { status: 200 }) : new Response('forbidden', { status: 403 });
    if (url.pathname === '/healthz') return launch === activeLaunch ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response('forbidden', { status: 403 });
    if (url.pathname.endsWith('/message')) {
      seen.push(`${url.port}:${launch}`);
      if (launch === 'old-launch-id') {
        activePort = 55355;
        activeLaunch = 'new-launch-id';
        process.env.FREEBUFF_ORCHESTRATOR_URL = 'http://127.0.0.1:55355';
        process.env.FREEBUFF_LAUNCH_ID = activeLaunch;
        return new Response('forbidden', { status: 403 });
      }
      return new Response(JSON.stringify({ queued: true }), { status: 200 });
    }
    if (url.pathname === '/api/events') return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  const runtime = new DesktopOrchestratorRuntime();
  try {
    assert.equal((await runtime.capabilities()).readOnly, false);
    assert.deepEqual(await runtime.sendMessage('thread-1', 'hello'), { queued: true });
    assert.deepEqual(seen, ['55354:old-launch-id', '55355:new-launch-id']);
  } finally {
    runtime.dispose(); globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  }
});

test('stale explicit Desktop URL falls back to the newly discovered port', async () => {
  const previousFetch = globalThis.fetch;
  const previousReady = process.env.FREEBUFF_DESKTOP_READINESS_FILE;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  const directory = await fs.mkdtemp(`${os.tmpdir()}${pathSep()}`);
  const readiness = `${directory}/readiness.json`;
  await fs.writeFile(readiness, JSON.stringify({ url: 'http://127.0.0.1:55360', launchId: 'new-launch-id', timestamp: new Date().toISOString() }));
  process.env.FREEBUFF_DESKTOP_READINESS_FILE = readiness;
  process.env.FREEBUFF_LAUNCH_ID = 'new-launch-id';
  const ports: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    ports.push(url.port);
    if (url.port === '55360' && url.pathname === '/api/projects') return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (url.port === '55360' && url.pathname === '/healthz') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.port === '55360' && url.pathname === '/api/events') return new Response(null, { status: 200 });
    return new Response('offline', { status: 503 });
  };
  const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55359');
  try {
    assert.equal((await runtime.capabilities()).readOnly, false);
    assert.equal(ports.includes('55359'), true);
    assert.equal(ports.includes('55360'), true);
  } finally {
    runtime.dispose(); globalThis.fetch = previousFetch; await fs.rm(directory, { recursive: true, force: true });
    if (previousReady === undefined) delete process.env.FREEBUFF_DESKTOP_READINESS_FILE; else process.env.FREEBUFF_DESKTOP_READINESS_FILE = previousReady;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  }
});

test('stale readiness metadata is ignored during authorization refresh', async () => {
  const previousFetch = globalThis.fetch;
  const previousFile = process.env.FREEBUFF_DESKTOP_READINESS_FILE;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  const directory = await fs.mkdtemp(`${os.tmpdir()}${pathSep()}`);
  const file = `${directory}/readiness.json`;
  await fs.writeFile(file, JSON.stringify({ url:'http://127.0.0.1:55356', launchId:'stale-launch-id', timestamp: new Date(Date.now() - 60 * 60_000).toISOString() }));
  process.env.FREEBUFF_DESKTOP_READINESS_FILE = file;
  process.env.FREEBUFF_ORCHESTRATOR_URL = 'http://127.0.0.1:55357';
  process.env.FREEBUFF_LAUNCH_ID = 'fresh-launch-id';
  const ports: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); ports.push(url.port);
    const launch = String((init?.headers as Record<string, string> | undefined)?.['x-freebuff-launch-id'] ?? '');
    if (url.port === '55357' && url.pathname === '/api/projects') return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (url.port === '55357' && url.pathname === '/healthz' && launch === 'fresh-launch-id') return new Response(JSON.stringify({ ok:true }), { status:200 });
    throw new Error(`unexpected ${url}`);
  };
  const runtime = new DesktopOrchestratorRuntime();
  try { assert.equal((await runtime.capabilities()).readOnly, false); assert.equal(ports.includes('55356'), false); }
  finally { runtime.dispose(); globalThis.fetch = previousFetch; await fs.rm(directory, { recursive:true, force:true }); if (previousFile === undefined) delete process.env.FREEBUFF_DESKTOP_READINESS_FILE; else process.env.FREEBUFF_DESKTOP_READINESS_FILE = previousFile; if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl; if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch; }
});

test('separate bridge instances refresh independently instead of retaining authorization', async () => {
  const previousFetch = globalThis.fetch; const previousLaunch = process.env.FREEBUFF_LAUNCH_ID; process.env.FREEBUFF_LAUNCH_ID = 'old-launch-id'; const healthHeaders: string[] = [];
  globalThis.fetch = async (input, init) => { const url = new URL(String(input)); const launch = String((init?.headers as Record<string, string> | undefined)?.['x-freebuff-launch-id'] ?? ''); if (url.pathname === '/healthz') { healthHeaders.push(launch); return new Response(JSON.stringify({ ok:true }), { status:200 }); } if (url.pathname === '/api/projects') return new Response(JSON.stringify({ projects: [] }), { status:200 }); if (url.pathname === '/api/events') return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { status:200 }); throw new Error(`unexpected ${url}`); };
  const first = new DesktopOrchestratorRuntime('http://127.0.0.1:55358'); const second = new DesktopOrchestratorRuntime('http://127.0.0.1:55358');
  try { await Promise.all([first.capabilities(), second.capabilities()]); process.env.FREEBUFF_LAUNCH_ID = 'new-launch-id'; await Promise.all([first.refreshDesktopConnection(), second.refreshDesktopConnection()]); assert.deepEqual(healthHeaders.slice(-2), ['new-launch-id', 'new-launch-id']); }
  finally { first.dispose(); second.dispose(); globalThis.fetch = previousFetch; if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch; }
});

function pathSep(): string { return process.platform === 'win32' ? '\\' : '/'; }

test('explicit CLI mode takes precedence over Desktop discovery', async () => {
  const previous = process.env.FREEBUFF_MCP_CLI_MODE;
  process.env.FREEBUFF_MCP_CLI_MODE = 'pty';
  try { assert.equal((await detectRuntime()).constructor.name, 'CliPtyRuntime'); }
  finally { if (previous === undefined) delete process.env.FREEBUFF_MCP_CLI_MODE; else process.env.FREEBUFF_MCP_CLI_MODE = previous; }
});

test('Desktop runtime rejects malformed project and thread payloads', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [{ path: 42 }, { path: 'C:/valid' }] }), { status: 200 });
    if (url.endsWith('/api/thread/thread-1')) return new Response(JSON.stringify(['not-a-thread']), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    assert.deepEqual(await runtime.listProjects(), [{ id:'C:/valid', path:'C:/valid', name:'valid', metadata:{path:'C:/valid'} }]);
    await assert.rejects(() => runtime.getThread('thread-1'), /Invalid Freebuff thread response/);
  } finally { globalThis.fetch = previousFetch; }
});

test('read-only servers omit mutation tools', () => {
  const runtime = { capabilities: async () => ({ product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:[] }), listProjects:async()=>[], listThreads:async()=>[], getThread:async()=>({}), getMessages:async()=>[], activeWork:async()=>[], listFiles:async()=>[], readFile:async()=>({path:'',content:''}), sendMessage:async()=>({}), stop:async()=>({}), resume:async()=>({}), listModels:async()=>({}), setModel:async()=>({}), setReasoning:async()=>({}) } as any;
  const tools = Object.keys((createServer(runtime, false) as any)._registeredTools);
  assert.equal(tools.includes('send_message'), false);
  assert.equal(tools.includes('set_model'), false);
});

test('provider read-only status does not hide unrelated provider mutation tools', () => {
  const runtime = { capabilities: async () => ({ product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:[] }), listProjects:async()=>[], listThreads:async()=>[], getThread:async()=>({}), getMessages:async()=>[], activeWork:async()=>[], listFiles:async()=>[], readFile:async()=>({path:'',content:''}), sendMessage:async()=>({}), stop:async()=>({}), resume:async()=>({}), listModels:async()=>({}), setModel:async()=>({}), setReasoning:async()=>({}) } as any;
  const tools = Object.keys((createServer(runtime, true) as any)._registeredTools);
  assert.equal(tools.includes('agent_send'), true);
});
