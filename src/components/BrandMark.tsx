type BrandMarkProps = { className?: string; title?: string };

export default function BrandMark({ className = "", title }: BrandMarkProps) {
  return (
    <svg className={`scenelith-brand-mark ${className}`.trim()} viewBox="0 0 64 64" fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d="M34 9h13a8 8 0 0 1 8 8v19a8 8 0 0 1-8 8H34a8 8 0 0 1-8-8V17a8 8 0 0 1 8-8Z" stroke="currentColor" strokeWidth="7" />
      <path d="M17 20h13a8 8 0 0 1 8 8v19a8 8 0 0 1-8 8H17a8 8 0 0 1-8-8V28a8 8 0 0 1 8-8Z" stroke="currentColor" strokeWidth="7" />
    </svg>
  );
}
