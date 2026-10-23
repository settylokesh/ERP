import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { createApp } from './app.js';
import { DurableObjectDriver } from './db-durable.js';
import { initDatabaseWith } from './seed.js';
import { hourlyJobs, startUp } from './startup.js';

/**
 * Cloudflare Workers entry point.
 *
 * The web app is served as static assets. Every `/api` request goes to one Durable Object ("primary"), which owns the
 * SQLite database and runs the same Express application as the Node.js server. A single Durable Object processes
 * requests one at a time against its local database, which gives the same transactional behaviour as the Node.js
 * server with one SQLite file. Its alarm runs the hourly jobs.
 */
interface Env {
  ERP: CfDurableObjectNamespace;
  ASSETS: CfFetcher;
}

const PORT = 8080;
const HOUR = 3600_000;
let listening = false;

export class ErpDatabase extends DurableObject<Env> {
  constructor(ctx: CfDurableObjectState, env: Env) {
    super(ctx, env);
    initDatabaseWith(new DurableObjectDriver(ctx.storage));
    startUp();
    if (!listening) {
      createApp().listen(PORT);
      listening = true;
    }
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  fetch(request: Request): Promise<Response> {
    return handleAsNodeRequest(PORT, request);
  }

  async alarm() {
    hourlyJobs();
    await this.ctx.storage.setAlarm(Date.now() + HOUR);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return env.ERP.getByName('primary').fetch(request);
    return env.ASSETS.fetch(request);
  },
};
