"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Product, StockStatus } from "@/types";
import {
  loadProductCategories,
  loadProducts,
  loadProductSummary,
  type ProductListResult,
  type ProductSortField,
  type ProductSummary,
} from "@/lib/products/queries";
import { formatCurrency } from "@/lib/currency";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { MetricCard } from "@/components/dashboard/metric-card";
import { ProductForm } from "@/components/products/product-form";
import { StockAdjustDialog } from "@/components/products/stock-adjust-dialog";
import { StockHistorySheet } from "@/components/products/stock-history-sheet";
import { StockStatusBadge } from "@/components/products/stock-status-badge";
import { ProductImage } from "@/components/products/product-image";
import { getStockStatus } from "@/lib/products/stock";
import {
  Search,
  Plus,
  MoreHorizontal,
  Pencil,
  Loader2,
  Package,
  PackageCheck,
  AlertTriangle,
  PackageX,
  Wallet,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  History,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Power,
} from "lucide-react";

const PAGE_SIZE = 25;

/** Clickable column header for the sortable columns. Declared outside
 *  the page component so it isn't recreated on every render — it just
 *  reflects the parent's current sort state via props. */
function SortHeader({
  field,
  label,
  sortField,
  sortAscending,
  onToggle,
}: {
  field: ProductSortField;
  label: string;
  sortField: ProductSortField;
  sortAscending: boolean;
  onToggle: (field: ProductSortField) => void;
}) {
  const active = sortField === field;
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      {label}
      {active ? (
        sortAscending ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-40" />
      )}
    </button>
  );
}

