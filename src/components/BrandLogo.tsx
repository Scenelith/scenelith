export default function BrandLogo({ className = "", light = false }: { className?: string; light?: boolean }) {
  return <span className={`scenelith-brand-logo ${light ? "scenelith-brand-logo-light" : ""} ${className}`.trim()} role="img" aria-label="Scenelith" />;
}
