import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planBotRemoval, removeBotsBeforeRestart } from '../src/services/bot-removal.js';

const rows = [
  { larkAppId: 'cli_first', larkAppSecret: 'private-one', cliId: 'claude-code' },
  { larkAppId: 'cli_middle', larkAppSecret: 'private-two', cliId: 'codex' },
  { larkAppId: 'cli_last', larkAppSecret: 'private-three', cliId: 'traex', env: { KEEP: 'yes' } },
];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bot-removal-'));
  dirs.push(dir);
  const path = join(dir, 'bots.json');
  await fs.writeFile(path, JSON.stringify(rows), { mode: 0o600 });
  return path;
}

describe('bot removal', () => {
  it('removes exact app ids while preserving survivor order, secrets and other fields', () => {
    expect(planBotRemoval(rows, ['cli_first', 'cli_middle'])).toEqual([rows[2]]);
    expect(rows).toHaveLength(3);
    expect(planBotRemoval(rows, rows.map(row => row.larkAppId))).toEqual([]);
  });

  it('rejects absent or malformed targets and configured handoff dependencies', () => {
    expect(() => planBotRemoval(rows, ['cli_absent'])).toThrow('bot_not_found');
    expect(() => planBotRemoval(rows, [])).toThrow('invalid_bot_app_id');
    expect(() => planBotRemoval(rows, ['../bots.json'])).toThrow('invalid_bot_app_id');
    const linked = [rows[0], { ...rows[1], quotaFallbackBot: { targetAppId: 'cli_first' } }];
    expect(() => planBotRemoval(linked, ['cli_first'])).toThrow('bot_in_use');
  });

  it('backs up privately and stops the fleet before compacting positional config', async () => {
    const path = await fixture();
    const stop = vi.fn(() => {
      // If the array shifts before stop, old supervisor indices can start a
      // different bot on crash recovery. Guard that externally visible hazard.
      expect(JSON.parse(require('node:fs').readFileSync(path, 'utf8'))).toEqual(rows);
    });
    const recover = vi.fn();
    const backup = await removeBotsBeforeRestart(path, rows, ['cli_middle'], { stop, recover });
    expect(stop).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual([rows[0], rows[2]]);
    expect(JSON.parse(await fs.readFile(backup, 'utf8'))).toEqual(rows);
    if (process.platform !== 'win32') expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
  });

  it('keeps config intact when the fleet cannot stop', async () => {
    const path = await fixture();
    await expect(removeBotsBeforeRestart(path, rows, ['cli_first'], {
      stop: () => { throw new Error('stop timeout'); }, recover: vi.fn(),
    })).rejects.toThrow('stop timeout');
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(rows);
  });

  it('recovers the old generation when atomic persistence fails', async () => {
    const path = await fixture();
    const recover = vi.fn();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failure'));
    await expect(removeBotsBeforeRestart(path, rows, ['cli_first'], {
      stop: vi.fn(), recover,
    })).rejects.toThrow('disk failure');
    expect(recover).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(rows);
  });
});
