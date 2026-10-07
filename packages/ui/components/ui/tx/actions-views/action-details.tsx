import { ReactNode } from 'react';
import { IncognitoIcon } from '../../icons/incognito';
import { Separator } from '../../separator';

/**
 * Render key/value pairs inside a `<ViewBox />`.
 *
 * @example
 * ```tsx
 * <ActionDetails>
 *   <ActionDetails.Row label="Validator">
 *     <IdentityKeyComponent identityKey={identityKey} />
 *   </ActionDetails.Row>
 * </ActionDetails>
 * ```
 */
export const ActionDetails = ({ children, label }: { children: ReactNode; label?: string }) => {
  return (
    <div className='flex flex-col gap-2'>
      {!!label && <div>{label}</div>}

      {children}
    </div>
  );
};

const ActionDetailsRow = ({
  label,
  children,
  isOpaque,
}: {
  label: string;
  children?: ReactNode;
  /**
   * If set to true, add styles indicating that the row's data is _not_ visible.
   */
  isOpaque?: boolean;
}) => {
  return (
    <div className='flex items-center justify-between'>
      {isOpaque ? (
        <span className='flex items-center whitespace-nowrap text-fg-dim'>
          <span className='mx-2'>
            <IncognitoIcon fill='currentColor' />
          </span>
          <span>{label}</span>
        </span>
      ) : (
        <span className='whitespace-nowrap break-keep text-base'>{label}</span>
      )}

      <Separator />

      {children}
    </div>
  );
};

ActionDetails.Row = ActionDetailsRow;
