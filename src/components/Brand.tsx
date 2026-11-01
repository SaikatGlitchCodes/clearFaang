import Link from 'next/link';

/** clearFaang logo mark: a tiny system diagram (node fanning into two) in a rounded square. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" className="sds-logo-bg" />
      <g className="sds-logo-fg" strokeWidth="1.8" strokeLinecap="round" fill="none">
        <path d="M9 16h5M14 16c3 0 3-6 7-6M14 16c3 0 3 6 7 6" />
      </g>
      <circle cx="9" cy="16" r="2.4" className="sds-logo-dot" />
      <circle cx="22" cy="10" r="2.2" className="sds-logo-dot" />
      <circle cx="22" cy="22" r="2.2" className="sds-logo-dot" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="clearFaang home">
      <LogoMark size={compact ? 24 : 30} />
      <span className={`${compact ? 'text-[15px]' : 'text-xl'} tracking-tight text-slate-900`}>
        <span className="font-medium">clear</span>
        <span className="font-extrabold">Faang</span>
      </span>
    </Link>
  );
}
