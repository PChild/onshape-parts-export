import type { ExportRequest, ExportResult, ExportSuggestionsRequest, ExportSuggestionsResult, SessionUser } from "./types";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

export function getApiBase(): string {
  return apiBase;
}

async function apiFetch<T>(path: string, sessionToken: string, init?: RequestInit): Promise<T> {
  if (!apiBase) throw new Error("NEXT_PUBLIC_API_BASE_URL is not configured.");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

export function getSession(sessionToken: string): Promise<{ user: SessionUser }> {
  return apiFetch("/session", sessionToken);
}

export function disconnectSession(sessionToken: string): Promise<void> {
  return apiFetch("/session", sessionToken, { method: "DELETE" });
}

export function createExport(sessionToken: string, request: ExportRequest): Promise<ExportResult> {
  return apiFetch("/exports", sessionToken, { method: "POST", body: JSON.stringify(request) });
}

export function getExportSuggestions(sessionToken: string, request: ExportSuggestionsRequest): Promise<ExportSuggestionsResult> {
  return apiFetch("/export-suggestions", sessionToken, { method: "POST", body: JSON.stringify(request) });
}
