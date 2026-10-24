// Markup tag tokenizer and tree compare (PLAN §3.2 "Tags").
// Recognises `<b>`, `<a href="…">`, `<br/>`, `<br>`, `<0>…</0>`, `<link>…</link>`.
// Compare: tag names + nesting + attribute names; `href` / `src` values exact; `<br>` ≡ `<br/>`;
// sibling order is free (translations reorder phrases); text is ignored.

export interface TagAttr {
  readonly name: string;
  readonly value: string | null;
}

export interface TagToken {
  readonly kind: 'open' | 'close' | 'self';
  readonly name: string;
  readonly attrs: readonly TagAttr[];
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

export interface TagElementNode {
  readonly type: 'tag';
  readonly name: string;
  readonly attrs: readonly TagAttr[];
  readonly children: TagTreeNode[];
  readonly start: number;
}

export interface TagTextNode {
  readonly type: 'text';
  readonly text: string;
  readonly start: number;
}

export type TagTreeNode = TagElementNode | TagTextNode;

export interface TagError {
  readonly kind: 'unclosed' | 'stray_close';
  readonly name: string;
  readonly offset: number;
  readonly message: string;
}

export interface TagTree {
  readonly children: TagTreeNode[];
  readonly tokens: readonly TagToken[];
  readonly errors: readonly TagError[];
}

/** HTML void elements: an open tag without `/` is self-closing unless a matching close tag exists. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Attributes whose value must survive translation byte for byte. */
export const EXACT_VALUE_ATTRS: ReadonlySet<string> = new Set(['href', 'src']);

const NAME = '([A-Za-z][A-Za-z0-9:_-]*|\\d+)';
const ATTR = '[A-Za-z_:@][A-Za-z0-9_:.@-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?';
const OPEN_RE = new RegExp(`<${NAME}((?:\\s+${ATTR})*)\\s*(/?)>`, 'uy');
const CLOSE_RE = new RegExp(`</${NAME}\\s*>`, 'uy');
const ATTR_RE = /([A-Za-z_:@][A-Za-z0-9_:.@-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

function normName(name: string): string {
  return /^\d+$/u.test(name) ? name : name.toLowerCase();
}

function parseAttrs(src: string): TagAttr[] {
  const out: TagAttr[] = [];
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(src); m !== null; m = ATTR_RE.exec(src)) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    out.push({ name, value });
  }
  return out;
}

/** Find every tag token in `text`. Anything that does not match a tag shape (`a < b`, `<3`) is text. */
export function scanTags(text: string): TagToken[] {
  const tokens: TagToken[] = [];
  let i = text.indexOf('<');
  while (i !== -1) {
    CLOSE_RE.lastIndex = i;
    const close = CLOSE_RE.exec(text);
    if (close) {
      tokens.push({ kind: 'close', name: normName(close[1] ?? ''), attrs: [], start: i, end: CLOSE_RE.lastIndex, raw: close[0] });
      i = text.indexOf('<', CLOSE_RE.lastIndex);
      continue;
    }
    OPEN_RE.lastIndex = i;
    const open = OPEN_RE.exec(text);
    if (open) {
      tokens.push({
        kind: open[3] === '/' ? 'self' : 'open',
        name: normName(open[1] ?? ''),
        attrs: parseAttrs(open[2] ?? ''),
        start: i,
        end: OPEN_RE.lastIndex,
        raw: open[0],
      });
      i = text.indexOf('<', OPEN_RE.lastIndex);
      continue;
    }
    i = text.indexOf('<', i + 1);
  }
  return tokens;
}

/** Build the tag tree (with text nodes between tags). Errors are collected, never thrown. */
export function buildTagTree(text: string): TagTree {
  const tokens = scanTags(text);
  const closedNames = new Set(tokens.filter((t) => t.kind === 'close').map((t) => t.name));
  const root: TagTreeNode[] = [];
  const stack: TagElementNode[] = [];
  const errors: TagError[] = [];
  const current = (): TagTreeNode[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root);
  let pos = 0;
  const pushText = (end: number): void => {
    if (end > pos) current().push({ type: 'text', text: text.slice(pos, end), start: pos });
  };
  for (const tok of tokens) {
    pushText(tok.start);
    pos = tok.end;
    if (tok.kind === 'self' || (tok.kind === 'open' && VOID_ELEMENTS.has(tok.name) && !closedNames.has(tok.name))) {
      current().push({ type: 'tag', name: tok.name, attrs: tok.attrs, children: [], start: tok.start });
      continue;
    }
    if (tok.kind === 'open') {
      const node: TagElementNode = { type: 'tag', name: tok.name, attrs: tok.attrs, children: [], start: tok.start };
      current().push(node);
      stack.push(node);
      continue;
    }
    // close
    let depth = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.name === tok.name) {
        depth = k;
        break;
      }
    }
    if (depth === -1) {
      errors.push({ kind: 'stray_close', name: tok.name, offset: tok.start, message: `closing </${tok.name}> has no matching opening tag` });
      continue;
    }
    while (stack.length > depth + 1) {
      const unclosed = stack.pop()!;
      errors.push({ kind: 'unclosed', name: unclosed.name, offset: unclosed.start, message: `<${unclosed.name}> is not closed before </${tok.name}>` });
    }
    stack.pop();
  }
  pushText(text.length);
  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    errors.push({ kind: 'unclosed', name: unclosed.name, offset: unclosed.start, message: `<${unclosed.name}> is never closed` });
  }
  return { children: root, tokens, errors };
}

/** Canonical attribute signature: sorted names, with exact values for href/src. */
export function attrSignature(attrs: readonly TagAttr[], valueOf: (raw: string) => string = (v) => v): string {
  const parts = attrs.map((a) =>
    EXACT_VALUE_ATTRS.has(a.name) ? `${a.name}=${JSON.stringify(valueOf(a.value ?? ''))}` : a.name,
  );
  parts.sort();
  return parts.join(' ');
}

/** Canonical, order-insensitive serialisation of the tag structure (text dropped). */
export function canonicalTagForm(nodes: readonly TagTreeNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type !== 'tag') continue;
    parts.push(`<${n.name}${n.attrs.length > 0 ? ` ${attrSignature(n.attrs)}` : ''}>${canonicalTagForm(n.children)}`);
  }
  parts.sort();
  return parts.length === 0 ? '' : `(${parts.join(',')})`;
}

/** Short readable list of tags in document order, for messages and evidence. */
export function tagList(tokens: readonly TagToken[]): string {
  return tokens.map((t) => t.raw).join(' ');
}

export interface TagComparison {
  readonly equal: boolean;
  readonly sourceForm: string;
  readonly targetForm: string;
}

export function compareTagTrees(source: TagTree, target: TagTree): TagComparison {
  const sourceForm = canonicalTagForm(source.children);
  const targetForm = canonicalTagForm(target.children);
  return { equal: sourceForm === targetForm, sourceForm, targetForm };
}
