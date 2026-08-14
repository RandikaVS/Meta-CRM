"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Product } from "@/types";
import { loadStockHistory, type StockHistoryEntry } from "@/lib/products/stock-api";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { History, Loader2 } from "lucide-react";

interface StockHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}

const MOVEMENT_TONE: Record<string, string> = {
  opening_stock: "text-primary",
  purchase: "text-primary",
  manual_increase: "text-primary",
  returned: "text-primary",
  sale: "text-red-400",
  manual_decrease: "text-red-400",
  damaged: "text-red-400",
  adjustment: "text-amber-400",
};

/** Product action: "View Stock History" (spec item 9) — a drawer so
 *  auditing why the current stock is what it is never leaves the
 *  Products page. */
export function StockHistorySheet({ open, onOpenChange, product }: StockHistorySheetProps) {
  const t = useTranslations("Products.stockHistory");
  const tMovement = useTranslations("Products.movementTypes");
  const supabase = createClient();

  const [entries, setEntries] = useState<StockHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    if (!product) return;
    setLoading(true);
    try {
      const rows = await loadStockHistory(supabase, product.id);
      setEntries(rows);
    } catch {
      toast.error(t("toastFailedLoad"));
    } finally {
      setLoading(false);
    }
  }, [supabase, product, t]);

  useEffect(() => {
    if (!open || !product) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistory();
  }, [open, product, fetchHistory]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-xl w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">{t("title")}</SheetTitle>
            <SheetDescription className="text-muted-foreground">
              {product ? t("description", { name: product.name }) : ""}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Loader2 className="size-6 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">{t("loading")}</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <History className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
              </div>
            ) : (
              <ol className="space-y-3">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-border bg-muted/30 p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground">
                          {tMovement(entry.movement_type)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(entry.created_at).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${
                          MOVEMENT_TONE[entry.movement_type] ?? "text-foreground"
                        }`}
                      >
                        {entry.quantity > 0 ? "+" : ""}
                        {entry.quantity}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t("stockChange", {
                          previous: entry.previous_stock,
                          next: entry.new_stock,
                        })}
                      </span>
                      {entry.reference_number && (
                        <span>
                          {t("reference")}: {entry.reference_number}
                        </span>
                      )}
                      <span>
                        {t("by")}: {entry.created_by_name ?? t("unknownUser")}
                      </span>
                    </div>

                    {entry.reason && (
                      <p className="mt-1.5 text-xs text-muted-foreground italic">
                        &ldquo;{entry.reason}&rdquo;
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
