"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed.");
        setLoading(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ backgroundColor: "#06090F" }}>
      <div className="w-full max-w-sm rounded-xl border p-8" style={{ borderColor: "#1A1F2E", backgroundColor: "#0D111D" }}>
        <div className="mb-1 flex items-center gap-2">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold"
            style={{ backgroundColor: "#14BA82", color: "#06090F" }}
          >
            R
          </span>
          <h1 className="text-lg font-semibold" style={{ color: "#F5F7FA" }}>
            Relevance Engineering
          </h1>
        </div>
        <p className="mb-8 text-sm" style={{ color: "#8B93A7" }}>Sign in to continue.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-xs" style={{ color: "#8B93A7" }}>
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ borderColor: "#1A1F2E", backgroundColor: "#06090F", color: "#F5F7FA" }}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs" style={{ color: "#8B93A7" }}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ borderColor: "#1A1F2E", backgroundColor: "#06090F", color: "#F5F7FA" }}
              required
            />
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#EE4542" }} role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg py-2 text-sm font-medium transition disabled:opacity-50"
            style={{ backgroundColor: "#14BA82", color: "#06090F" }}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
