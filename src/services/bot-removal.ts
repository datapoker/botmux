import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertCodexInstanceConfigWrite } from './codex-instance-config-guard.js';
import { assertChangedBotConfigInvariants } from './bot-config-invariants.js';
import { assertQuotaFallbackGraphAcyclic } from './quota-fallback.js';
import { assertNextBotsGenerationContent, writeRawConfigAtomic } from './config-store.js';

/** Keep order and all unrelated fields. A missing id fails the entire request. */
export function planBotRemoval(raw: any[], appIds: readonly string[]): any[] {
  const ids = new Set(appIds);
  if (!ids.size || [...ids].some(id => !/^cli_[a-zA-Z0-9]+$/.test(id))) {
    throw new Error('invalid_bot_app_id');
  }
  for (const id of ids) {
    if (!raw.some(bot => bot?.larkAppId === id)) throw new Error(`bot_not_found: ${id}`);
  }
  const next = raw.filter(bot => !ids.has(bot?.larkAppId));
  // Do not silently break another bot's configured handoff.
  for (const bot of next) {
    if (ids.has(bot?.quotaFallbackBot?.targetAppId)) {
      throw new Error(`bot_in_use: ${bot.larkAppId}`);
    }
  }
  assertCodexInstanceConfigWrite(raw, next);
  assertChangedBotConfigInvariants(raw, next);
  assertQuotaFallbackGraphAcyclic(next);
  assertNextBotsGenerationContent(raw, next);
  return next;
}

/**
 * Caller holds both fleet-mutation and bots.json locks. Stop the whole fleet
 * before compacting the array: daemons and supervisor restart specs use indices.
 * Historical sessions, credentials and the Feishu application are untouched.
 */
export async function removeBotsBeforeRestart(
  path: string,
  raw: any[],
  appIds: readonly string[],
  lifecycle: { stop(): void; recover(): void },
): Promise<string> {
  const next = planBotRemoval(raw, appIds);
  const backup = `${path}.before-delete-${randomUUID()}.bak`;
  await fs.writeFile(backup, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  lifecycle.stop();
  try {
    await writeRawConfigAtomic(path, next);
  } catch (error) {
    // An atomic-write failure leaves the old generation intact; bring it back.
    lifecycle.recover();
    throw error;
  }
  return backup;
}
