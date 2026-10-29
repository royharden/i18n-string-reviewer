import { createFetchTransport } from '../shared/transport.ts';
import type { FetchTransportOptions } from '../shared/transport.ts';
import type { Provider } from './types.ts';
/** Named Noul answers only; no confidence invention or browser-side secret discovery. */
export function createTypeSafeProvider(options: FetchTransportOptions): Provider {
  const complete = createFetchTransport(options);
  return { complete(request, opts) { if (request.provider !== 'typesafe') return Promise.reject(new Error('invalid_provider')); return complete(request, opts); } };
}
