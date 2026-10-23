// Minimal declarations for the Cloudflare Workers runtime modules used by worker.ts (provided by the runtime).
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: CfDurableObjectState;
    protected env: Env;
    constructor(ctx: CfDurableObjectState, env: Env);
  }
}
declare module 'cloudflare:node' {
  /** Dispatches a request to the node:http server listening on the given port and resolves with its response. */
  export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}

interface CfDurableObjectState {
  storage: import('./db-durable.js').DurableSqlStorage & {
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface CfDurableObjectNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}
interface CfFetcher {
  fetch(request: Request): Promise<Response>;
}
