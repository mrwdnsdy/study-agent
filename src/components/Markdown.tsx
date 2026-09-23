import { Children, isValidElement, memo, useMemo, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element as HastElement, Nodes as HastNodes, Root as HastRoot } from 'hast';
import { classifyCallout } from '../lib/markdownAst';
import { slugify } from '../lib/toc';
import { MermaidDiagram } from './MermaidDiagram';

function hastText(node: HastNodes | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if ('children' in node) return node.children.map((child) => hastText(child as HastNodes)).join('');
  return '';
}

function childText(children: ReactNode): string {
  if (Array.isArray(children)) return children.map(childText).join('');
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  return '';
}

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4';
type HeadingProps = ComponentProps<HeadingTag> & { node?: HastElement };

function heading(Tag: HeadingTag) {
  return function Heading({ node, children, ...rest }: HeadingProps) {
    const id = slugify(hastText(node));
    return (
      <Tag id={id || undefined} {...rest}>
        {children}
      </Tag>
    );
  };
}

/** A <pre> holding a mermaid code block (the language matched in any case, like the exporters). */
function isMermaidBlock(node: HastElement): boolean {
  if (node.tagName !== 'pre') return false;
  const code = node.children.find((child): child is HastElement => child.type === 'element' && child.tagName === 'code');
  const classes = code?.properties?.className;
  return Array.isArray(classes) && classes.some((name) => String(name).toLowerCase() === 'language-mermaid');
}

/** A paragraph whose only content is one italic run, such as `_What to notice._` (or `*What to notice*.`). */
function isItalicOnly(node: HastElement): boolean {
  if (node.tagName !== 'p') return false;
  const content = node.children.filter((child) => !(child.type === 'text' && !child.value.trim()));
  const [first, rest] = content;
  const punctuationOnly = !rest || (content.length === 2 && rest.type === 'text' && /^[.!?:;,…]+\s*$/.test(rest.value));
  return first?.type === 'element' && first.tagName === 'em' && punctuationOnly;
}

/**
 * Tags diagrams before they render: each mermaid block is named after the
 * heading above it (the name of its PNG download), and the italic caption
 * paragraph right after a diagram gets the diagram-caption class.
 */
function rehypeDiagrams() {
  return (tree: HastRoot) => {
    let headingText = '';
    const seen = new Map<string, number>();
    const visit = (parent: HastRoot | HastElement): void => {
      let previous: HastElement | null = null;
      for (const child of parent.children) {
        if (child.type !== 'element') {
          if (!(child.type === 'text' && !child.value.trim())) previous = null;
          continue;
        }
        if (/^h[1-6]$/.test(child.tagName)) headingText = hastText(child).trim();
        if (isMermaidBlock(child)) {
          const base = headingText || 'diagram';
          const count = (seen.get(base) ?? 0) + 1;
          seen.set(base, count);
          child.properties = { ...child.properties, dataDiagramName: count > 1 ? `${base} (${count})` : base };
        } else if (previous && isMermaidBlock(previous) && isItalicOnly(child)) {
          const classes = child.properties?.className;
          child.properties = { ...child.properties, className: [...(Array.isArray(classes) ? classes : []), 'diagram-caption'] };
        }
        visit(child);
        previous = child;
      }
    };
    visit(tree);
  };
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeDiagrams];

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^#{1,6}\s/;

/** Splits markdown before each heading that is outside a code fence; the parts join back into the input. */
function splitAtHeadings(markdown: string): string[] {
  const parts: string[] = [];
  let fence = '';
  let start = 0;
  let offset = 0;
  for (const line of markdown.split('\n')) {
    const match = FENCE.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
    } else if (match) {
      fence = match[1];
    } else if (offset > start && HEADING.test(line)) {
      parts.push(markdown.slice(start, offset));
      start = offset;
    }
    offset += line.length + 1;
  }
  parts.push(markdown.slice(start));
  return parts;
}

interface SectionProps {
  markdown: string;
  components: Components;
}

/**
 * One heading's worth of a streaming document. Memoised, so each flush only
 * parses the last, still-growing section instead of the whole draft.
 */
const MarkdownSection = memo(function MarkdownSection({ markdown, components }: SectionProps) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
      {markdown}
    </ReactMarkdown>
  );
});

interface Props {
  markdown: string;
  /** True while the text is still being streamed in. */
  streaming?: boolean;
  className?: string;
}

export function Markdown({ markdown, streaming = false, className }: Props) {
  const components = useMemo<Components>(
    () => ({
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      pre: ({ node, children }) => {
        const child = Children.toArray(children).find(isValidElement) as
          | ReactElement<{ className?: string; children?: ReactNode }>
          | undefined;
        const className = child?.props.className ?? '';
        const lang = /language-([\w-]+)/.exec(className)?.[1];
        const code = (child ? childText(child.props.children) : childText(children)).replace(/\n$/, '');
        if (lang?.toLowerCase() === 'mermaid') {
          const name = node?.properties?.dataDiagramName;
          return <MermaidDiagram code={code} streaming={streaming} name={typeof name === 'string' && name ? name : undefined} />;
        }
        return (
          <pre className="code">
            {lang && <span className="code__lang">{lang}</span>}
            <code>{code}</code>
          </pre>
        );
      },
      blockquote: ({ node, children }) => {
        const first = node?.children.find((c) => c.type === 'element') as HastElement | undefined;
        const callout = classifyCallout(hastText(first));
        if (!callout) return <blockquote>{children}</blockquote>;
        return <blockquote className={`callout callout--${callout.kind}`}>{children}</blockquote>;
      },
      table: ({ children }) => (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      ),
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ),
      img: ({ alt }) => <span className="md-image">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
    }),
    [streaming],
  );
  const sections = useMemo(() => (streaming ? splitAtHeadings(markdown) : null), [markdown, streaming]);

  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      {sections ? (
        sections.map((section, index) => <MarkdownSection key={index} markdown={section} components={components} />)
      ) : (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
          {markdown}
        </ReactMarkdown>
      )}
    </div>
  );
}
