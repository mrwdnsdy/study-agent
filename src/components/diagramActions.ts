/**
 * Optional actions a diagram card can offer beyond its own Expand and
 * Download PNG buttons. The app provides them once, at the top of the tree,
 * so the Markdown renderer does not have to thread them through.
 */
import { createContext } from 'react';

export interface DiagramActions {
  /**
   * Saves a diagram image, e.g. to the student's Google Drive. When present,
   * each diagram card shows a "Save to Drive" button. It is called straight
   * from the click with the PNG still rendering, so a sign-in popup can open
   * inside the click. `name` is a readable diagram name (usually the nearest
   * heading), not a filename. The provider reports success itself; a
   * rejection is shown on the card.
   */
  saveImage?: (png: Promise<Blob>, name: string) => Promise<void>;
  /** Called when the pointer or focus reaches the save button, to load what saving needs ahead of the click. */
  prepareSave?: () => void;
}

export const DiagramActionsContext = createContext<DiagramActions>({});
