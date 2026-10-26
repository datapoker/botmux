import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRawConfig } from '../services/config-store.js';
import { planBotRemoval } from '../services/bot-removal.js';
import { jsonRes } from './http.js';
import { standingLinkSameOrigin } from './standing-link.js';

export interface BotRemovalApiDeps {
  canManageHost: boolean;
  configPath(): string;
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  launch(appId: string): void;
}

/** Host management only. The detached restart driver revalidates under locks. */
export async function handleBotRemovalApi(
  req: IncomingMessage, res: ServerResponse, url: URL, deps: BotRemovalApiDeps,
): Promise<boolean> {
  const match = /^\/api\/bots\/(cli_[a-zA-Z0-9]+)\/delete$/.exec(url.pathname);
  if (req.method !== 'POST' || !match) return false;
  if (!deps.canManageHost || !standingLinkSameOrigin(req.headers)) {
    jsonRes(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }
  const appId = match[1];
  try {
    const body = await deps.readJsonBody(req) as { confirmAppId?: unknown } | null;
    if (body?.confirmAppId !== appId) {
      jsonRes(res, 400, { ok: false, error: 'confirmation_required' });
      return true;
    }
    planBotRemoval(await readRawConfig(deps.configPath()), [appId]);
    // Launch before acknowledging so spawn failures are not reported as success.
    // The driver must acquire locks and preflight before it can stop Dashboard.
    deps.launch(appId);
    jsonRes(res, 202, { ok: true, pending: true, restartRequired: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonRes(res, message.startsWith('bot_not_found:') ? 404 : 409, { ok: false, error: message });
  }
  return true;
}
