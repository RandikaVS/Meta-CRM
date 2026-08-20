"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useTranslations } from "next-intl";
import type { Contact } from "@/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Search, SquareArrowOutUpRight, User, X } from "lucide-react";

interface ContactPickerProps {
  value: Contact | null;
  onChange: (contact: Contact | null) => void;
}

/**
 * Fast customer search/autocomplete over the EXISTING Contacts table
 * (spec item 5) — deliberately has no "create new customer" affordance;
 * that stays the Contacts page's job. Selecting a contact surfaces
 * name/phone/email inline and a link to their full profile.
 */
export function ContactPicker({ value, onChange }: ContactPickerProps) {
  const t = useTranslations("Appointments.contactPicker");
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Loading flag flips synchronously so the spinner appears the
    // instant the popover opens / the query changes, not after the
    // debounce timer fires — a legitimate immediate UI response, not
    // a derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const term = search.trim();
    const timer = setTimeout(async () => {
      let query = supabase.from("contacts").select("*").order("name").limit(20);
      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }
      const { data } = await query;
      if (!cancelled) {
        setResults((data ?? []) as Contact[]);
        setLoading(false);
      }
    }, 200); // debounce — matches the search-box feel elsewhere in the app
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, search, supabase]);

  if (value) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/50 p-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {value.name || <span className="italic text-muted-foreground">{t("unnamed")}</span>}
          </p>
          <p className="truncate text-xs text-muted-foreground">{value.phone}</p>
          {value.email && <p className="truncate text-xs text-muted-foreground">{value.email}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            render={<Link href={`/contacts?open=${value.id}`} target="_blank" />}
            title={t("viewProfile")}
            className="text-muted-foreground hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(null)}
            title={t("clear")}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start border-border text-muted-foreground hover:bg-muted"
          />
        }
      >
        <User className="size-4" />
        {t("selectCustomer")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 border-border bg-muted pl-7 text-foreground"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("searching")}
            </div>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("noResults")}</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                  setSearch("");
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-muted/50"
              >
                <span className="truncate text-sm text-popover-foreground">
                  {c.name || t("unnamed")}
                </span>
                <span className="truncate text-xs text-muted-foreground">{c.phone}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
