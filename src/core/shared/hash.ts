// SHA-256 via Web Crypto (`crypto.subtle`: browser, Node ≥ 18, Deno). Async by necessity.
// Function-copyable: imports nothing (src/core/shared/** may import only within shared/).

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('Web Crypto (crypto.subtle) is not available in this runtime');
  return c.subtle;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Lower-case hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return toHex(await subtle().digest('SHA-256', bytes));
}

/**
 * Hash an ordered list of fields without ambiguity: each field is length-prefixed
 * (`<utf16 length>:<field>`), so ["ab","c"] and ["a","bc"] never collide.
 */
export async function hashFields(fields: readonly string[]): Promise<string> {
  return sha256Hex(fields.map((f) => `${f.length}:${f}`).join('\n'));
}
