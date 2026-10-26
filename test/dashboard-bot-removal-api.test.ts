import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBotRemovalApi } from '../src/dashboard/bot-removal-api.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function setup(canManageHost = true, failLaunch = false) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bot-removal-api-'));
  dirs.push(dir);
  const path = join(dir, 'bots.json');
  await fs.writeFile(path, JSON.stringify([{ larkAppId: 'cli_target', larkAppSecret: 'private' }]));
  const launch = vi.fn(() => { if (failLaunch) throw new Error('launch failed'); });
  const server = createServer(async (req, res) => {
    const handled = await handleBotRemovalApi(req, res, new URL(req.url!, 'http://localhost'), {
      canManageHost, configPath: () => path, launch,
      readJsonBody: async request => {
        let text = '';
        for await (const chunk of request) text += chunk;
        return JSON.parse(text);
      },
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (body: unknown, origin = base, id = 'cli_target') => fetch(`${base}/api/bots/${id}/delete`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, launch, path };
}

describe('Dashboard bot removal API', () => {
  it('requires management authority, same origin and exact confirmation', async () => {
    const guest = await setup(false);
    expect((await guest.request({ confirmAppId: 'cli_target' })).status).toBe(403);
    expect(guest.launch).not.toHaveBeenCalled();
    const owner = await setup();
    expect((await owner.request({ confirmAppId: 'cli_target' }, 'https://foreign.example')).status).toBe(403);
    expect((await owner.request({ confirmAppId: 'cli_other' })).status).toBe(400);
    expect((await owner.request({ confirmAppId: 'cli_absent' }, undefined, 'cli_absent')).status).toBe(404);
    expect(owner.launch).not.toHaveBeenCalled();
  });

  it('acknowledges a detached exact-target removal without mutating live config', async () => {
    const { request, launch, path } = await setup();
    const result = await request({ confirmAppId: 'cli_target' });
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ ok: true, pending: true });
    expect(launch).toHaveBeenCalledWith('cli_target');
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toHaveLength(1);
  });

  it('surfaces driver launch failures instead of reporting successful deletion', async () => {
    const { request } = await setup(true, true);
    const response = await request({ confirmAppId: 'cli_target' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'launch failed' });
  });
});
