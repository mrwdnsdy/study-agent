import { Children, isValidElement, useMemo, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element as HastElement, Nodes as HastNodes } from 'hast';
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
      pre: ({ children }) => {
        const child = Children.toArray(children).find(isValidElement) as
          | ReactElement<{ className?: string; children?: ReactNode }>
          | undefined;
        const className = child?.props.className ?? '';
        const lang = /language-([\w-]+)/.exec(className)?.[1];
        const code = (child ? childText(child.props.children) : childText(children)).replace(/\n$/, '');
        if (lang === 'mermaid') return <MermaidDiagram code={code} streaming={streaming} />;
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

  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
