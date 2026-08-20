"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/currency";
import type {
  Appointment,
  AppointmentEvent,
  AppointmentPayment,
  AppointmentProductLine,
  AppointmentServiceLine,
  AppointmentStatus,
  Product,
} from "@/types";
import { loadAppointmentById } from "@/lib/appointments/queries";
import {
  addAppointmentProductLine,
  recordAppointmentPayment,
  removeAppointmentProductLine,
  removeAppointmentServiceLine,
  updateAppointmentStatus,
} from "@/lib/appointments/api";
import { nextStatusOptions } from "@/lib/appointments/status";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ProductLinePicker } from "@/components/appointments/product-line-picker";
import {
  Calendar,
  Check,
  Clock,
  History,
  Loader2,
  MessageCircle,
  Phone,
  Printer,
  SquareArrowOutUpRight,
  Trash2,
  User,
} from "lucide-react";

interface AppointmentDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string | null;
  onEdit: (appointment: Appointment) => void;
  onReschedule: (appointment: Appointment) => void;
  onChanged: () => void;
}

const STATUS_TONE: Record<AppointmentStatus, string> = {
  scheduled: "bg-muted text-foreground",
  confirmed: "bg-primary/10 text-primary",
  checked_in: "bg-primary/10 text-primary",
  in_progress: "bg-amber-500/10 text-amber-400",
  completed: "bg-primary/10 text-primary",
  cancelled: "bg-red-500/15 text-red-400",
  no_show: "bg-red-500/15 text-red-400",
  rescheduled: "bg-muted text-muted-foreground",
};

