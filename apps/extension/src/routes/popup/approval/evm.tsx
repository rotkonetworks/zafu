/**
 * Approval screen for the evm provider: connect, a transaction, or a message.
 * It only shows the request and answers yes or no; the service worker signs
 * the transaction it stashed, never one this screen hands back. Connecting on
 * a chain zafu has not reached yet asks for its rpc here, through the egress
 * opt-in, before the site is told yes.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatUnits, hexToBytes } from 'viem';
import { describeArbitraryData } from '@repo/wallet/networks/cosmos/adr036';
import { Clipped } from '@repo/ui/components/ui/clipped';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { evmApprovalKey, type EvmApprovalRequest } from '../../../message/evm';
import { callLines, readCall } from '../../../evm/calldata';
import { knownBridge } from '../../../evm/chains';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { ApproveDeny } from './approve-deny';

const TITLE: Record<EvmApprovalRequest['kind'], [title: string, approve: string]> = {
  connect: ['connect wallet', 'connect'],
  send: ['approve transaction', 'approve'],
  sign: ['sign a message', 'sign'],
  chain: ['use a node on this computer', 'allow'],
};

const Line = ({
  label,
  alert,
  children,
}: {
  label: string;
  alert?: boolean;
  children: ReactNode;
}) => (
  <div className='flex flex-col gap-0.5 border-t border-border-soft py-2 first:border-t-0'>
    <span className='kicker'>{label}</span>
    <span
      role={alert ? 'alert' : undefined}
      className={alert ? 'text-sm text-red-400' : 'break-all font-mono text-label text-fg'}
    >
      {children}
    </span>
  </div>
);

const Send = ({ req }: { req: EvmApprovalRequest }) => {
  const tx = req.tx!;
  const lines = callLines(readCall(tx.data, knownBridge(req.chain, tx.to)), req.token, req.owner);
  return (
    <>
      <Line label='from'>{req.from}</Line>
      <Line label='to'>{tx.to ?? 'a new contract'}</Line>
      <Line label='value'>
        {formatUnits(BigInt(tx.value), 18)} {req.chain.symbol}
      </Line>
      {lines.map(([label, text, warn]) => (
        <Line key={label} label={label} alert={warn}>
          {text}
        </Line>
      ))}
      <Line label='network fee'>
        up to {formatUnits(BigInt(tx.gas) * BigInt(tx.gasPrice), 18)} {req.chain.symbol}
      </Line>
    </>
  );
};

const Sign = ({ req }: { req: EvmApprovalRequest }) => {
  const message = describeArbitraryData(hexToBytes(req.message ?? '0x'));
  return (
    <>
      <p className='py-2 text-fg'>
        the site can use this signature as yours · sign only what you expected it to ask
      </p>
      <Line label='address'>{req.from}</Line>
      <Line label={message.hex ? 'message (hex)' : 'message'}>
        <span className='whitespace-pre-wrap'>{message.text}</span>
      </Line>
    </>
  );
};

const Connect = ({ req }: { req: EvmApprovalRequest }) => (
  <p className='py-2 text-fg'>
    this site will see your evm address and can ask for transactions. each one is approved here.
    {req.chain.destination &&
      ` zafu will reach ${hostnameOf(req.chain.rpc)} for it, which sees your ip and what you look up.`}
  </p>
);

const LocalChain = ({ req }: { req: EvmApprovalRequest }) => (
  <p className='py-2 text-fg'>
    this site asks zafu to use the node at {req.chain.rpc} on this computer. its reads and
    transactions on {req.chain.name} go there.
  </p>
);

const BODY: Record<EvmApprovalRequest['kind'], (p: { req: EvmApprovalRequest }) => ReactNode> = {
  connect: Connect,
  chain: LocalChain,
  send: Send,
  sign: Sign,
};

export const EvmApproval = () => {
  const [params] = useSearchParams();
  const requestId = params.get('requestId') ?? '';
  /** undefined while reading, null once it has expired */
  const [req, setReq] = useState<EvmApprovalRequest | null>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = evmApprovalKey(requestId);
    void chrome.storage.session
      .get(key)
      .then(stored => setReq((stored[key] as EvmApprovalRequest | undefined) ?? null));
  }, [requestId]);

  const respond = async (result: { approved: boolean; error?: string }) => {
    // await delivery before closing, or the worker and the site are left waiting
    // (keplr.tsx). The worker's approval-window answers both screens by request id.
    try {
      await chrome.runtime.sendMessage({ type: 'zafu_keplr_result', requestId, result });
    } catch {
      // the worker is gone: closing is all that is left
    }
    window.close();
  };

  if (req === null) {
    return <div className='p-6 text-center text-sm text-fg-muted'>this request has expired</div>;
  }
  if (!req) {
    return <div className='p-6 text-center text-sm text-fg-muted'>loading…</div>;
  }

  const approve = async () => {
    setBusy(true);
    const reached =
      req.kind !== 'connect' ||
      !req.chain.destination ||
      (await requestEgressOptIn(req.chain.destination));
    await respond(
      reached
        ? { approved: true }
        : { approved: false, error: `zafu didn't connect · ${req.chain.name} stays off for now` },
    );
  };

  const [title, approveLabel] = TITLE[req.kind];
  const Body = BODY[req.kind];
  return (
    <div className='flex h-full flex-col'>
      <header className='flex flex-col items-center justify-center border-b border-border-soft py-4'>
        <span className='kicker mb-1'>
          {req.chain.name} · {hostnameOf(req.origin)}
        </span>
        <h1 className='text-title text-fg-high lowercase'>{title}</h1>
      </header>

      <div className='flex-1 overflow-y-auto p-4'>
        <div className='flex items-center gap-2 bg-canvas p-3'>
          <OriginIcon origin={req.origin} size={32} />
          <div className='flex flex-col overflow-hidden'>
            {req.title && <Clipped className='text-sm'>{req.title}</Clipped>}
            <Clipped className='text-xs text-fg-muted' label='site'>
              {req.origin}
            </Clipped>
          </div>
        </div>
        <div className='mt-3 border border-border-soft px-3 py-1 text-sm'>
          <Line label='chain'>
            {req.chain.name} ({req.chain.id})
          </Line>
          <Body req={req} />
        </div>
      </div>

      <ApproveDeny
        deny={() => void respond({ approved: false, error: 'rejected' })}
        approve={busy ? undefined : () => void approve()}
        approveLabel={approveLabel}
        denyLabel='not now'
      />
    </div>
  );
};
