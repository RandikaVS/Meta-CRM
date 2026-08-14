"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Product } from "@/types";
import { loadProductCategories } from "@/lib/products/queries";
import { isUniqueViolation } from "@/lib/products/stock-api";
import { UNIT_OPTIONS } from "@/lib/products/constants";
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ProductImage } from "@/components/products/product-image";
import { AlertTriangle, Loader2, Upload } from "lucide-react";

interface ProductFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
  onSaved: () => void;
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";
const inputClass = "border-border bg-muted text-foreground placeholder:text-muted-foreground";

export function ProductForm({ open, onOpenChange, product, onSaved }: ProductFormProps) {
  const t = useTranslations("Products.form");
  const supabase = createClient();
  const { accountId } = useAuth();
  const isEdit = !!product;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [unit, setUnit] = useState<string>(UNIT_OPTIONS[0]);
  const [costPrice, setCostPrice] = useState("0");
  const [sellingPrice, setSellingPrice] = useState("0");
  const [taxRate, setTaxRate] = useState("0");
  const [openingStock, setOpeningStock] = useState("0");
  const [reorderLevel, setReorderLevel] = useState("0");
  const [maxStockLevel, setMaxStockLevel] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);

  const [categories, setCategories] = useState<string[]>([]);

  // SKU duplicate check (create only) — soft warning + submit block,
  // mirrors ContactForm's on-blur phone-duplicate check. The DB's
  // (account_id, sku) unique constraint is the real backstop.
  const [skuTaken, setSkuTaken] = useState(false);
  const [checkingSku, setCheckingSku] = useState(false);

  // Reset every field each time the sheet opens or its `product` prop
  // changes — a legitimate prop-driven sync (mirrors DealForm's own
  // reset effect), not a case the rule needs to guard.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    if (product) {
      setName(product.name);
      setSku(product.sku);
      setBarcode(product.barcode ?? "");
      setDescription(product.description ?? "");
      setCategory(product.category ?? "");
      setBrand(product.brand ?? "");
      setUnit(product.unit || UNIT_OPTIONS[0]);
      setCostPrice(String(product.cost_price ?? 0));
      setSellingPrice(String(product.selling_price ?? 0));
      setTaxRate(String(product.tax_rate ?? 0));
      setReorderLevel(String(product.reorder_level ?? 0));
      setMaxStockLevel(product.max_stock_level != null ? String(product.max_stock_level) : "");
      setIsActive(product.is_active);
      setImageUrl(product.image_url ?? null);
      setOpeningStock("0"); // display-only concept on edit — current stock shown separately
    } else {
      setName("");
      setSku("");
      setBarcode("");
      setDescription("");
      setCategory("");
      setBrand("");
      setUnit(UNIT_OPTIONS[0]);
      setCostPrice("0");
      setSellingPrice("0");
      setTaxRate("0");
      setOpeningStock("0");
      setReorderLevel("0");
      setMaxStockLevel("");
      setIsActive(true);
      setImageUrl(null);
    }
    setSkuTaken(false);

    loadProductCategories(supabase)
      .then(setCategories)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function checkSkuTaken() {
    if (isEdit) return;
    const value = sku.trim();
    if (!value) {
      setSkuTaken(false);
      return;
    }
    setCheckingSku(true);
    try {
      const { data } = await supabase
        .from("products")
        .select("id")
        .eq("sku", value)
        .limit(1)
        .maybeSingle();
      setSkuTaken(!!data);
    } finally {
      setCheckingSku(false);
    }
  }

  async function handleImageFile(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error(t("toastInvalidImage"));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t("toastImageTooLarge"));
      return;
    }
    setUploadingImage(true);
    try {
      const { publicUrl } = await uploadAccountMedia("product-images", file);
      setImageUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastUploadFailed"));
    } finally {
      setUploadingImage(false);
    }
  }

  function parseNonNegative(value: string): number | null {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    if (!sku.trim()) {
      toast.error(t("skuRequired"));
      return;
    }
    if (!isEdit && skuTaken) {
      toast.error(t("toastSkuConflict"));
      return;
    }

    const cost = parseNonNegative(costPrice);
    const selling = parseNonNegative(sellingPrice);
    const tax = parseNonNegative(taxRate);
    const reorder = parseNonNegative(reorderLevel);
    const opening = isEdit ? 0 : parseNonNegative(openingStock);
    const maxStock = maxStockLevel.trim() ? parseNonNegative(maxStockLevel) : null;

    if (cost === null || selling === null) {
      toast.error(t("invalidPrice"));
      return;
    }
    if (tax === null || tax > 100) {
      toast.error(t("invalidTaxRate"));
      return;
    }
    if (reorder === null) {
      toast.error(t("invalidReorderLevel"));
      return;
    }
    if (opening === null) {
      toast.error(t("invalidOpeningStock"));
      return;
    }
    if (maxStockLevel.trim() && maxStock === null) {
      toast.error(t("invalidMaxStock"));
      return;
    }
    if (maxStock !== null && maxStock < reorder) {
      toast.error(t("maxBelowReorder"));
      return;
    }

    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error(t("toastNotSignedIn"));
      if (!accountId) throw new Error(t("toastNotLinked"));

      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        barcode: barcode.trim() || null,
        description: description.trim() || null,
        category: category.trim() || null,
        brand: brand.trim() || null,
        unit,
        cost_price: cost,
        selling_price: selling,
        tax_rate: tax,
        reorder_level: reorder,
        max_stock_level: maxStock,
        image_url: imageUrl,
        is_active: isActive,
      };

      if (isEdit && product) {
        const { error } = await supabase
          .from("products")
          .update(payload)
          .eq("id", product.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("products").insert({
          ...payload,
          account_id: accountId,
          created_by: user.id,
          current_stock: opening ?? 0,
        });
        if (error) throw error;
      }

      toast.success(isEdit ? t("toastSuccessEdit") : t("toastSuccessAdd"));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        toast.error(t("toastSkuConflict"));
        setSkuTaken(true);
        return;
      }
      const message = err instanceof Error ? err.message : t("toastError");
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {isEdit ? t("editTitle") : t("addTitle")}
            </SheetTitle>
          </SheetHeader>

          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-5 overflow-y-auto p-4">
              {/* Image */}
              <div className="flex items-center gap-3">
                <ProductImage src={imageUrl} alt={name || "Product"} className="size-14" />
                <div className="flex flex-col gap-1">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImageFile(f);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingImage}
                    onClick={() => fileInputRef.current?.click()}
                    className="border-border text-muted-foreground hover:bg-muted"
                  >
                    {uploadingImage ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Upload className="size-3.5" />
                    )}
                    {t("uploadImage")}
                  </Button>
                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => setImageUrl(null)}
                      className="text-left text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t("removeImage")}
                    </button>
                  )}
                </div>
              </div>

              {/* Basic info */}
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("sectionBasic")}
                </p>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">
                    {t("nameLabel")} <span className="text-red-400">*</span>
                  </Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("namePlaceholder")}
                    className={inputClass}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">
                      {t("skuLabel")} <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={sku}
                      onChange={(e) => {
                        setSku(e.target.value);
                        if (skuTaken) setSkuTaken(false);
                      }}
                      onBlur={checkSkuTaken}
                      disabled={isEdit}
                      placeholder={t("skuPlaceholder")}
                      className={inputClass}
                    />
                    {skuTaken && (
                      <p className="flex items-center gap-1 text-xs text-red-400">
                        <AlertTriangle className="size-3" />
                        {t("skuTaken")}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("barcodeLabel")}</Label>
                    <Input
                      value={barcode}
                      onChange={(e) => setBarcode(e.target.value)}
                      placeholder={t("barcodePlaceholder")}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("categoryLabel")}</Label>
                    <Input
                      list="product-category-options"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder={t("categoryPlaceholder")}
                      className={inputClass}
                    />
                    <datalist id="product-category-options">
                      {categories.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("brandLabel")}</Label>
                    <Input
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      placeholder={t("brandPlaceholder")}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("unitLabel")}</Label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className={selectClass}
                  >
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("descriptionLabel")}</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("descriptionPlaceholder")}
                    className={`min-h-[72px] ${inputClass}`}
                  />
                </div>
              </div>

              {/* Pricing */}
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("sectionPricing")}
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("costPriceLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={costPrice}
                      onChange={(e) => setCostPrice(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("sellingPriceLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={sellingPrice}
                      onChange={(e) => setSellingPrice(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("taxRateLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={taxRate}
                      onChange={(e) => setTaxRate(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>

              {/* Inventory */}
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("sectionInventory")}
                </p>
                {isEdit && product ? (
                  <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                    {t("currentStockHint", { stock: product.current_stock, unit })}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("openingStockLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={openingStock}
                      onChange={(e) => setOpeningStock(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("reorderLevelLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={reorderLevel}
                      onChange={(e) => setReorderLevel(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("maxStockLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={maxStockLevel}
                      onChange={(e) => setMaxStockLevel(e.target.value)}
                      placeholder={t("maxStockPlaceholder")}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("activeLabel")}</p>
                  <p className="text-xs text-muted-foreground">{t("activeHint")}</p>
                </div>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/50 bg-popover p-4">
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
                disabled={saving || checkingSku || (!isEdit && skuTaken)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? t("update") : t("create")}
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
