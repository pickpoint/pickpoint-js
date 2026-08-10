export type HttpTransport = {
  fetch: typeof globalThis.fetch;
  close: () => void;
};

type UndiciModule = {
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

/**
 * Browser / override: native fetch.
 * Node: dedicated undici Agent (keep-alive) sized to connections.
 *
 * Uses `process.getBuiltinModule('module')` instead of a static
 * `import … from 'node:module'` so browser bundlers (Angular/esbuild)
 * do not try to resolve Node builtins.
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
    const builtin = (
      process as NodeJS.Process & {
        getBuiltinModule?: (id: string) => {
          createRequire: (filename: string | URL) => NodeRequire;
        };
      }
    ).getBuiltinModule?.('module');
    if (!builtin?.createRequire) {
      throw new Error('createRequire unavailable');
    }

    const require = builtin.createRequire(import.meta.url);
    const undici = require('undici') as UndiciModule;

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
