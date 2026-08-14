"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Product, ProductStockMovement, StockMovementType } from "@/types";
import {
  MOVEMENT_TYPES_BY_MODE,
  resolveStockAdjustment,
  StockAdjustError,
  type StockAdjustMode,
} from "@/lib/products/stock";
import { adjustProductStock } from "@/lib/products/stock-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, Loader2 } from "lucide-react";

interface StockAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
  onAdjusted: (movement: ProductStockMovement) => void;
}

const inputClass = "border-border bg-muted text-foreground placeholder:text-muted-foreground";

/**
 * Fast Stock Management (spec item 5) — a compact dialog so quantity
 * changes never require opening the full product form. Add / Remove /
 * Set exact are three tabs over the same `adjust_product_stock` RPC,
 * differing only in how the signed delta is computed
 * (`resolveStockAdjustment`).
 */
export function StockAdjustDialog({
  open,
  onOpenChange,
  product,
  onAdjusted,
}: StockAdjustDialogProps) {
  const t = useTranslations("Products.stockAdjust");
  const tMovement = useTranslations("Products.movementTypes");
  const supabase = createClient();

  const [mode, setMode] = useState<StockAdjustMode>("add");
  const [quantity, setQuantity] = useState("");
  const [movementType, setMovementType] = useState<StockMovementType>("purchase");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset every time the dialog opens or the target product changes —
  // a legitimate prop-driven sync, same reasoning as ProductForm's.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setMode("add");
    setQuantity("");
    setMovementType(MOVEMENT_TYPES_BY_MODE.add[0]);
    setReferenceNumber("");
    setReason("");
  }, [open, product?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function changeMode(next: StockAdjustMode) {
    setMode(next);
    setMovementType(MOVEMENT_TYPES_BY_MODE[next][0]);
  }

  // Live "12 -> 17" preview. Lenient on partial input — only resolves
  // once the quantity actually parses, no error thrown while typing.
  const preview = useMemo(() => {
    if (!product) return null;
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty)) return null;
    try {
      return resolveStockAdjustment({ mode, quantity: qty, currentStock: product.current_stock });
    } catch {
      return null;
    }
  }, [product, mode, quantity]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!product) return;

    const qty = parseFloat(quantity);
    let result;
    try {
      result = resolveStockAdjustment({ mode, quantity: qty, currentStock: product.current_stock });
    } catch (err) {
      toast.error(err instanceof StockAdjustError ? err.message : t("invalidQuantity"));
      return;
    }

    setSaving(true);
    try {
      const movement = await adjustProductStock(supabase, {
        productId: product.id,
        movementType,
        quantityDelta: result.delta,
        referenceNumber,
        reason,
      });
      toast.success(t("toastSuccess", { name: product.name }));
      onOpenChange(false);
      onAdjusted(movement);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setSaving(false);
    }
  }

  if (!product) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description", { name: product.name })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => changeMode(v as StockAdjustMode)}>
            <TabsList className="w-full">
              <TabsTrigger value="add">{t("modeAdd")}</TabsTrigger>
              <TabsTrigger value="remove">{t("modeRemove")}</TabsTrigger>
              <TabsTrigger value="set">{t("modeSet")}</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="space-y-2">
            <Label className="text-muted-foreground">
              {mode === "set" ? t("targetQuantityLabel") : t("quantityLabel")}
            </Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              autoFocus
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
              className={inputClass}
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("currentStock", { stock: product.current_stock, unit: product.unit })}
              {preview && (
                <>
                  <ArrowRight className="size-3" />
                  <span className="font-medium text-foreground">
                    {preview.resultingStock} {product.unit}
                  </span>
                </>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("movementTypeLabel")}</Label>
            <select
              value={movementType}
              onChange={(e) => setMovementType(e.target.value as StockMovementType)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {MOVEMENT_TYPES_BY_MODE[mode].map((type) => (
                <option key={type} value={type}>
                  {tMovement(type)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("referenceLabel")}</Label>
            <Input
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder={t("referencePlaceholder")}
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t("reasonLabel")}</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              className={`min-h-[64px] ${inputClass}`}
            />
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={saving || !quantity.trim()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
