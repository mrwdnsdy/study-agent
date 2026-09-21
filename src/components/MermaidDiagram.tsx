import { useEffect, useState } from 'react';
import { isValidMermaid, renderMermaidSvg } from '../lib/mermaid';

const svgCache = new Map<string, string>();
const CACHE_LIMIT = 300;

function remember(code: string, svg: string): void {
  if (svgCache.size >= CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(code, svg);
}

interface Props {
  code: string;
  /** While the document is still streaming, failed renders show a quiet placeholder instead of an error. */
  streaming?: boolean;
}

export function MermaidDiagram({ code, streaming = false }: Props) {
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(code) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    const cached = svgCache.get(code);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }
    let cancelled = false;
    setSvg(null);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        if (!(await isValidMermaid(code))) throw new Error('the diagram syntax is invalid');
        const rendered = await renderMermaidSvg(code);
        if (cancelled) return;
        remember(code, rendered);
        setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError(((err as Error).message || 'unknown error').slice(0, 160));
      }
    }, streaming ? 700 : 30);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, streaming]);

  if (svg) {
    return (
      <figure className="diagram">
        <div className="diagram__svg" dangerouslySetInnerHTML={{ __html: svg }} />
      </figure>
    );
  }
  if (error && !streaming) {
    return (
      <figure className="diagram diagram--error">
        <div className="diagram__note">
          This diagram could not be rendered ({error}).{' '}
          <button type="button" className="link" onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'Hide' : 'Show'} source
          </button>
        </div>
        {showSource && (
          <pre className="code">
            <code>{code}</code>
          </pre>
        )}
      </figure>
    );
  }
  return (
    <figure className="diagram diagram--pending">
      <div className="diagram__note">Drawing diagram…</div>
    </figure>
  );
}
