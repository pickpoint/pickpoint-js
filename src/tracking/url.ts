import { isDeviceAuth, type Auth } from './types';

export const DEFAULT_TRACKING_PATH = '/v2/ws';
export const TRACKING_SUBPROTOCOL = 'tracking.v2';

/** Normalize endpoint to `ws:`/`wss:` and append path + auth query. */
export function buildWsUrl(
  endpoint: string,
  auth: Auth,
  path: string = DEFAULT_TRACKING_PATH,
): string {
  let base = endpoint.trim().replace(/\/+$/, '');
  if (base.startsWith('https://')) {
    base = `wss://${base.slice('https://'.length)}`;
  } else if (base.startsWith('http://')) {
    base = `ws://${base.slice('http://'.length)}`;
  } else if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
    throw new Error(`invalid tracking endpoint: ${endpoint}`);
  }

  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${base}/`);
  if (isDeviceAuth(auth)) {
    url.searchParams.set('client-id', auth.clientId);
    url.searchParams.set('client-secret', auth.clientSecret);
  } else {
    url.searchParams.set('access-token', auth.accessToken);
  }
  return url.toString();
}
