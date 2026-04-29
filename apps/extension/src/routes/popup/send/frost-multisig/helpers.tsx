// shared bits used by both mnemonic (self-custody) and airgap (zigner) sign flows.

/** the 3 sign rounds shown as a [N]-label stepper. */
export const SIGN_STEPS = [
  { key: 1, label: 'commitments' },
  { key: 2, label: 'shares' },
  { key: 3, label: 'finalize' },
] as const;

export function SignStepProgress({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-2">
      {SIGN_STEPS.map((s) => (
        <div key={s.key} className="flex items-center gap-1.5">
          <div
            className={`flex size-5 items-center justify-center rounded-full text-[10px] font-medium ${
              s.key <= current ? 'bg-zigner-gold text-zigner-dark' : 'bg-elev-2 text-fg-muted'
            }`}
          >
            {s.key}
          </div>
          <span className={`text-xs ${s.key <= current ? 'text-fg' : 'text-fg-muted'}`}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/** small horizontal room-code chip with copy icon (matches multisig/create style). */
export function RoomCodeChip({ code }: { code: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-soft bg-elev-1 px-4 py-2">
      <span className="font-mono text-sm tracking-wider">{code}</span>
      <button
        onClick={() => void navigator.clipboard.writeText(code)}
        className="p-1 text-fg-muted hover:text-fg-high transition-colors"
        title="copy room code"
      >
        <span className="i-lucide-copy size-3.5" />
      </button>
    </div>
  );
}

/** amber warning triangle with a left-floating hover-tooltip. */
export function DontQuitIcon() {
  return (
    <div className="relative group ml-auto">
      <span
        className="i-lucide-alert-triangle size-4 text-amber-400 cursor-help"
        aria-label="don't close this page — closing cancels signing"
      />
      <div className="absolute right-full top-1/2 -translate-y-1/2 mr-2 hidden group-hover:block w-48 rounded bg-elev-2 px-2 py-1.5 text-[10px] leading-snug text-fg shadow-lg ring-1 ring-amber-500/30 z-20 pointer-events-none">
        don't close this page — closing cancels signing
      </div>
    </div>
  );
}

/** poll-with-timeout used while waiting on relay messages from co-signers. */
export const waitFor = (cond: () => boolean, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for co-signers'));
      setTimeout(tick, 500);
    };
    tick();
  });
