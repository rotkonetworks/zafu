import { ReactNode } from 'react';
import { motion } from 'framer-motion';

/**
 * Shared shell for approval popups.
 *
 * Fills the popup layout's scroll container exactly (h-full min-h-0) so
 * the footer with the Approve/Deny actions stays pinned and visible while
 * only the content area scrolls. Replaces the old FadeTransition +
 * min-h-screen roots, which made the whole screen scroll and pushed the
 * action buttons out of view on long content.
 */
export const ApprovalScreen = ({
  header,
  footer,
  children,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) => {
  return (
    <motion.div
      className='flex h-full min-h-0 w-full flex-col'
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.3, ease: 'easeOut' } }}
      exit={{ opacity: 0 }}
    >
      {header && <div className='shrink-0'>{header}</div>}
      <div className='flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto py-6'>{children}</div>
      {footer && <div className='shrink-0'>{footer}</div>}
    </motion.div>
  );
};