const EVENT_ICON: Partial<Record<string, typeof History>> = {
  completed: Check,
  cancelled: Trash2,
  checked_in: Clock,
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AppointmentDetailSheet({
  open,
  onOpenChange,
  appointmentId,
  onEdit,
  onReschedule,
  onChanged,
}: AppointmentDetailSheetProps) {
  const t = useTranslations("Appointments.detail");
  const tStatus = useTranslations("Appointments.status");
  const supabase = createClient();
  const { defaultCurrency, isAdmin, isOwner } = useAuth();
  const canManage = useCan("send-messages");
  const isAdminCaller = isAdmin || isOwner;

  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [events, setEvents] = useState<AppointmentEvent[]>([]);
  const [payments, setPayments] = useState<AppointmentPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [cancelPromptOpen, setCancelPromptOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [recordingPayment, setRecordingPayment] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!appointmentId) return;
    setLoading(true);
    try {
      const [appt, evRes, payRes] = await Promise.all([
        loadAppointmentById(supabase, appointmentId),
        supabase
          .from("appointment_events")
          .select("*")
          .eq("appointment_id", appointmentId)
          .order("created_at", { ascending: false }),
        supabase
          .from("appointment_payments")
          .select("*")
          .eq("appointment_id", appointmentId)
          .order("created_at", { ascending: false }),
      ]);
      setAppointment(appt);
      setEvents((evRes.data ?? []) as AppointmentEvent[]);
      setPayments((payRes.data ?? []) as AppointmentPayment[]);
    } catch {
      toast.error(t("toastFailedLoad"));
    } finally {
      setLoading(false);
    }
  }, [supabase, appointmentId, t]);

  useEffect(() => {
    if (!open || !appointmentId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [open, appointmentId, fetchAll]);

  async function handleStatusChange(next: AppointmentStatus) {
    if (!appointment) return;
    if (next === "cancelled") {
      setCancelPromptOpen(true);
      return;
    }
    setStatusBusy(next);
    try {
      await updateAppointmentStatus(supabase, appointment.id, next);
      toast.success(t("toastStatusUpdated"));
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setStatusBusy(null);
    }
  }

  async function confirmCancel() {
    if (!appointment) return;
    setStatusBusy("cancelled");
    try {
      await updateAppointmentStatus(supabase, appointment.id, "cancelled", cancelReason.trim() || null);
      toast.success(t("toastCancelled"));
      setCancelPromptOpen(false);
      setCancelReason("");
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setStatusBusy(null);
    }
  }

  async function handleComplete() {
    if (!appointment) return;
    setCompleting(true);
    try {
      const res = await fetch(`/api/appointments/${appointment.id}/complete`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || t("toastError"));
      toast.success(
        body.whatsapp?.sent
          ? t("toastCompletedWithWhatsApp")
          : t("toastCompletedNoWhatsApp", { reason: body.whatsapp?.reason ?? "" }),
      );
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setCompleting(false);
    }
  }

  async function handleRemoveService(line: AppointmentServiceLine) {
    try {
      await removeAppointmentServiceLine(supabase, line.id);
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    }
  }

  async function handleAddProduct(product: Product) {
    if (!appointment) return;
    try {
      await addAppointmentProductLine(supabase, {
        appointmentId: appointment.id,
        productId: product.id,
        nameSnapshot: product.name,
        quantity: 1,
        unitPrice: product.selling_price,
      });
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    }
  }

  async function handleRemoveProduct(line: AppointmentProductLine) {
    try {
      await removeAppointmentProductLine(supabase, line.id);
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    }
  }

  async function handleRecordPayment() {
    if (!appointment) return;
    const amount = parseFloat(paymentAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error(t("invalidPaymentAmount"));
      return;
    }
    setRecordingPayment(true);
    try {
      await recordAppointmentPayment(supabase, appointment.id, amount, paymentMethod, null);
      toast.success(t("toastPaymentRecorded"));
      setPaymentOpen(false);
      setPaymentAmount("");
      await fetchAll();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setRecordingPayment(false);
    }
  }

  const editable = appointment && !appointment.is_billed;
  const nextOptions = appointment ? nextStatusOptions(appointment.status, isAdminCaller) : [];
  const canComplete =
    appointment &&
    appointment.status !== "completed" &&
    appointment.status !== "cancelled" &&
    (appointment.services?.length ?? 0) > 0;
  const balanceDue = appointment ? Math.max(appointment.total_amount - appointment.amount_paid, 0) : 0;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="bg-popover border-border text-popover-foreground sm:max-w-xl w-full p-0 print:hidden">
          <div className="flex h-full flex-col">
            {loading || !appointment ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : (
              <>
                <SheetHeader className="border-b border-border/50 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <SheetTitle className="text-popover-foreground">{appointment.appointment_number}</SheetTitle>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[appointment.status]}`}
                    >
                      {tStatus(appointment.status)}
                    </span>
                  </div>
                </SheetHeader>

                <div className="flex-1 space-y-5 overflow-y-auto p-4">
                  {/* Customer */}
                  <section className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="flex items-center gap-1.5 font-medium text-foreground">
                          <User className="size-3.5 text-muted-foreground" />
                          {appointment.contact?.name || t("unnamedCustomer")}
                        </p>
                        {appointment.contact?.phone && (
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Phone className="size-3" />
                            {appointment.contact.phone}
                            <MessageCircle
                              className="size-3 text-primary"
                              aria-label={t("whatsappAvailable")}
                            />
                          </p>
                        )}
                      </div>
                      {appointment.contact_id && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          render={<Link href={`/contacts?open=${appointment.contact_id}`} target="_blank" />}
                          title={t("viewProfile")}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <SquareArrowOutUpRight className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </section>

                  {/* Schedule */}
                  <section className="space-y-1 rounded-lg border border-border p-3 text-sm">
                    <p className="flex items-center gap-1.5 text-foreground">
                      <Calendar className="size-3.5 text-muted-foreground" />
                      {fmtTime(appointment.start_at)} – {new Date(appointment.end_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("staffLine", { name: appointment.staff?.full_name || t("unassigned") })}
                    </p>
                  </section>

                  {/* Status actions */}
                  <section className="flex flex-wrap gap-2">
                    {canComplete && (
                      <Button
                        size="sm"
                        disabled={completing || !canManage}
                        onClick={handleComplete}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        {completing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                        {t("completeAction")}
                      </Button>
                    )}
                    {editable && canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onReschedule(appointment)}
                        className="border-border text-muted-foreground hover:bg-muted"
                      >
                        {t("rescheduleAction")}
                      </Button>
                    )}
                    {canManage &&
                      nextOptions
                        .filter((s) => s !== "cancelled")
                        .map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant="outline"
                            disabled={statusBusy === s}
                            onClick={() => handleStatusChange(s)}
                            className="border-border text-muted-foreground hover:bg-muted"
                          >
                            {statusBusy === s && <Loader2 className="size-3.5 animate-spin" />}
                            {tStatus(s)}
                          </Button>
                        ))}
                    {canManage && nextOptions.includes("cancelled") && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setCancelPromptOpen(true)}
                      >
                        {t("cancelAction")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => window.print()}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Printer className="size-3.5" />
                      {t("printBill")}
                    </Button>
                    {editable && canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(appointment)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {t("editAction")}
                      </Button>
                    )}
                  </section>

                  {/* Services */}
                  <section className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {t("sectionServices")}
                    </p>
                    {(appointment.services ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("noServices")}</p>
                    ) : (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {(appointment.services ?? []).map((line) => (
                          <li key={line.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                            <span className="flex-1 truncate text-foreground">
                              {line.name_snapshot} {line.quantity > 1 && `×${line.quantity}`}
                            </span>
                            <span className="text-muted-foreground">{formatCurrency(line.line_total, defaultCurrency)}</span>
                            {editable && canManage && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleRemoveService(line)}
                                className="text-muted-foreground hover:text-red-400"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* Products */}
                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {t("sectionProducts")}
                      </p>
                      {editable && canManage && <ProductLinePicker onPick={handleAddProduct} />}
                    </div>
                    {(appointment.products ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("noProducts")}</p>
                    ) : (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {(appointment.products ?? []).map((line) => (
                          <li key={line.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                            <span className="flex-1 truncate text-foreground">
                              {line.name_snapshot} ×{line.quantity}
                            </span>
                            <span className="text-muted-foreground">{formatCurrency(line.line_total, defaultCurrency)}</span>
                            {editable && canManage && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleRemoveProduct(line)}
                                className="text-muted-foreground hover:text-red-400"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* Billing */}
                  <section className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {t("sectionBilling")}
                    </p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between text-muted-foreground">
                        <span>{t("subtotal")}</span>
                        <span>{formatCurrency(appointment.subtotal_amount, defaultCurrency)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>{t("discount")}</span>
                        <span>-{formatCurrency(appointment.discount_amount, defaultCurrency)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>{t("tax")}</span>
                        <span>{formatCurrency(appointment.tax_amount, defaultCurrency)}</span>
                      </div>
                      <div className="flex justify-between border-t border-border pt-1 font-medium text-foreground">
                        <span>{t("total")}</span>
                        <span>{formatCurrency(appointment.total_amount, defaultCurrency)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>{t("paid")}</span>
                        <span>{formatCurrency(appointment.amount_paid, defaultCurrency)}</span>
                      </div>
                      <div className="flex justify-between font-medium text-foreground">
                        <span>{t("balanceDue")}</span>
                        <span>{formatCurrency(balanceDue, defaultCurrency)}</span>
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPaymentOpen(true)}
                        className="w-full border-border text-muted-foreground hover:bg-muted"
                      >
                        {t("recordPayment")}
                      </Button>
                    )}
                    {payments.length > 0 && (
                      <ul className="space-y-1 pt-1 text-xs text-muted-foreground">
                        {payments.map((p) => (
                          <li key={p.id} className="flex justify-between">
                            <span>{fmtTime(p.created_at)} · {p.method}</span>
                            <span>{formatCurrency(p.amount, defaultCurrency)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* Notes */}
                  {(appointment.customer_notes || appointment.internal_notes) && (
                    <section className="space-y-1 text-sm">
                      {appointment.customer_notes && (
                        <p className="text-muted-foreground">
                          <span className="font-medium text-foreground">{t("customerNotesLabel")}:</span>{" "}
                          {appointment.customer_notes}
                        </p>
                      )}
                      {appointment.internal_notes && (
                        <p className="text-muted-foreground">
                          <span className="font-medium text-foreground">{t("internalNotesLabel")}:</span>{" "}
                          {appointment.internal_notes}
                        </p>
                      )}
                    </section>
                  )}

                  {/* Timeline */}
                  <section className="space-y-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <History className="size-3.5" />
                      {t("sectionTimeline")}
                    </p>
                    <ol className="space-y-2">
                      {events.map((ev) => {
                        const Icon = EVENT_ICON[ev.event_type] ?? Clock;
                        return (
                          <li key={ev.id} className="flex items-start gap-2 text-xs">
                            <Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                            <div>
                              <span className="text-foreground">{t(("events." + ev.event_type) as string)}</span>
                              <span className="ml-1.5 text-muted-foreground">{fmtTime(ev.created_at)}</span>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Cancel confirmation */}
      <Dialog open={cancelPromptOpen} onOpenChange={setCancelPromptOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("cancelTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("cancelDesc")}</DialogDescription>
          </DialogHeader>
          <Input
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder={t("cancelReasonPlaceholder")}
            className="border-border bg-muted text-foreground"
          />
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setCancelPromptOpen(false)} className="border-border text-muted-foreground hover:bg-muted">
              {t("keepAction")}
            </Button>
            <Button variant="destructive" onClick={confirmCancel} disabled={statusBusy === "cancelled"}>
              {statusBusy === "cancelled" && <Loader2 className="size-4 animate-spin" />}
              {t("cancelAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record payment */}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("recordPayment")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("balanceDue")}: {formatCurrency(balanceDue, defaultCurrency)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("amountLabel")}</Label>
              <Input
                type="number"
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("methodLabel")}</Label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="cash">{t("methodCash")}</option>
                <option value="card">{t("methodCard")}</option>
                <option value="bank_transfer">{t("methodBankTransfer")}</option>
                <option value="online">{t("methodOnline")}</option>
                <option value="other">{t("methodOther")}</option>
              </select>
            </div>
          </div>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setPaymentOpen(false)} className="border-border text-muted-foreground hover:bg-muted">
              {t("cancel")}
            </Button>
            <Button onClick={handleRecordPayment} disabled={recordingPayment} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {recordingPayment && <Loader2 className="size-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Printable bill — hidden on screen, shown only via window.print() */}
      {appointment && (
        <div className="hidden print:block print:p-8">
          <h1 className="text-xl font-bold">{appointment.appointment_number}</h1>
          <p>{fmtTime(appointment.start_at)}</p>
          <p className="mt-2">{appointment.contact?.name} — {appointment.contact?.phone}</p>
          <table className="mt-4 w-full text-sm">
            <tbody>
              {(appointment.services ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.name_snapshot} {l.quantity > 1 && `×${l.quantity}`}</td>
                  <td className="text-right">{formatCurrency(l.line_total, defaultCurrency)}</td>
                </tr>
              ))}
              {(appointment.products ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.name_snapshot} ×{l.quantity}</td>
                  <td className="text-right">{formatCurrency(l.line_total, defaultCurrency)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-2 font-medium">{t("subtotal")}</td>
                <td className="pt-2 text-right font-medium">{formatCurrency(appointment.subtotal_amount, defaultCurrency)}</td>
              </tr>
              <tr>
                <td>{t("discount")}</td>
                <td className="text-right">-{formatCurrency(appointment.discount_amount, defaultCurrency)}</td>
              </tr>
              <tr>
                <td>{t("tax")}</td>
                <td className="text-right">{formatCurrency(appointment.tax_amount, defaultCurrency)}</td>
              </tr>
              <tr className="text-base font-bold">
                <td className="pt-2">{t("total")}</td>
                <td className="pt-2 text-right">{formatCurrency(appointment.total_amount, defaultCurrency)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
