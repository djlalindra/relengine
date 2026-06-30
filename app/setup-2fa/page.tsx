"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

type SetupData = {
  secret: string;
  qrCodeUrl: string;
  isNew: boolean;
  instruction: string;
};

export default function SetupTwoFAPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [data, setData] = useState<SetupData | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) { setError("Missing setup token. Add ?token=YOUR_TOTP_SETUP_TOKEN to the URL."); return; }
    fetch(`/api/totp-setup?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Could not load setup data."));
  }, [token]);

  function copySecret() {
    if (!data) return;
    navigator.clipboard.writeText(data.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-8 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] text-sm font-bold">
            R
          </span>
          <h1 className="text-lg font-semibold text-[var(--foreground)]">Set up 2FA</h1>
        </div>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Scan the QR code with Google Authenticator to link your account.
        </p>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {data && (
          <div className="space-y-6">
            {/* QR Code */}
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.qrCodeUrl}
                alt="TOTP QR Code"
                width={256}
                height={256}
                className="rounded-lg border border-[var(--border)]"
              />
            </div>

            {/* Manual secret */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-[var(--muted)]">
                Can&apos;t scan? Enter this secret manually:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg border border-[var(--border)] bg-slate-50 px-3 py-2 text-sm font-mono tracking-widest text-[var(--foreground)] select-all">
                  {data.secret}
                </code>
                <button
                  onClick={copySecret}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] transition"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            {/* Instruction */}
            {data.isNew && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <p className="font-semibold mb-1">Action required before signing in:</p>
                <p className="font-mono text-xs break-all">TOTP_SECRET={data.secret}</p>
                <p className="mt-2">Add this to your environment variables and restart the server, then scan the QR code.</p>
              </div>
            )}

            <div className="rounded-lg bg-slate-50 border border-[var(--border)] p-4 space-y-1.5 text-sm text-[var(--muted)]">
              <p className="font-medium text-[var(--foreground)]">Steps:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Open <strong>Google Authenticator</strong> on your phone</li>
                <li>Tap <strong>+</strong> → <strong>Scan a QR code</strong></li>
                <li>Point your camera at the QR code above</li>
                <li>A 6-digit code will appear — use it to sign in</li>
              </ol>
            </div>

            <a
              href="/login"
              className="block w-full rounded-lg bg-[var(--accent)] py-2.5 text-center text-sm font-medium text-white transition hover:bg-blue-700"
            >
              Go to sign in
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
