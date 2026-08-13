import { ImageResponse } from "next/og";
import { getAccountBranding } from "@/lib/branding";

// Replaces the default Next.js favicon with the brand mark — Hostinger
// violet rounded square + white chat-square glyph — matching the
// sidebar logo in `src/components/layout/sidebar.tsx`. Next.js renders
// this at request time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).
//
// `icon`/`apple-icon` are special Route Handlers, not React components
// — there's no client tree or context above them, so `useAuth()` /
// `useTranslations()` can't be called here (that's a server-can't-
// call-a-client-hook crash, same class as the one in layout.tsx).
// `getAccountBranding()` reads the same account row directly via the
// server-side Supabase client instead. It's also `satori`-rendered
// (the ImageResponse renderer), which doesn't understand Tailwind
// classes — every element below needs inline `style`, not `className`.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";


export default async function Icon() {

    const { logoUrl } = await getAccountBranding();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7c3aed", // primary (Hostinger-aligned purple)
          borderRadius: 6,
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            width={size.width}
            height={size.height}
            style={{ objectFit: "contain", borderRadius: 6 }}
          />

        ) : (
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </div>
    ),
    { ...size },
  );
}
