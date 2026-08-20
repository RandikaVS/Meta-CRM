import { cn } from "@/lib/utils";

const PLACEHOLDER_SRC = "/product-placeholder.svg";

/**
 * Product thumbnail with a fallback SVG placeholder. Item 6 of the
 * spec: "use a placeholder/sample SVG... do not hard-code a final
 * production image system" — this stays a thin `<img>` wrapper so
 * swapping in a real image pipeline later is a one-file change.
 */
export function ProductImage({
  src,
  alt,
  className,
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- storage/placeholder URL, same pattern as the sidebar's account logo
    <img
      src={src || PLACEHOLDER_SRC}
      alt={alt}
      className={cn(
        "size-9 shrink-0 rounded-md border border-border bg-muted object-cover",
        className,
      )}
      onError={(e) => {
        // A stale/deleted storage object shouldn't render a broken
        // image icon — fall back to the placeholder once, guarding
        // against an infinite loop if the placeholder itself 404s.
        const img = e.currentTarget;
        if (img.src.endsWith(PLACEHOLDER_SRC)) return;
        img.src = PLACEHOLDER_SRC;
      }}
    />
  );
}
