// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTypingTarget, showBidi, textDiff } from './helpers.ts';

describe('review workspace display helpers', () => {
  it('does not let review shortcuts consume text-entry keystrokes', () => {
    // what_bug_this_catches: typing a, r, s, j or k must not record decisions or navigate the queue.
    for (const tag of ['input', 'textarea', 'select']) expect(isTypingTarget(document.createElement(tag))).toBe(true);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editor.append(child);
    expect(isTypingTarget(child)).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('shows control names without changing the original text used for export', () => {
    // what_bug_this_catches: a display glyph must never be written back into the target string.
    const original = 'قبل\u202eafter\u2069';
    expect(showBidi(original, false)).toBe(original);
    expect(showBidi(original, true)).toBe('قبل⟨RLO⟩after⟨PDI⟩');
    expect(original).toBe('قبل\u202eafter\u2069');
  });

  it('keeps emoji intact in contiguous fix diffs', () => {
    // what_bug_this_catches: UTF-16 prefix trimming could split a surrogate pair between diff nodes.
    expect(textDiff('A😀Z', 'A😃Z')).toEqual({ prefix: 'A', removed: '😀', added: '😃', suffix: 'Z' });
    expect(textDiff('same', 'same')).toEqual({ prefix: 'same', removed: '', added: '', suffix: '' });
    expect(textDiff('', 'new')).toEqual({ prefix: '', removed: '', added: 'new', suffix: '' });
  });
});
