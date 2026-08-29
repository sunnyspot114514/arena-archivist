interface HtmlElementNode {
  readonly tagName: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: HtmlChild[];
  readonly parent: HtmlElementNode | null;
}

type HtmlChild = HtmlElementNode | string;

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (entity, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const codePoint = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (body.startsWith('#')) {
        const codePoint = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return ENTITY_MAP[body.toLowerCase()] ?? entity;
    },
  );
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(source)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes.set(
      name,
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''),
    );
  }
  return attributes;
}

function createRoot(): HtmlElementNode {
  return {
    tagName: '#document',
    attributes: new Map(),
    children: [],
    parent: null,
  };
}

function appendChild(parent: HtmlElementNode, child: HtmlChild): void {
  (parent.children as HtmlChild[]).push(child);
}

function parseHtml(html: string): HtmlElementNode {
  const root = createRoot();
  const stack: HtmlElementNode[] = [root];
  const tokenPattern =
    /<!--[\s\S]*?-->|<![^>]*>|<\/[a-zA-Z][^>]*>|<[a-zA-Z][^>]*>|[^<]+/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(html)) !== null) {
    const token = match[0];
    const parent = stack.at(-1) ?? root;
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;

    if (token.startsWith('</')) {
      const closingName = /^<\/\s*([^\s>]+)/.exec(token)?.[1]?.toLowerCase();
      if (!closingName) continue;
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]?.tagName === closingName) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    if (token.startsWith('<')) {
      const opening = /^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/.exec(token);
      if (!opening?.[1]) continue;
      const tagName = opening[1].toLowerCase();
      const node: HtmlElementNode = {
        tagName,
        attributes: parseAttributes(opening[2] ?? ''),
        children: [],
        parent,
      };
      appendChild(parent, node);
      if (!token.endsWith('/>') && !VOID_ELEMENTS.has(tagName))
        stack.push(node);
      continue;
    }

    appendChild(parent, decodeEntities(token));
  }

  return root;
}

interface AttributeSelector {
  readonly name: string;
  readonly operator: 'exists' | 'equals' | 'contains';
  readonly value: string;
  readonly insensitive: boolean;
}

interface SimpleSelector {
  readonly tagName: string | null;
  readonly attributes: readonly AttributeSelector[];
}

function parseAttributeSelector(source: string): AttributeSelector | null {
  const match =
    /^\s*([\w:-]+)\s*(?:(\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+?))\s*)?(i)?\s*$/i.exec(
      source,
    );
  if (!match?.[1]) return null;
  const value = match[3] ?? match[4] ?? match[5] ?? '';
  return {
    name: match[1].toLowerCase(),
    operator:
      match[2] === '=' ? 'equals' : match[2] === '*=' ? 'contains' : 'exists',
    value,
    insensitive: match[6]?.toLowerCase() === 'i',
  };
}

function parseSimpleSelector(selector: string): SimpleSelector | null {
  const match = /^([a-z][\w-]*)?((?:\[[^\]]+\])*)$/i.exec(selector.trim());
  if (!match) return null;
  const attributes: AttributeSelector[] = [];
  const bracketPattern = /\[([^\]]+)\]/g;
  let bracket: RegExpExecArray | null;
  while ((bracket = bracketPattern.exec(match[2] ?? '')) !== null) {
    const parsed = parseAttributeSelector(bracket[1] ?? '');
    if (!parsed) return null;
    attributes.push(parsed);
  }
  if (!match[1] && attributes.length === 0) return null;
  return { tagName: match[1]?.toLowerCase() ?? null, attributes };
}

function matchesSimpleSelector(
  node: HtmlElementNode,
  selector: SimpleSelector,
): boolean {
  if (selector.tagName && node.tagName !== selector.tagName) return false;
  return selector.attributes.every((attribute) => {
    const actual = node.attributes.get(attribute.name);
    if (attribute.operator === 'exists') return actual !== undefined;
    if (actual === undefined) return false;
    const left = attribute.insensitive ? actual.toLowerCase() : actual;
    const right = attribute.insensitive
      ? attribute.value.toLowerCase()
      : attribute.value;
    return attribute.operator === 'equals'
      ? left === right
      : left.includes(right);
  });
}

function descendants(node: HtmlElementNode): HtmlElementNode[] {
  const result: HtmlElementNode[] = [];
  const visit = (current: HtmlElementNode): void => {
    for (const child of current.children) {
      if (typeof child === 'string') continue;
      result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function collectText(node: HtmlElementNode): string {
  if (
    node.tagName === 'script' ||
    node.tagName === 'style' ||
    node.tagName === 'template'
  )
    return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SnapshotElement {
  readonly text: string;
  attribute(name: string): string | null;
  queryAll(selector: string): readonly SnapshotElement[];
  queryFirst(selector: string): SnapshotElement | null;
}

class SnapshotElementImpl implements SnapshotElement {
  constructor(private readonly node: HtmlElementNode) {}

  get text(): string {
    return collectText(this.node);
  }

  attribute(name: string): string | null {
    return this.node.attributes.get(name.toLowerCase()) ?? null;
  }

  queryAll(selector: string): readonly SnapshotElement[] {
    if (selector.trim() === ':scope') return [this];
    const parsed = parseSimpleSelector(selector);
    if (!parsed) return [];
    return descendants(this.node)
      .filter((candidate) => matchesSimpleSelector(candidate, parsed))
      .map((candidate) => new SnapshotElementImpl(candidate));
  }

  queryFirst(selector: string): SnapshotElement | null {
    return this.queryAll(selector)[0] ?? null;
  }
}

export type SnapshotDocument = SnapshotElement;

export function createSnapshotDocument(html: string): SnapshotDocument {
  return new SnapshotElementImpl(parseHtml(html));
}
