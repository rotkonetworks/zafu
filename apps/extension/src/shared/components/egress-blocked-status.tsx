/**
 * The calm face of an {@link EgressBlockedError} that still reached a screen -
 * a feature that forgot to ask first, or an opt-in the user later blocked.
 * Never a raw error: a reserved-height notice naming the host, with an inline
 * way to allow it and retry.
 */

import { useState } from 'react';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { isEgressBlocked } from '../../net/egress';
import { requestEgressOptIn } from '../../net/egress-opt-in';

export const EgressBlockedStatus = ({
  error,
  onAllowed,
}: {
  error: unknown;
  onAllowed: () => void;
}) => {
  const [allowing, setAllowing] = useState(false);

  if (!isEgressBlocked(error)) {
    return null;
  }
  const { host, destination } = error.refusal;

  const allow = (): void => {
    if (!destination || allowing) {
      return;
    }
    setAllowing(true);
    void requestEgressOptIn(destination).then(allowed => {
      setAllowing(false);
      if (allowed) {
        onAllowed();
      }
    });
  };

  return (
    <StatusSlot
      tone='warn'
      icon='i-ph-plug'
      action={
        destination ? { label: allowing ? 'turning on' : 'turn on', onClick: allow } : undefined
      }
    >
      {host} is off for now
    </StatusSlot>
  );
};
