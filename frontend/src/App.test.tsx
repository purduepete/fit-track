import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { api } from "./lib/api";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("App sign-in gates", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

  it("asks for a Cloudflare sign-in, not a token, when Access blocks the auth check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    render(<App />);
    expect(await screen.findByText(/Sign in with Cloudflare/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/./)).toBeNull();
  });

  it("treats a redirected auth check as a missing Access session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 0, type: "opaqueredirect" }));
    render(<App />);
    expect(await screen.findByText(/Sign in with Cloudflare/)).toBeTruthy();
  });

  it("loads the dashboard after the user returns signed in", async () => {
    vi.spyOn(api, "dashboard").mockReturnValue(new Promise(() => {}));
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValue(json({ gateway: true }));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await screen.findByText(/Sign in with Cloudflare/);
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Dashboard")).toBeTruthy();
  });

  it("shows the token gate only when the server reports token mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ gateway: false })));
    render(<App />);
    expect(await screen.findByText(/Enter your read access token/)).toBeTruthy();
  });
});
