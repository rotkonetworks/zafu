/**
 * placeholder shown when a feature is opened on a network that doesn't
 * support it (e.g. governance on zcash, multisig on penumbra). renders
 * the feature's own icon to keep the visual continuity with its header.
 */

interface NetworkUnavailableProps {
  /** lowercase feature name — used as both heading and body subject */
  feature: string;
  /** lucide icon class, e.g. "i-lucide-layers" */
  iconClass: string;
}

export const NetworkUnavailable = ({ feature, iconClass }: NetworkUnavailableProps) => (
  <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
    <div className='rounded-full bg-primary/10 p-4'>
      <span className={`${iconClass} h-8 w-8 text-zigner-gold`} />
    </div>
    <div>
      <h2 className='text-lg font-medium'>{feature}</h2>
      <p className='mt-1 text-sm text-fg-muted'>
        {feature} is not available on this network.
      </p>
    </div>
  </div>
);
