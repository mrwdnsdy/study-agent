import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudUpload, Download, Loader2, Maximize2, X } from 'lucide-react';
import { diagramDisplayWidth, mermaidToPng, renderMermaidSvg } from '../lib/mermaid';
import { DiagramActionsContext } from './diagramActions';
import './diagrams.css';

const svgCache = new Map<string, string>();
const CACHE_LIMIT = 300;

function remember(code: string, svg: string): void {
  if (svgCache.size >= CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(code, svg);
}

/** The diagram's natural size in CSS pixels: its viewBox, which mermaid sets to the drawing's extent. */
function naturalSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  const rect = svg.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
}

/** Mermaid scopes its styles and arrowhead markers by the SVG's id, so a second copy on the page needs ids of its own. */
function withFreshIds(svg: string, suffix: string): string {
  const id = /<svg[^>]*?\sid="([^"]+)"/.exec(svg)?.[1];
  return id ? svg.split(id).join(`${id}${suffix}`) : svg;
}

function messageOf(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message || fallback;
}

const LIGHTBOX_MARGIN = 16;
const CARD_PADDING = { top: 48, side: 20, bottom: 20 };
/** Enough to read a small diagram from across the desk without blowing it up absurdly. */
const MAX_ZOOM = 3;

interface LightboxProps {
  svg: string;
  name: string;
  onClose: () => void;
}

/** Full-screen view of one diagram, fitted to the viewport on a white card. */
function DiagramLightbox({ svg, name, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const markup = useMemo(() => withFreshIds(svg, '-zoom'), [svg]);

  useEffect(() => {
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        // The close button is the only control, so focus stays on it rather than leaving the dialog.
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = stageRef.current?.querySelector('svg');
    const size = el ? naturalSize(el) : null;
    if (!el || !size) return;
    const fit = () => {
      const width = window.innerWidth - 2 * LIGHTBOX_MARGIN - 2 * CARD_PADDING.side;
      const height = window.innerHeight - 2 * LIGHTBOX_MARGIN - CARD_PADDING.top - CARD_PADDING.bottom;
      const scale = Math.max(0.1, Math.min(width / size.width, height / size.height, MAX_ZOOM));
      el.removeAttribute('width');
      el.style.maxWidth = 'none';
      el.style.width = `${Math.floor(size.width * scale)}px`;
      el.style.height = `${Math.floor(size.height * scale)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [markup]);

  return createPortal(
    <div
      className="diagram-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={name === 'diagram' ? 'Diagram' : `Diagram: ${name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="diagram-lightbox__card">
        <button ref={closeRef} type="button" className="diagram-lightbox__close" onClick={onClose} aria-label="Close">
          <X size={18} aria-hidden="true" />
        </button>
        <div ref={stageRef} className="diagram-lightbox__stage" dangerouslySetInnerHTML={{ __html: markup }} />
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  code: string;
  /** While the document is still streaming, failed renders show a quiet placeholder instead of an error. */
  streaming?: boolean;
  /** Readable name used for the PNG filename and the full-screen view, e.g. the nearest heading. */
  name?: string;
}

export function MermaidDiagram({ code, streaming = false, name = 'diagram' }: Props) {
  const { saveImage, prepareSave } = useContext(DiagramActionsContext);
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(code) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'download' | 'save' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);

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
        // Renders the diagram as written, else its repaired version; throws the parser's reason.
        const rendered = await renderMermaidSvg(code);
        if (cancelled) return;
        remember(code, rendered);
        setSvg(rendered);
      } catch (err) {
        // Parse errors arrive summarised; a render failure can be long, so keep its first line only.
        if (!cancelled) setError(messageOf(err, 'unknown error').split('\n')[0].slice(0, 200));
      }
    }, streaming ? 700 : 30);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, streaming]);

  // Natural size rather than squeezed to the column: see diagramDisplayWidth.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = host?.querySelector('svg');
    const size = el ? naturalSize(el) : null;
    if (!host || !el || !size) return;
    el.removeAttribute('width');
    el.style.maxWidth = 'none';
    let column = -1;
    const fit = () => {
      // Only the column width matters; the height changes this causes are ignored.
      if (host.clientWidth === column) return;
      column = host.clientWidth;
      const width = diagramDisplayWidth(size.width, column);
      el.style.width = `${Math.round(width)}px`;
      el.style.height = `${Math.round((width * size.height) / size.width)}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    // Resizing inside the observer callback would resize the observed element within the same
    // frame, which the browser reports as a ResizeObserver loop error, so it waits a frame.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [svg]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const closeLightbox = useCallback(() => {
    setExpanded(false);
    expandRef.current?.focus();
  }, []);

  const renderPng = async (): Promise<Blob> => {
    const png = await mermaidToPng(code, 2);
    if (!png) throw new Error("This diagram couldn't be turned into an image.");
    return png.blob;
  };

  const download = async () => {
    setBusy('download');
    setNotice(null);
    try {
      // Loaded on demand, as ExportMenu does, so it stays out of the main bundle.
      const { downloadBlob, safeFilename } = await import('../lib/download');
      await downloadBlob(await renderPng(), safeFilename(name, '.png'));
    } catch (err) {
      setNotice(messageOf(err, 'The download failed. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!saveImage) return;
    setBusy('save');
    setNotice(null);
    try {
      // The image is not awaited first: the saver may need to open a sign-in popup inside this click.
      await saveImage(renderPng(), name);
    } catch (err) {
      setNotice(messageOf(err, 'Saving to Drive failed. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (svg) {
    return (
      <figure className="diagram">
        <div ref={hostRef} className="diagram__svg" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="diagram__toolbar" role="group" aria-label="Diagram actions">
          <button ref={expandRef} type="button" className="diagram__tool" onClick={() => setExpanded(true)} title="Expand" aria-label="Expand diagram">
            <Maximize2 size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diagram__tool"
            onClick={download}
            disabled={busy !== null}
            aria-busy={busy === 'download'}
            title="Download PNG"
            aria-label="Download diagram as PNG"
          >
            {busy === 'download' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
          </button>
          {saveImage && (
            <button
              type="button"
              className="diagram__tool"
              onClick={save}
              onPointerEnter={prepareSave}
              onFocus={prepareSave}
              disabled={busy !== null}
              aria-busy={busy === 'save'}
              title="Save to Drive"
              aria-label="Save diagram to Drive"
            >
              {busy === 'save' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
            </button>
          )}
        </div>
        {notice && (
          <p className="diagram__notice" role="status">
            {notice}
          </p>
        )}
        {expanded && <DiagramLightbox svg={svg} name={name} onClose={closeLightbox} />}
      </figure>
    );
  }
  if (error && !streaming) {
    return (
      <figure className="diagram diagram--error">
        <div className="diagram__note">
          This diagram couldn't be drawn: {error.replace(/[\s.:;,]+$/, '')}.{' '}
          <button type="button" className="link" onClick={() => setShowSource((v) => !v)} aria-expanded={showSource}>
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
