import { useState, type ReactNode } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { groupPresetsByRegion, type RpcEndpointRegion } from '../../../config/zcash-endpoints';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { hostOf } from '../../../net/destination';
import { SheetOptions } from './sheet-options';

export interface NodePreset {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly region: RpcEndpointRegion;
  /** what kind of node it is, when the chain has more than one */
  readonly kind?: string;
}

/** url -> round trip in ms, null when the node did not answer */
export type NodeSpeeds = Map<string, number | null>;

const REGION_LABEL: Record<RpcEndpointRegion, string> = {
  default: 'recommended',
  global: 'global',
  americas: 'americas',
  europe: 'europe',
  'asia-pacific': 'asia pacific',
  community: 'community',
};

const isHttpUrl = (raw: string) => {
  try {
    return /^https?:$/.test(new URL(raw.trim()).protocol);
  } catch {
    return false;
  }
};

const speedLabel = (speeds: NodeSpeeds | null, url: string) => {
  const ms = speeds?.get(url);
  return ms === undefined ? undefined : ms === null ? 'no answer' : `${ms} ms`;
};

const descOf = (p: NodePreset, speeds: NodeSpeeds | null) =>
  [p.kind, speedLabel(speeds, p.url)].filter(Boolean).join(' · ') || undefined;

/**
 * the node picker for one chain (NetworkSheet.dc.html shape): presets by
 * region, your own node one step in, and a speed test that runs only when
 * asked - and only after the user allows contacting the other nodes.
 */
export const NodeSheet = ({
  open,
  onOpenChange,
  title,
  presets,
  current,
  onPick,
  egress,
  measure,
  custom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  presets: readonly NodePreset[];
  current: string;
  onPick: (url: string) => Promise<void>;
  /** the optional destination a speed test contacts */
  egress: 'zcash-servers' | 'penumbra-servers';
  measure: () => Promise<NodeSpeeds>;
  /** extra controls on the your-own-node step */
  custom?: ReactNode;
}) => {
  const [step, setStep] = useState<'list' | 'own'>('list');
  const [draft, setDraft] = useState('');
  const [speeds, setSpeeds] = useState<NodeSpeeds | null>(null);
  const [testing, setTesting] = useState(false);
  const currentHost = hostOf(current);
  const preset = presets.find(p => hostOf(p.url) === currentHost);

  const close = (next: boolean) => {
    onOpenChange(next);
    setStep('list');
  };
  const pick = async (url: string) => {
    await onPick(url.trim());
    close(false);
  };
  const test = async () => {
    if (!(await requestEgressOptIn(egress))) {
      return;
    }
    setTesting(true);
    try {
      setSpeeds(await measure());
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={close} title={step === 'own' ? 'your own node' : title}>
      {step === 'list' ? (
        <>
          <div className='-mx-4 flex min-h-0 flex-col gap-3 overflow-y-auto px-4'>
            {groupPresetsByRegion(presets).map(g => (
              <div key={g.region} className='flex flex-col gap-1.5'>
                <span className='text-[11px] tracking-[0.06em] text-fg-muted'>
                  {REGION_LABEL[g.region]}
                </span>
                <SheetOptions
                  value={preset?.url ?? ''}
                  options={g.presets.map(p => ({
                    value: p.url,
                    label: p.label,
                    desc: descOf(p, speeds),
                  }))}
                  onPick={url => void pick(url)}
                />
              </div>
            ))}
          </div>
          <RowGroup className='shrink-0'>
            <Row
              type='value'
              label='your own node'
              value={preset ? undefined : currentHost}
              onPress={() => {
                setDraft(preset ? '' : current);
                setStep('own');
              }}
            />
          </RowGroup>
          <Button
            variant='secondary'
            className='shrink-0'
            loading={testing}
            onClick={() => void test()}
          >
            {speeds ? 'test speed again' : 'test speed'}
          </Button>
        </>
      ) : (
        <>
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder='https://...'
            className='font-mono text-xs'
            autoFocus
          />
          {custom}
          <div className='flex gap-2'>
            <Button variant='secondary' className='w-[110px]' onClick={() => setStep('list')}>
              back
            </Button>
            <Button
              className='flex-1'
              disabled={!isHttpUrl(draft)}
              onClick={() => void pick(draft)}
            >
              use this node
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
};
