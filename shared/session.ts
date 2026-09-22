/**
 * Session helpers shared by the server store and browser mode.
 * Keep this file free of runtime dependencies.
 */
import type { Session, SessionSummary } from './types.js';

export const DEFAULT_SESSION_TITLE = 'New study session';

export function blankSession(id: string, title?: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    title: title?.trim() || DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    materials: [],
    guide: null,
    messages: [],
    quizzes: [],
  };
}

export function summarizeSession(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    materialCount: session.materials.length,
    hasGuide: Boolean(session.guide),
    quizCount: session.quizzes.length,
  };
}

/** "week-3_slides.pptx" → "Week 3 slides". */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return DEFAULT_SESSION_TITLE;
  const title = base.charAt(0).toUpperCase() + base.slice(1);
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}
