import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Escape hatch for full-screen overlays.
 *
 * The popup layout root uses `contain-layout` and the scroll area uses
 * `transform-gpu` — both create containing blocks, so a `fixed inset-0`
 * overlay rendered inside the content area is trapped: it positions
 * relative to the scroll container and can never stack above the bottom
 * tabs (separate stacking context, z-index is not comparable). Symptom:
 * modal buttons hiding under the footer.
 *
 * Rendering through this portal puts the overlay on document.body where
 * fixed positioning and z-index behave as written. React context and
 * synthetic events still work across portals, so consumers only need to
 * wrap their outermost fixed element.
 */
export const OverlayPortal = ({ children }: { children: ReactNode }) =>
  createPortal(children, document.body);
