import { JsonViewer as TextaJsonViewer, NamedColorspace } from '@textea/json-viewer';

import type { JsonObject, JsonValue } from '@bufbuild/protobuf';

/** the theme's own tokens, so the raw request reads in sumi and washi alike */
export const customTheme: NamedColorspace = {
  scheme: 'zafu',
  author: 'zafu',
  base00: 'var(--surface-elev-1)', // background
  base01: 'var(--fg)',
  base02: 'var(--surface-border-soft)', // nested section border
  base03: 'var(--fg)',
  base04: 'var(--fg-dim)', // item count
  base05: 'var(--fg)',
  base06: 'var(--fg)',
  base07: 'var(--fg-high)', // keys
  base08: 'var(--fg)',
  base09: 'var(--zigner-gold)', // values
  base0A: 'var(--fg)',
  base0B: 'var(--fg-high)',
  base0C: 'var(--fg-muted)', // array index
  base0D: 'var(--fg-muted)',
  base0E: 'var(--fg-muted)',
  base0F: 'var(--fg)',
};

export const JsonViewer = ({ jsonObj }: { jsonObj: JsonObject | JsonValue[] }) => {
  return (
    <div className='mt-0 border border-border-soft bg-elev-1 p-5'>
      <TextaJsonViewer
        value={jsonObj}
        style={{ fontFamily: 'Iosevka Term' }}
        theme={customTheme}
        rootName={false}
        enableClipboard={true}
        defaultInspectDepth={2}
        quotesOnKeys={false}
      />
    </div>
  );
};
