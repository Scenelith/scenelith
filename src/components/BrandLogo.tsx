export default function BrandLogo({ className = "", light = false }: { className?: string; light?: boolean }) {
  return <img className={`scenelith-brand-logo ${className}`.trim()} src={`/brand/logo-${light ? "light" : "dark"}.svg`} alt="Scenelith" width="160" height="36" />;
}
