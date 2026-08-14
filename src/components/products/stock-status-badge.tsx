"use client";

import { useTranslations } from "next-intl";
import type { StockStatus } from "@/types";
import { cn } from "@/lib/utils";

// Same color language the rest of the app already uses for status
// chips: primary = good (metric-card's positive delta), amber =
// warning (activity-feed's broadcast chip), red = bad (deal-card's
// lost-deal chip).
const STATUS_STYLES: Record<StockStatus, string> = {
  in_stock: "bg-primary/10 text-primary",
  low_stock: "bg-amber-500/10 text-amber-400",
  out_of_stock: "bg-red-500/15 text-red-400",
};

export function StockStatusBadge({
  status,
  className,
}: {
  status: StockStatus;
  className?: string;
}) {
  const t = useTranslations("Products.page.stockStatus");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        STATUS_STYLES[status],
        className,
      )}
    >
      {t(status)}
    </span>
  );
}
