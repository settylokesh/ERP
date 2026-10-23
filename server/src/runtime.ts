/** True when running on Cloudflare Workers (inside the Durable Object), false on Node.js. */
export const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

/** Human-readable runtime, shown in Settings → System. */
export const runtimeName = () => (onWorkers ? 'Cloudflare Workers' : `Node.js ${process.version}`);
