"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquare, Trash2, Upload } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/**
 * Sidebar branding — account logo + system title.
 *
 * Lives under Settings → Appearance since it's another "how the app
 * looks" control, but unlike the mode/accent pickers above it's
 * account-wide (not device-scoped) and restricted to admins+ — it
 * writes to `accounts.logo_url` / `accounts.brand_name` (migration
 * 037), which the `accounts_update` RLS policy already gates the
 * same way as `deals-settings.tsx` gates default currency.
 *
 * Non-admins see the current values read-only; there's nothing to
 * save so no disabled form controls to explain.
 */
export function BrandingPanel() {
  const t = useTranslations("Settings.appearance.branding");
  const supabase = createClient();
  const { account, accountId, canEditSettings, profileLoading, refreshProfile } =
    useAuth();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [brandName, setBrandName] = useState("");
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBrandName(account?.brand_name ?? "");
  }, [account?.brand_name]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentLogo =
    previewUrl ?? (!removeLogo ? account?.logo_url ?? null : null);

  const dirty =
    pendingLogo !== null ||
    removeLogo ||
    brandName.trim() !== (account?.brand_name ?? "");

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t("unsupportedImage"), {
        description: t("unsupportedImageDesc"),
      });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t("imageTooLarge"), {
        description: t("imageTooLargeDesc"),
      });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveLogo(false);
  };

  const onRemoveLogo = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(null);
    setPreviewUrl(null);
    setRemoveLogo(true);
  };

  const onSave = async () => {
    if (!accountId || !dirty) return;
    setSaving(true);
    try {
      let nextLogoUrl: string | null = account?.logo_url ?? null;

      if (pendingLogo) {
        const ext = pendingLogo.name.split(".").pop()?.toLowerCase() || "png";
        const path = `${accountId}/logo-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("logos")
          .upload(path, pendingLogo, {
            cacheControl: "3600",
            upsert: true,
            contentType: pendingLogo.type,
          });
        if (uploadError) {
          throw new Error(t("uploadFailed", { message: uploadError.message }));
        }
        const {
          data: { publicUrl },
        } = supabase.storage.from("logos").getPublicUrl(path);
        nextLogoUrl = publicUrl;
      } else if (removeLogo) {
        nextLogoUrl = null;
      }

      const trimmedName = brandName.trim();
      const { error: updateError } = await supabase
        .from("accounts")
        .update({
          logo_url: nextLogoUrl,
          brand_name: trimmedName || null,
        })
        .eq("id", accountId);
      if (updateError) {
        throw new Error(t("saveFailed", { message: updateError.message }));
      }

      setPendingLogo(null);
      setPreviewUrl(null);
      setRemoveLogo(false);
      await refreshProfile();
      toast.success(t("saveSuccess"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canEditSettings || profileLoading || saving;

  return (
    <div className="mt-8 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MessageSquare className="size-4 text-muted-foreground" />
        {t("title")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="max-w-md space-y-5 rounded-lg border border-border bg-card p-4">
        {/* Logo row */}
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
            {currentLogo ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload, not a static asset
              <img
                src={currentLogo}
                alt={t("logoAlt")}
                className="h-full w-full object-contain"
              />
            ) : (
              <MessageSquare className="size-5 text-muted-foreground" />
            )}
          </span>

          <div className="flex flex-1 flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
            >
              <Upload className="size-4" />
              {currentLogo ? t("changeLogo") : t("uploadLogo")}
            </Button>
            {currentLogo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRemoveLogo}
                disabled={disabled}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="size-4" />
                {t("remove")}
              </Button>
            )}
            <p className="w-full text-xs text-muted-foreground">
              {t("logoHint")}
            </p>
          </div>
        </div>

        {/* System title */}
        <div className="space-y-2">
          <Label htmlFor="branding-title" className="text-foreground">
            {t("systemTitle")}
          </Label>
          <Input
            id="branding-title"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder={t("systemTitlePlaceholder")}
            maxLength={80}
            disabled={disabled}
          />
        </div>

        {!canEditSettings && (
          <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
        )}

        {canEditSettings && (
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={disabled || !dirty} size="sm">
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