export default function ProductsPage() {
  const t = useTranslations("Products.page");
  const supabase = createClient();
  const { defaultCurrency } = useAuth();
  const canManage = useCan("send-messages");

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("");
  const [stockStatus, setStockStatus] = useState<StockStatus | "">("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const [sortField, setSortField] = useState<ProductSortField>("created_at");
  const [sortAscending, setSortAscending] = useState(false);

  const [categories, setCategories] = useState<string[]>([]);

  const [summary, setSummary] = useState<ProductSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  // Dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Product | null>(null);
  const [togglingActive, setTogglingActive] = useState(false);

  // Guards against out-of-order responses when filters change quickly
  // (same pattern as the Contacts page's fetchSeq).
  const fetchSeq = useRef(0);

  const fetchProducts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const result: ProductListResult = await loadProducts(supabase, {
        search,
        category: category || null,
        stockStatus: stockStatus || null,
        isActive: activeFilter === "all" ? null : activeFilter === "active",
        sortField,
        sortAscending,
        page,
        pageSize: PAGE_SIZE,
      });
      if (seq !== fetchSeq.current) return;
      setProducts(result.items);
      setTotalCount(result.totalCount);
    } catch {
      if (seq !== fetchSeq.current) return;
      toast.error(t("toastFailedLoad"));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [supabase, search, category, stockStatus, activeFilter, sortField, sortAscending, page, t]);

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      setSummary(await loadProductSummary(supabase));
    } catch {
      // Summary is a nice-to-have strip — fail silently, the list
      // below still tells the full story.
    } finally {
      setSummaryLoading(false);
    }
  }, [supabase]);

  const fetchCategories = useCallback(async () => {
    try {
      setCategories(await loadProductCategories(supabase));
    } catch {
      // non-critical
    }
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSummary();
    fetchCategories();
  }, [fetchSummary, fetchCategories]);

  function resetToFirstPage() {
    setPage(0);
  }

  function openAddForm() {
    setEditProduct(null);
    setFormOpen(true);
  }

  function openEditForm(product: Product) {
    setEditProduct(product);
    setFormOpen(true);
  }

  function openAdjust(product: Product) {
    setAdjustProduct(product);
    setAdjustOpen(true);
  }

  function openHistory(product: Product) {
    setHistoryProduct(product);
    setHistoryOpen(true);
  }

  async function handleToggleActive() {
    if (!toggleTarget) return;
    setTogglingActive(true);
    const nextActive = !toggleTarget.is_active;
    const { error } = await supabase
      .from("products")
      .update({ is_active: nextActive })
      .eq("id", toggleTarget.id);
    setTogglingActive(false);
    if (error) {
      toast.error(t("toastFailedToggle"));
      return;
    }
    toast.success(nextActive ? t("toastActivated") : t("toastDeactivated"));
    setToggleTarget(null);
    fetchProducts();
    fetchSummary();
  }

  function toggleSort(field: ProductSortField) {
    if (field === sortField) {
      setSortAscending((prev) => !prev);
    } else {
      setSortField(field);
      setSortAscending(field === "name" || field === "sku");
    }
    resetToFirstPage();
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const hasActiveFilters =
    search.trim().length > 0 || !!category || !!stockStatus || activeFilter !== "all";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount > 0 ? t("subtitle", { count: totalCount }) : t("subtitleZero")}
          </p>
        </div>
        <GatedButton
          canAct={canManage}
          gateReason="add products"
          onClick={openAddForm}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="size-4" />
          {t("addProductBtn")}
        </GatedButton>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {summaryLoading || !summary ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-xl border border-border bg-card" />
          ))
        ) : (
          <>
            <MetricCard title={t("totalProducts")} value={summary.totalProducts.toLocaleString()} icon={Package} />
            <MetricCard title={t("activeProducts")} value={summary.activeProducts.toLocaleString()} icon={PackageCheck} />
            <MetricCard title={t("lowStock")} value={summary.lowStockCount.toLocaleString()} icon={AlertTriangle} />
            <MetricCard title={t("outOfStock")} value={summary.outOfStockCount.toLocaleString()} icon={PackageX} />
            <MetricCard
              title={t("inventoryValue")}
              value={formatCurrency(summary.inventoryValue, defaultCurrency)}
              icon={Wallet}
            />
          </>
        )}
      </div>

      {/* Search + filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetToFirstPage();
            }}
            placeholder={t("searchPlaceholder")}
            className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            resetToFirstPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">{t("allCategories")}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={stockStatus}
          onChange={(e) => {
            setStockStatus(e.target.value as StockStatus | "");
            resetToFirstPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">{t("allStockStatus")}</option>
          <option value="in_stock">{t("stockStatus.in_stock")}</option>
          <option value="low_stock">{t("stockStatus.low_stock")}</option>
          <option value="out_of_stock">{t("stockStatus.out_of_stock")}</option>
        </select>

        <select
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value as "all" | "active" | "inactive");
            resetToFirstPage();
          }}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="all">{t("allStatuses")}</option>
          <option value="active">{t("activeOnly")}</option>
          <option value="inactive">{t("inactiveOnly")}</option>
        </select>

        {hasActiveFilters && (
          <button
            onClick={() => {
              setSearch("");
              setCategory("");
              setStockStatus("");
              setActiveFilter("all");
              resetToFirstPage();
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <SlidersHorizontal className="size-3" />
            {t("clearFilters")}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">
                <SortHeader
                  field="name"
                  label={t("tableColumns.product")}
                  sortField={sortField}
                  sortAscending={sortAscending}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">
                <SortHeader
                  field="sku"
                  label={t("tableColumns.sku")}
                  sortField={sortField}
                  sortAscending={sortAscending}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">
                {t("tableColumns.category")}
              </TableHead>
              <TableHead className="text-muted-foreground text-right">
                <SortHeader
                  field="selling_price"
                  label={t("tableColumns.sellingPrice")}
                  sortField={sortField}
                  sortAscending={sortAscending}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="text-muted-foreground text-right hidden md:table-cell">
                <SortHeader
                  field="cost_price"
                  label={t("tableColumns.costPrice")}
                  sortField={sortField}
                  sortAscending={sortAscending}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="text-muted-foreground text-right">
                <SortHeader
                  field="current_stock"
                  label={t("tableColumns.stock")}
                  sortField={sortField}
                  sortAscending={sortAscending}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="text-muted-foreground text-right hidden lg:table-cell">
                {t("tableColumns.reorderLevel")}
              </TableHead>
              <TableHead className="text-muted-foreground">{t("tableColumns.status")}</TableHead>
              <TableHead className="text-muted-foreground hidden sm:table-cell">
                {t("tableColumns.active")}
              </TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={10} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : products.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={10} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Package className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters ? t("noProductsMatch") : t("noProductsYet")}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canManage}
                        gateReason="add products"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t("addFirstProduct")}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              products.map((product) => {
                const status = getStockStatus(product.current_stock, product.reorder_level);
                return (
                  <TableRow key={product.id} className="border-border hover:bg-muted/50">
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <ProductImage src={product.image_url} alt={product.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{product.name}</p>
                          <p className="truncate text-xs text-muted-foreground md:hidden">
                            {product.sku}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs hidden md:table-cell">
                      {product.sku}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm hidden lg:table-cell">
                      {product.category || <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="text-foreground text-right tabular-nums">
                      {formatCurrency(product.selling_price, defaultCurrency)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums hidden md:table-cell">
                      {formatCurrency(product.cost_price, defaultCurrency)}
                    </TableCell>
                    <TableCell className="text-foreground text-right tabular-nums">
                      {product.current_stock} {product.unit}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums hidden lg:table-cell">
                      {product.reorder_level}
                    </TableCell>
                    <TableCell>
                      <StockStatusBadge status={status} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          product.is_active
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {product.is_active ? t("activeOnly") : t("inactiveOnly")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-popover border-border">
                          <DropdownMenuItem
                            onClick={() => openAdjust(product)}
                            disabled={!canManage}
                            className="text-popover-foreground focus:bg-muted focus:text-foreground"
                          >
                            <SlidersHorizontal className="size-4" />
                            {t("adjustStockAction")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => openHistory(product)}
                            className="text-popover-foreground focus:bg-muted focus:text-foreground"
                          >
                            <History className="size-4" />
                            {t("viewHistoryAction")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-border" />
                          <DropdownMenuItem
                            onClick={() => openEditForm(product)}
                            disabled={!canManage}
                            className="text-popover-foreground focus:bg-muted focus:text-foreground"
                          >
                            <Pencil className="size-4" />
                            {t("editAction")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setToggleTarget(product)}
                            disabled={!canManage}
                            variant={product.is_active ? "destructive" : "default"}
                          >
                            <Power className="size-4" />
                            {product.is_active ? t("deactivateAction") : t("activateAction")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t("showingPagination", {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {t("pageCount", { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create / Edit */}
      <ProductForm
        open={formOpen}
        onOpenChange={setFormOpen}
        product={editProduct}
        onSaved={() => {
          fetchProducts();
          fetchSummary();
          fetchCategories();
        }}
      />

      {/* Quick stock adjustment */}
      <StockAdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        product={adjustProduct}
        onAdjusted={() => {
          fetchProducts();
          fetchSummary();
        }}
      />

      {/* Stock history */}
      <StockHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} product={historyProduct} />

      {/* Deactivate / activate confirmation */}
      <Dialog open={!!toggleTarget} onOpenChange={(o) => !o && setToggleTarget(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {toggleTarget?.is_active ? t("deactivateTitle") : t("activateTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {toggleTarget?.is_active
                ? t("deactivateDesc", { name: toggleTarget?.name ?? "" })
                : t("activateDesc", { name: toggleTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setToggleTarget(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              variant={toggleTarget?.is_active ? "destructive" : "default"}
              onClick={handleToggleActive}
              disabled={togglingActive}
            >
              {togglingActive && <Loader2 className="size-4 animate-spin" />}
              {toggleTarget?.is_active ? t("deactivateBtn") : t("activateBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
