import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useApiResource } from "./useApiResource";
import { ApiError, getToken, setToken } from "./api";

describe("useApiResource", () => {
  beforeEach(() => localStorage.clear());

  it("sets data on success", async () => {
    const { result } = renderHook(() =>
      useApiResource(() => Promise.resolve({ ok: 1 }), [], () => {}),
    );
    await waitFor(() => expect(result.current.data).toEqual({ ok: 1 }));
    expect(result.current.error).toBeNull();
  });

  it("clears the token and calls onAuthError on a 401", async () => {
    setToken("abc");
    const onAuthError = vi.fn();
    renderHook(() =>
      useApiResource(() => Promise.reject(new ApiError(401, "unauthorized")), [], onAuthError),
    );
    await waitFor(() => expect(onAuthError).toHaveBeenCalledOnce());
    expect(getToken()).toBeNull();
  });

  it("surfaces non-401 errors without logging out", async () => {
    const onAuthError = vi.fn();
    const { result } = renderHook(() =>
      useApiResource(() => Promise.reject(new ApiError(500, "boom")), [], onAuthError),
    );
    await waitFor(() => expect(result.current.error).toContain("boom"));
    expect(onAuthError).not.toHaveBeenCalled();
  });
});
