/**
 * Editorial primitives — the v2 design system's layout vocabulary.
 *
 * These are intentionally separate from the shadcn-style primitives under
 * `components/ui/`. They are token-driven, newspaper-inspired pieces meant
 * to compose page chrome: section headers, mastheads, translucent glass
 * surfaces, drawn rulers.
 *
 * Spec + previews: packages/ui/docs/design-preview/
 */
export { Masthead } from './masthead';
export type { MastheadProps } from './masthead';

export { SectionHead } from './section-head';
export type { SectionHeadProps } from './section-head';

export { Glass } from './glass';
export type { GlassProps } from './glass';

export { Rule, RulerScale } from './ruler';
export type { RulerScaleProps } from './ruler';
