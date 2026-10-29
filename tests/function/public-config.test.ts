import { describe, expect, it } from 'vitest';
import { configuredSupabaseOrigin } from '../../src/lib/publicConfig.ts';

describe('public Supabase URL boundary', () => {
  it('accepts a single HTTPS origin and local HTTP development origin', () => {
    expect(configuredSupabaseOrigin('https://project.supabase.co/')).toBe('https://project.supabase.co');
    expect(configuredSupabaseOrigin('http://localhost:22010')).toBe('http://localhost:22010');
  });
  it('rejects credentialed, non-origin and CSP-injection configuration', () => {
    // what_bug_this_catches: public URL text must not inject directives or broaden production connect-src.
    for (const value of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?query=yes', 'https://example.com/#fragment', 'https://bad;host.example', 'javascript:alert(1)', 'https://bad\'host.example']) expect(() => configuredSupabaseOrigin(value)).toThrow();
  });
});
