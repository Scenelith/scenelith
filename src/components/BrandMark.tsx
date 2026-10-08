type BrandMarkProps = { className?: string; title?: string };
export default function BrandMark({ className = "", title }: BrandMarkProps) {
  return <span className={`scenelith-brand-mark ${className}`.trim()} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} />;
}
