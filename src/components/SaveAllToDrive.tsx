import { useEffect, useState } from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import type { Session } from '../../shared/types';
import type { Toast } from '../state';
import type { DiagramImage } from '../lib/exportDocx';
import { chatToMarkdown, listDiagrams, quizToMarkdown } from '../lib/exportMarkdown';
import { titleFromMarkdown } from '../lib/format';
import {
  DRIVE_ROOT_FOLDER,
  DriveError,
  connect,
  ensureFolder,
  folderUrl,
  isConnected,
  isDriveAvailable,
  isSignedIn,
  preloadGoogleSignIn,
  saveDocument,
  saveImage,
} from '../lib/googleDrive';
import type { RasterisedSvg } from '../lib/mermaid';
import { DriveFallbackDialog } from './DriveFallbackDialog';
import './export.css';

interface Props {
  session: Session;
  agentName: string;
  onToast: (toast: Toast) => void;
}

interface SaveItem {
  name: string;
  save: () => Promise<unknown>;
}

interface Plan {
  items: SaveItem[];
  /** Diagrams that could not be drawn (invalid mermaid); they are left out. */
  skipped: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function hasChat(session: Session): boolean {
  return session.messages.some((message) => message.content.trim());
}

/**
 * Everything the session holds, in the order it is saved: the guide, each quiz review, each quiz,
 * the chat (all as Google Docs), then each guide diagram as a PNG. Diagrams are drawn here, before
 * the first upload, so the count in "Saving 3 of 9…" is exact.
 */
async function planSave(session: Session, agentName: string, folder: string[], onProgress: (message: string) => void): Promise<Plan> {
  const { mermaidToPng } = await import('../lib/mermaid');
  // Each diagram is drawn once, for its PNG and again (from this cache) inside the guide's document.
  const drawn = new Map<string, Promise<RasterisedSvg | null>>();
  const draw = (code: string): Promise<RasterisedSvg | null> => {
    let png = drawn.get(code);
    if (!png) {
      png = mermaidToPng(code).catch(() => null);
      drawn.set(code, png);
    }
    return png;
  };
  const renderDiagram = async (code: string): Promise<DiagramImage | null> => {
    const png = await draw(code);
    return png ? { data: await png.blob.arrayBuffer(), width: png.width, height: png.height } : null;
  };

  const items: SaveItem[] = [];
  const addDocument = (title: string, markdown: string, subtitle?: string) =>
    items.push({ name: title, save: () => saveDocument(markdown, { title, subtitle, folder, renderDiagram }) });

  const guide = session.guide?.markdown.trim() ? session.guide.markdown : '';
  if (guide) addDocument(titleFromMarkdown(guide, session.title), guide, `Study guide · ${session.title}`);
  for (const quiz of session.quizzes) {
    if (quiz.review?.trim()) addDocument(`Review — ${quiz.title}`, quiz.review, session.title);
  }
  for (const quiz of session.quizzes) addDocument(`Quiz — ${quiz.title}`, quizToMarkdown(quiz, agentName), session.title);
  if (hasChat(session)) addDocument(`${session.title} — chat with ${agentName}`, chatToMarkdown(session.messages, agentName, session.title));

  const diagrams = guide ? listDiagrams(guide) : [];
  let skipped = 0;
  for (const [index, diagram] of diagrams.entries()) {
    onProgress(`Drawing diagram ${index + 1} of ${diagrams.length}…`);
    // One at a time: mermaid renders through a shared scratch element.
    const png = await draw(diagram.code);
    if (png) items.push({ name: diagram.name, save: () => saveImage(png.blob, diagram.name, folder) });
    else skipped += 1;
  }
  return { items, skipped };
}

function summary(total: number, failed: { name: string; error: unknown }[], skipped: number, folderId: string): Toast {
  const link = { href: folderUrl(folderId), label: 'Open folder' };
  const skippedNote = skipped ? ` ${plural(skipped, 'diagram')} couldn’t be drawn, so ${skipped === 1 ? 'it was' : 'they were'} left out.` : '';
  if (failed.length === 0) return { kind: 'success', message: `Saved ${plural(total, 'item')} to your Google Drive.${skippedNote}`, link };
  const reason = sentence((failed[0].error as Error)?.message || 'Something went wrong.');
  const saved = total - failed.length;
  if (saved === 0) return { kind: 'error', message: `Nothing was saved to your Google Drive. ${reason}` };
  const names = failed.slice(0, 3).map((item) => item.name).join(', ') + (failed.length > 3 ? ` and ${failed.length - 3} more` : '');
  return { kind: 'info', message: `${saved} of ${total} saved to your Google Drive. Not saved: ${names}. ${reason}${skippedNote}`, link };
}

/**
 * "Save all to Drive": the guide, every quiz review, every quiz, the chat and each guide diagram go
 * into "Kiiku Study Buddy / <session title>" in the visitor's own Google Drive.
 */
export function SaveAllToDrive({ session, agentName, onToast }: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const guide = session.guide?.markdown.trim() ? session.guide.markdown : '';
  const nothingToSave = !guide && session.quizzes.length === 0 && !hasChat(session);

  useEffect(() => {
    // A visitor who connected before will likely save again: have Google's script ready for the click.
    if (isConnected()) preloadGoogleSignIn();
  }, []);

  const saveEverything = async (access: Promise<string>) => {
    const folder = [DRIVE_ROOT_FOLDER, session.title];
    try {
      await access;
      setProgress('Finding your Drive folder…');
      const folderId = await ensureFolder(folder);
      const { items, skipped } = await planSave(session, agentName, folder, setProgress);
      if (items.length === 0) {
        onToast({ kind: 'info', message: 'Nothing to save yet.' });
        return;
      }
      const failed: { name: string; error: unknown }[] = [];
      for (const [index, item] of items.entries()) {
        setProgress(`Saving ${index + 1} of ${items.length}…`);
        try {
          await item.save();
        } catch (error) {
          failed.push({ name: item.name, error });
          // Without a token every later item would fail the same way (or pop up again): stop here.
          if (!isSignedIn()) {
            for (const rest of items.slice(index + 1)) failed.push({ name: rest.name, error });
            break;
          }
        }
      }
      onToast(summary(items.length, failed, skipped, folderId));
    } catch (error) {
      if (error instanceof DriveError) onToast({ kind: error.cancelled ? 'info' : 'error', message: error.message });
      else onToast({ kind: 'error', message: `Save all to Drive failed: ${(error as Error).message}` });
    }
  };

  const saveAll = () => {
    if (progress !== null) return;
    if (!isDriveAvailable()) {
      setFallbackOpen(true);
      return;
    }
    const signedIn = isSignedIn();
    // First thing, synchronously inside the click: browsers only let the Google sign-in popup open from a click.
    const access = connect();
    setProgress(signedIn ? 'Preparing…' : 'Waiting for Google sign-in…');
    void saveEverything(access).finally(() => setProgress(null));
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={saveAll}
        onPointerEnter={preloadGoogleSignIn}
        onFocus={preloadGoogleSignIn}
        disabled={progress !== null || nothingToSave}
        title={nothingToSave ? 'Nothing to save yet' : `Save the guide, reviews, quizzes, chat and diagrams to ${DRIVE_ROOT_FOLDER} / ${session.title} in your Google Drive`}
        data-testid="save-all-drive"
      >
        {progress ? (
          <>
            <Loader2 size={16} className="spin" /> <span className="save-all__progress">{progress}</span>
          </>
        ) : (
          <>
            <CloudUpload size={16} /> Save all to Drive
          </>
        )}
      </button>
      {fallbackOpen && (
        <DriveFallbackDialog
          markdown={guide || undefined}
          title={guide ? titleFromMarkdown(guide, session.title) : session.title}
          subtitle={`Study guide · ${session.title}`}
          note={
            guide
              ? 'Saving everything at once needs Google sign-in, which isn’t available here. You can still add the study guide to your Drive in two steps.'
              : 'Saving everything at once needs Google sign-in, which isn’t available here. Export each item from its menu, then upload it to your Drive.'
          }
          onClose={() => setFallbackOpen(false)}
          onToast={onToast}
        />
      )}
    </>
  );
}
