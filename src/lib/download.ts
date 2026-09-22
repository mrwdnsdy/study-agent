/** Browser download helpers. */
import { isArtifactHost } from '../../shared/agent/providers/artifactSample';

interface ArtifactDownloads {
  save(request: { filename: string; data: Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}

const DOWNLOAD_ERRORS: Record<string, string> = {
  rejected_extension: 'This file type cannot be saved from an artifact.',
  extension_not_enabled: 'Saving this file type is not available here.',
  too_large: 'The file is too large to save from here.',
  rate_limited: 'A save is already waiting for your answer. Try again in a moment.',
};

/**
 * Inside the claude.ai artifact viewer the page cannot start a download itself; the
 * `downloads` capability shows the viewer a save prompt instead. Resolves true when the
 * file was handed over (or the viewer declined), false when the capability is unavailable.
 */
async function saveThroughArtifact(blob: Blob, filename: string): Promise<boolean> {
  const w = globalThis as { claude?: { use?(name: string): Promise<unknown> } };
  if (typeof w.claude?.use !== 'function') return false;
  const downloads = (await w.claude.use('downloads').catch(() => null)) as ArtifactDownloads | null;
  if (!downloads || typeof downloads.save !== 'function') return false;
  try {
    await downloads.save({ filename, data: blob });
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'unavailable';
    if (code === 'declined') return true;
    if (code === 'unavailable' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') return false;
    throw new Error(DOWNLOAD_ERRORS[code] ?? `The file could not be saved (${code}).`);
  }
}

/** Trigger a "Save as" download for a Blob: through the artifact runtime when the page is a claude.ai artifact, else via a temporary object URL. */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (isArtifactHost()) {
    if (await saveThroughArtifact(blob, filename)) return;
    throw new Error('Saving files is not available in this view. Open the artifact on claude.ai to export.');
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been processed; revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn an arbitrary title into a safe filename: unsafe characters stripped,
 * whitespace collapsed to `-`, base name limited to 80 characters, then `ext`
 * (with or without a leading dot) appended.
 */
export function safeFilename(name: string, ext: string): string {
  const extension = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  let base = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!base) base = 'document';
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  base = base.slice(0, 80).replace(/[-.]+$/g, '') || 'document';
  return base + extension;
}
