import { createClient } from "@/lib/supabase/server";

export const DEFAULT_BRAND_NAME = "Style Heaven";

export interface AccountBranding {
  brandName: string;
  /** accounts.logo_url (migration 037) — null means "no override". */
  logoUrl: string | null;
}

const FALLBACK: AccountBranding = {
  brandName: DEFAULT_BRAND_NAME,
  logoUrl: null,
};

/**
 * Server-only lookup of the signed-in user's account branding
 * (accounts.brand_name / logo_url, migration 037).
 *
 * Shared by the root layout's `generateMetadata` (browser tab title)
 * and `app/icon.tsx` (favicon) — both are special files that render
 * before any client React tree exists, so neither can reach the
 * `useAuth()` client hook. This reads the same data straight from the
 * server-side Supabase client using the request's cookies instead.
 *
 * Never throws — any lookup failure (signed out, no account, network
 * error) resolves to the app default so metadata/icon generation
 * can't break the page.
 */
export async function getAccountBranding(): Promise<AccountBranding> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return FALLBACK;

    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!profile?.account_id) return FALLBACK;

    const { data: account } = await supabase
      .from("accounts")
      .select("brand_name, logo_url")
      .eq("id", profile.account_id)
      .maybeSingle();

    return {
      brandName: account?.brand_name || DEFAULT_BRAND_NAME,
      logoUrl: account?.logo_url ?? null,
    };
  } catch (err) {
    console.error("[branding] getAccountBranding failed:", err);
    return FALLBACK;
  }
}
