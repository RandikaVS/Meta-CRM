"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/currency";
import type { Product } from "@/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Search } from "lucide-react";

/** Search-and-pick over the Stock & Products catalog — the same
 *  "search + select" shape as ContactPicker, scaled down to a
 *  trigger button (used inline in the appointment products list
 *  rather than replacing a filled value, since multiple products can
 *  be added one after another). */
export function ProductLinePicker({ onPick }: { onPick: (product: Product) => void }) {
  const t = useTranslations("Appointments.detail");
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Immediate spinner on open/query-change, same reasoning as
    // ContactPicker's identical debounce pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const term = search.trim();
    const timer = setTimeout(async () => {
      let query = supabase
        .from("products")
        .select("*")
        .eq("is_active", true)
        .order("name")
        .limit(20);
      if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
      const { data } = await query;
      if (!cancelled) {
        setResults((data ?? []) as Product[]);
        setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, search, supabase]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground hover:bg-muted"
          />
        }
      >
        <Plus className="size-3.5" />
        {t("addProduct")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchProducts")}
              className="h-8 border-border bg-muted pl-7 text-foreground"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
            </div>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("noResults")}</p>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                  setSearch("");
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-popover-foreground">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.sku} · {p.current_stock} {p.unit} {t("inStock")}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatCurrency(p.selling_price)}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
