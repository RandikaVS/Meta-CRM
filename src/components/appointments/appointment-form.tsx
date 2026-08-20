"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/currency";
import type { Appointment, Contact, Profile, Service } from "@/types";
import { addMinutes, formatConflictMessage, validateTimeRange } from "@/lib/appointments/scheduling";
import { computeAppointmentTotals, computeLineTotal } from "@/lib/appointments/billing";
import { checkAppointmentConflicts, addAppointmentServiceLine } from "@/lib/appointments/api";
import { loadServices } from "@/lib/services/queries";
import { loadStaffList } from "@/lib/appointments/queries";
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
import { ContactPicker } from "@/components/appointments/contact-picker";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";

interface AppointmentFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment?: Appointment | null;
  defaultContactId?: string | null;
  defaultStaffId?: string | null;
  /** ISO start time, e.g. pre-filled from a calendar slot click. */
  defaultStartAt?: string | null;
  defaultDealId?: string | null;
  onSaved: (appointment: Appointment) => void;
}

interface DraftServiceLine {
  key: string;
  service: Service;
  quantity: number;
  unitPrice: number;
}

const inputClass = "border-border bg-muted text-foreground placeholder:text-muted-foreground";
const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toLocalTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function combineDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00`);
}

/**
 * Create/edit sheet — schedule + who/when only. Services are pickable
 * at creation time (so a fresh appointment can go straight to
 * "at least one service" without a second trip); products, payments,
 * and further service changes live in AppointmentDetailSheet once the
 * appointment exists, matching the spec's split between "schedule the
 * visit" (item 2) and "manage what happened" (item 11).
 */
export function AppointmentForm({
  open,
  onOpenChange,
  appointment,
  defaultContactId,
  defaultStaffId,
  defaultStartAt,
  defaultDealId,
  onSaved,
}: AppointmentFormProps) {
  const t = useTranslations("Appointments.form");
  const supabase = createClient();
  const { accountId, user, isAdmin, isOwner } = useAuth();
  const isEdit = !!appointment;
  const isBilled = appointment?.is_billed ?? false;
  const canOverride = isAdmin || isOwner;

  const [contact, setContact] = useState<Contact | null>(null);
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percentage" | "fixed">("");
  const [discountValue, setDiscountValue] = useState("0");
  const [taxRate, setTaxRate] = useState("0");

  const [staffList, setStaffList] = useState<Profile[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [draftLines, setDraftLines] = useState<DraftServiceLine[]>([]);
  const [addServiceId, setAddServiceId] = useState("");

  const [conflict, setConflict] = useState<{ start: string; end: string } | null>(null);
  const [checkingConflict, setCheckingConflict] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setContact(appointment.contact ?? null);
      setStaffId(appointment.staff_id ?? "");
      setDate(toLocalDateInput(appointment.start_at));
      setStartTime(toLocalTimeInput(appointment.start_at));
      setEndTime(toLocalTimeInput(appointment.end_at));
      setCustomerNotes(appointment.customer_notes ?? "");
      setInternalNotes(appointment.internal_notes ?? "");
      setDiscountType((appointment.discount_type as "percentage" | "fixed") ?? "");
      setDiscountValue(String(appointment.discount_value ?? 0));
      setTaxRate(String(appointment.tax_rate ?? 0));
    } else {
      setContact(null);
      setStaffId(defaultStaffId ?? "");
      const base = defaultStartAt ? new Date(defaultStartAt) : new Date();
      setDate(toLocalDateInput(base.toISOString()));
      setStartTime(toLocalTimeInput(base.toISOString()));
      setEndTime(toLocalTimeInput(addMinutes(base, 30).toISOString()));
      setCustomerNotes("");
      setInternalNotes("");
      setDiscountType("");
      setDiscountValue("0");
      setTaxRate("0");
      setDraftLines([]);
    }
    setConflict(null);
    setOverrideReason("");

    loadStaffList(supabase).then(setStaffList).catch(() => {});
    loadServices(supabase, { activeOnly: true }).then(setServices).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment]);

  useEffect(() => {
    if (!open) return;
    if (defaultContactId && !appointment) {
      supabase
        .from("contacts")
        .select("*")
        .eq("id", defaultContactId)
        .maybeSingle()
        .then(({ data }) => setContact((data as Contact) ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultContactId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const startAt = date && startTime ? combineDateTime(date, startTime) : null;
  const endAt = date && endTime ? combineDateTime(date, endTime) : null;

  // Debounced conflict pre-check (spec item 6) — server-side RPC is
  // still the real backstop (the EXCLUDE constraint), this is purely
  // fast feedback while picking a time.
  /* eslint-disable react-hooks/set-state-in-effect -- clearing/arming
     the conflict banner and its spinner needs to happen the instant
     the staff/time selection changes, ahead of the debounced check
     below, not as a derived value. */
  useEffect(() => {
    if (!open || !staffId || !startAt || !endAt || endAt <= startAt) {
      setConflict(null);
      return;
    }
    setCheckingConflict(true);
    const timer = setTimeout(async () => {
      try {
        const rows = await checkAppointmentConflicts(
          supabase,
          staffId,
          startAt.toISOString(),
          endAt.toISOString(),
          appointment?.id ?? null,
        );
        setConflict(rows.length > 0 ? { start: rows[0].start_at, end: rows[0].end_at } : null);
      } finally {
        setCheckingConflict(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, staffId, startAt?.getTime(), endAt?.getTime()]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const staffName = staffList.find((s) => s.id === staffId)?.full_name || t("staffFallback");

  const totals = useMemo(
    () =>
      computeAppointmentTotals({
        lineTotals: draftLines.map((l) => computeLineTotal({ quantity: l.quantity, unitPrice: l.unitPrice })),
        discountType: discountType || null,
        discountValue: parseFloat(discountValue) || 0,
        taxRate: parseFloat(taxRate) || 0,
      }),
    [draftLines, discountType, discountValue, taxRate],
  );

  function addServiceDraft() {
    const service = services.find((s) => s.id === addServiceId);
    if (!service) return;
    setDraftLines((prev) => [
      ...prev,
      { key: `${service.id}-${Date.now()}`, service, quantity: 1, unitPrice: service.price },
    ]);
    // Nudge the end time forward by the service's duration so the
    // slot reflects what was just picked, unless the user already
    // customised it away from the auto-filled default.
    if (startAt) setEndTime(toLocalTimeInput(addMinutes(startAt, service.duration_minutes).toISOString()));
    setAddServiceId("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!contact) {
      toast.error(t("contactRequired"));
      return;
    }
    if (!staffId) {
      toast.error(t("staffRequired"));
      return;
    }
    if (!startAt || !endAt) {
      toast.error(t("timeRequired"));
      return;
    }
    try {
      validateTimeRange(startAt, endAt);
    } catch {
      toast.error(t("invalidTimeRange"));
      return;
    }
    if (conflict && !(canOverride && overrideReason.trim())) {
      toast.error(t("resolveConflictFirst"));
      return;
    }
    if (!accountId || !user) {
      toast.error(t("notSignedIn"));
      return;
    }

    setSaving(true);
    try {
      const payload = {
        contact_id: contact.id,
        staff_id: staffId,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        customer_notes: customerNotes.trim() || null,
        internal_notes: internalNotes.trim() || null,
        discount_type: discountType || null,
        discount_value: parseFloat(discountValue) || 0,
        tax_rate: parseFloat(taxRate) || 0,
      };

      if (isEdit && appointment) {
        const { error } = await supabase.from("appointments").update(payload).eq("id", appointment.id);
        if (error) throw error;
        toast.success(t("toastUpdated"));
        onOpenChange(false);
        onSaved({ ...appointment, ...payload } as Appointment);
      } else {
        const { data, error } = await supabase
          .from("appointments")
          .insert({
            ...payload,
            account_id: accountId,
            created_by: user.id,
            deal_id: defaultDealId ?? null,
            override_reason: conflict ? overrideReason.trim() : null,
          })
          .select()
          .single();
        if (error) throw error;
        const created = data as Appointment;

        for (const line of draftLines) {
          await addAppointmentServiceLine(supabase, {
            appointmentId: created.id,
            serviceId: line.service.id,
            nameSnapshot: line.service.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            durationMinutes: line.service.duration_minutes,
          });
        }

        toast.success(t("toastCreated"));
        onOpenChange(false);
        onSaved(created);
      }
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr?.code === "23P01") {
        toast.error(t("toastConflict"));
      } else {
        toast.error(pgErr?.message || t("toastError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {isEdit ? t("editTitle") : t("addTitle")}
            </SheetTitle>
          </SheetHeader>

          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-5 overflow-y-auto p-4">
              {isBilled && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  {t("billedNotice")}
                </div>
              )}

              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  {t("customerLabel")} <span className="text-red-400">*</span>
                </Label>
                <ContactPicker value={contact} onChange={setContact} />
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  {t("staffLabel")} <span className="text-red-400">*</span>
                </Label>
                <select
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  disabled={isBilled}
                  className={selectClass}
                >
                  <option value="">{t("selectStaff")}</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name || s.email}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("dateLabel")}</Label>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    disabled={isBilled}
                    className={inputClass}
                  />
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("startLabel")}</Label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    disabled={isBilled}
                    className={inputClass}
                  />
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("endLabel")}</Label>
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    disabled={isBilled}
                    className={inputClass}
                  />
                </div>
              </div>

              {checkingConflict && (
                <p className="text-xs text-muted-foreground">{t("checkingAvailability")}</p>
              )}
              {conflict && (
                <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{formatConflictMessage(staffName, conflict)}</span>
                  </div>
                  {canOverride && (
                    <div className="grid gap-1.5 pt-1">
                      <Label className="text-[11px] text-red-300">{t("overrideReasonLabel")}</Label>
                      <Input
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder={t("overrideReasonPlaceholder")}
                        className="h-8 border-red-500/40 bg-transparent text-foreground"
                      />
                    </div>
                  )}
                </div>
              )}

              {!isEdit && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t("servicesLabel")}</Label>
                  <div className="flex gap-2">
                    <select
                      value={addServiceId}
                      onChange={(e) => setAddServiceId(e.target.value)}
                      className={selectClass}
                    >
                      <option value="">{t("selectService")}</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} — {formatCurrency(s.price)} ({t("durationMinutes", { minutes: s.duration_minutes })})
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={addServiceDraft}
                      disabled={!addServiceId}
                      className="shrink-0 border-border text-muted-foreground hover:bg-muted"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                  {draftLines.length > 0 && (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {draftLines.map((line, i) => (
                        <li key={line.key} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                          <span className="flex-1 truncate text-foreground">{line.service.name}</span>
                          <Input
                            type="number"
                            min="1"
                            value={line.quantity}
                            onChange={(e) =>
                              setDraftLines((prev) =>
                                prev.map((l, idx) =>
                                  idx === i ? { ...l, quantity: parseInt(e.target.value, 10) || 1 } : l,
                                ),
                              )
                            }
                            className="h-7 w-14 border-border bg-muted text-foreground"
                          />
                          <span className="w-20 shrink-0 text-right text-muted-foreground">
                            {formatCurrency(line.unitPrice * line.quantity)}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setDraftLines((prev) => prev.filter((_, idx) => idx !== i))}
                            className="text-muted-foreground hover:text-red-400"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("sectionBilling")}
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("discountTypeLabel")}</Label>
                    <select
                      value={discountType}
                      onChange={(e) => setDiscountType(e.target.value as "" | "percentage" | "fixed")}
                      disabled={isBilled}
                      className={selectClass}
                    >
                      <option value="">{t("discountNone")}</option>
                      <option value="percentage">{t("discountPercentage")}</option>
                      <option value="fixed">{t("discountFixed")}</option>
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">{t("discountValueLabel")}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      disabled={isBilled || !discountType}
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
                      disabled={isBilled}
                      className={inputClass}
                    />
                  </div>
                </div>
                {!isEdit && draftLines.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>{t("subtotal")}</span>
                      <span>{formatCurrency(totals.subtotalAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t("discount")}</span>
                      <span>-{formatCurrency(totals.discountAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t("tax")}</span>
                      <span>{formatCurrency(totals.taxAmount)}</span>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1 font-medium text-foreground">
                      <span>{t("total")}</span>
                      <span>{formatCurrency(totals.totalAmount)}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("customerNotesLabel")}</Label>
                <Textarea
                  value={customerNotes}
                  onChange={(e) => setCustomerNotes(e.target.value)}
                  placeholder={t("customerNotesPlaceholder")}
                  className={`min-h-[60px] ${inputClass}`}
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("internalNotesLabel")}</Label>
                <Textarea
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  placeholder={t("internalNotesPlaceholder")}
                  className={`min-h-[60px] ${inputClass}`}
                />
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
                disabled={saving || checkingConflict}
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
