"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { Appointment, Profile } from "@/types";
import { durationMinutes, formatConflictMessage, validateTimeRange } from "@/lib/appointments/scheduling";
import {
  checkAppointmentConflicts,
  rescheduleAppointment,
  suggestAvailableSlots,
} from "@/lib/appointments/api";
import { loadStaffList } from "@/lib/appointments/queries";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2 } from "lucide-react";

interface RescheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: Appointment | null;
  onRescheduled: (appointment: Appointment) => void;
}

const inputClass = "border-border bg-muted text-foreground placeholder:text-muted-foreground";

function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toLocalTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Dedicated "Reschedule Appointment" action (spec item 10) — fast,
 *  focused dialog: new date/time/staff, immediate conflict feedback,
 *  suggested alternative slots. Calls the `reschedule_appointment` RPC
 *  (same row, new schedule — history preserved as an event, not a new
 *  appointment). */
export function RescheduleDialog({ open, onOpenChange, appointment, onRescheduled }: RescheduleDialogProps) {
  const t = useTranslations("Appointments.reschedule");
  const supabase = createClient();
  const { isAdmin, isOwner } = useAuth();
  const canOverride = isAdmin || isOwner;

  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [staffList, setStaffList] = useState<Profile[]>([]);
  const [conflict, setConflict] = useState<{ start: string; end: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [suggestions, setSuggestions] = useState<{ slot_start: string; slot_end: string }[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !appointment) return;
    setStaffId(appointment.staff_id ?? "");
    setDate(toLocalDateInput(appointment.start_at));
    setStartTime(toLocalTimeInput(appointment.start_at));
    setEndTime(toLocalTimeInput(appointment.end_at));
    setConflict(null);
    setSuggestions([]);
    setOverrideReason("");
    loadStaffList(supabase).then(setStaffList).catch(() => {});
  }, [open, appointment, supabase]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const startAt = date && startTime ? new Date(`${date}T${startTime}:00`) : null;
  const endAt = date && endTime ? new Date(`${date}T${endTime}:00`) : null;
  // Plain numbers, not the Date objects themselves — a fresh Date is
  // constructed every render, which isn't a "simple expression" a
  // dependency array can statically compare (see useMemo below).
  const startAtMs = startAt?.getTime();
  const endAtMs = endAt?.getTime();
  const duration = startAt && endAt ? durationMinutes(startAt, endAt) : 0;
  const staffName = staffList.find((s) => s.id === staffId)?.full_name || t("staffFallback");

  /* eslint-disable react-hooks/set-state-in-effect -- same reasoning
     as AppointmentForm's identical conflict-check effect: the banner
     and spinner must clear/arm immediately on selection change, ahead
     of the debounced check. */
  useEffect(() => {
    if (!open || !appointment || !staffId || !startAt || !endAt || endAt <= startAt) {
      setConflict(null);
      setSuggestions([]);
      return;
    }
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const rows = await checkAppointmentConflicts(
          supabase,
          staffId,
          startAt.toISOString(),
          endAt.toISOString(),
          appointment.id,
        );
        if (rows.length > 0) {
          setConflict({ start: rows[0].start_at, end: rows[0].end_at });
          const alt = await suggestAvailableSlots(supabase, staffId, date, duration || 30, 4);
          setSuggestions(alt);
        } else {
          setConflict(null);
          setSuggestions([]);
        }
      } finally {
        setChecking(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, staffId, startAtMs, endAtMs]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const canSave = useMemo(
    () => !!staffId && !!startAt && !!endAt && endAt > startAt && (!conflict || (canOverride && overrideReason.trim())),
    // startAt/endAt are intentionally omitted — they're fresh Date
    // objects every render, so their .getTime() values (startAtMs/
    // endAtMs) are the real, stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staffId, startAtMs, endAtMs, conflict, canOverride, overrideReason],
  );

  function applySuggestion(slot: { slot_start: string; slot_end: string }) {
    setStartTime(toLocalTimeInput(slot.slot_start));
    setEndTime(toLocalTimeInput(slot.slot_end));
  }

  async function handleSave() {
    if (!appointment || !startAt || !endAt) return;
    try {
      validateTimeRange(startAt, endAt);
    } catch {
      toast.error(t("invalidTimeRange"));
      return;
    }
    setSaving(true);
    try {
      const updated = await rescheduleAppointment(supabase, {
        appointmentId: appointment.id,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        staffId,
        overrideReason: conflict ? overrideReason.trim() : null,
      });
      toast.success(t("toastSuccess"));
      onOpenChange(false);
      onRescheduled(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastError"));
    } finally {
      setSaving(false);
    }
  }

  if (!appointment) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("currentSlot", {
              date: new Date(appointment.start_at).toLocaleDateString(),
              start: toLocalTimeInput(appointment.start_at),
              end: toLocalTimeInput(appointment.end_at),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("staffLabel")}</Label>
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
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
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("startLabel")}</Label>
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputClass} />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("endLabel")}</Label>
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={inputClass} />
            </div>
          </div>

          {checking && <p className="text-xs text-muted-foreground">{t("checkingAvailability")}</p>}

          {conflict && (
            <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{formatConflictMessage(staffName, conflict)}</span>
              </div>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.slot_start}
                      type="button"
                      onClick={() => applySuggestion(s)}
                      className="rounded-full border border-red-500/40 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-500/20"
                    >
                      {toLocalTimeInput(s.slot_start)}
                    </button>
                  ))}
                </div>
              )}
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
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
