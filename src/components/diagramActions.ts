/**
 * Optional actions a diagram card can offer beyond its own Expand and
 * Download PNG buttons. The app provides them once, at the top of the tree,
 * so the Markdown renderer does not have to thread them through.
 */
import { createContext } from 'react';

export interface DiagramActions {
  /**
   * Saves a rendered diagram image, e.g. to the student's Google Drive. When
   * present, each diagram card shows a "Save to Drive" button. `name` is a
   * readable diagram name (usually the nearest heading), not a filename.
   */
  saveImage?: (png: Blob, name: string) => Promise<void>;
}

export const DiagramActionsContext = createContext<DiagramActions>({});
