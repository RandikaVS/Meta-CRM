"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/currency";
import type { Service } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2 } from "lucide-react";

interface ServicesManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

/** Create / rename / price / deactivate the bookable-service catalog
 *  (spec item 2 — services need to be a real entity, not a free-text
 *  deal title). Admin-gated by the caller; `services` RLS also
 *  rejects non-admin writes as defense in depth. Mirrors
 *  CustomFieldsManager's shape (dialog wrapping a directly-supabase
 *  panel) since this is the same class of small settings catalog. */
export function ServicesManager({ open, onOpenChange, onChanged }: ServicesManagerProps) {
  const t = useTranslations("Appointments.services");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("0");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase.from("services").select("*").order("name");
    setItems((data as Service[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (open && accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchServices();
    }
  }, [open, accountId, fetchServices]);

  async function handleCreate() {
    const trimmed = name.trim();
    const durationNum = parseInt(duration, 10);
    const priceNum = parseFloat(price);
    if (!trimmed) return;
    if (!Number.isFinite(durationNum) || durationNum <= 0) {
      toast.error(t("invalidDuration"));
      return;
    }
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error(t("invalidPrice"));
      return;
    }
    if (!accountId) return;

    setCreating(true);
    const { error } = await supabase.from("services").insert({
      account_id: accountId,
      name: trimmed,
      duration_minutes: durationNum,
      price: priceNum,
    });
    setCreating(false);

    if (error) {
      toast.error(t("toastCreateFailed"));
      return;
    }
    toast.success(t("toastCreated", { name: trimmed }));
    setName("");
    setDuration("30");
    setPrice("0");
    await fetchServices();
    onChanged?.();
  }

  async function handleToggleActive(service: Service) {
    setBusyId(service.id);
    const { error } = await supabase
      .from("services")
      .update({ is_active: !service.is_active })
      .eq("id", service.id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastUpdateFailed"));
      return;
    }
    await fetchServices();
    onChanged?.();
  }

  async function handleDelete(service: Service) {
    if (!window.confirm(t("deleteConfirm", { name: service.name }))) return;
    setBusyId(service.id);
    const { error } = await supabase.from("services").delete().eq("id", service.id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastDeleteFailed"));
      return;
    }
    toast.success(t("toastDeleted", { name: service.name }));
    await fetchServices();
    onChanged?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_90px_110px_auto] items-end gap-2">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t("nameLabel")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="h-8 bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t("durationLabel")}</label>
              <Input
                type="number"
                min="1"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="h-8 bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t("priceLabel")}</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="h-8 bg-muted text-foreground"
              />
            </div>
            <Button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="h-8 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t("add")}
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("loading")}
              </div>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((service) => (
                  <li key={service.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm font-medium ${service.is_active ? "text-foreground" : "text-muted-foreground line-through"}`}
                      >
                        {service.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("durationMinutes", { minutes: service.duration_minutes })} ·{" "}
                        {formatCurrency(service.price, defaultCurrency)}
                      </p>
                    </div>
                    <Switch
                      checked={service.is_active}
                      onCheckedChange={() => handleToggleActive(service)}
                      disabled={busyId === service.id}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === service.id}
                      onClick={() => handleDelete(service)}
                      title={t("deleteTitle")}
                      className="shrink-0 text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
