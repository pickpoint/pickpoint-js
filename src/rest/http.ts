import { createRequire } from 'node:module';

export type HttpTransport = {
  fetch: typeof globalThis.fetch;
  close: () => void;
};

/**
 * Browser / override: native fetch.
 * Node: dedicated undici Agent (keep-alive) sized to connections.
 */
export function createTransport(
  connections: number,
  fetchOverride?: typeof globalThis.fetch,
): HttpTransport {
  if (fetchOverride) {
    return { fetch: fetchOverride, close: () => {} };
  }

  const isNode =
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    !!process.versions.node;

  if (!isNode) {
    return { fetch: globalThis.fetch.bind(globalThis), close: () => {} };
  }

  try {
    const require = createRequire(import.meta.url);
    const undici = require('undici') as {
      Agent: new (opts: {
        connections: number;
        keepAliveTimeout: number;
        keepAliveMaxTimeout: number;
        pipelining: number;
      }) => { close: () => void; destroy: () => void };
      fetch: (
        input: RequestInfo | URL,
        init?: RequestInit & { dispatcher?: unknown },
      ) => Promise<Response>;
    };

    const agent = new undici.Agent({
      connections: Math.max(1, connections),
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      pipelining: 1,
    });

    const boundFetch: typeof globalThis.fetch = (input, init) =>
      undici.fetch(input as RequestInfo, {
        ...(init as RequestInit),
        dispatcher: agent,
      });

    return {
      fetch: boundFetch,
      close: () => {
        try {
          agent.close();
          agent.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return { fetch: globalThis.fetch.bind(globalThis), close: () => {} };
  }
}
