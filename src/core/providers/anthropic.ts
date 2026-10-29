import { createFetchTransport } from '../shared/transport.ts';
import type { FetchTransportOptions } from '../shared/transport.ts';
import type { Provider } from './types.ts';
/** Node/eval only. Caller supplies server secret and wraps complete in durable budget accounting. */
export function createAnthropicProvider(options: FetchTransportOptions): Provider {
  const complete = createFetchTransport(options);
  return { complete(request, opts) { if (request.provider !== 'anthropic') return Promise.reject(new Error('invalid_provider')); return complete(request, opts); } };
}
