import { createHash, randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

initializeApp();

const db = getFirestore();
const clientId = defineString("ONSHAPE_CLIENT_ID");
const clientSecret = defineSecret("ONSHAPE_CLIENT_SECRET");
const redirectUri = defineString("ONSHAPE_REDIRECT_URI");
const appOrigin = defineString("APP_ORIGIN");
const storageBucket = defineString("STORAGE_BUCKET", { default: "" });
const apiVersion = defineString("ONSHAPE_API_VERSION", { default: "v16" });

const OAUTH_AUTHORIZE_URL = "https://oauth.onshape.com/oauth/authorize";
const OAUTH_TOKEN_URL = "https://oauth.onshape.com/oauth/token";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EXPORT_BYTES = 250 * 1024 * 1024;
const EXPORT_RESULT_TIMEOUT_MS = 2 * 60 * 1000;
const EXPORT_RESULT_POLL_MS = 1_000;

type ExportKind = "dxf" | "step";
type SelectionType = "FACE" | "BODY";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Timestamp;
  expiresAt: Timestamp;
  server: string;
  user: { id: string; name: string; email?: string };
}

interface ExportBody {
  kind: ExportKind;
  friendlyName: string;
  quantity: number;
  machiningType: "laser" | "plasma" | "waterjet" | "3d printed";
  material?: "wood" | "aluminum" | "steel" | "SRPP" | "polycarb" | "carbon fiber";
  subsystem?: string;
  context: {
    documentId: string;
    workspaceOrVersion: "w" | "v";
    workspaceOrVersionId: string;
    elementId: string;
    server: string;
    configuration?: string;
    onshapeUserId?: string;
  };
  selection: {
    entityType: SelectionType;
    selectionId: string;
    partId?: string;
    name?: string;
  };
}

function normalizedConfiguredOrigin(): string {
  return new URL(appOrigin.value()).origin;
}

function setCors(req: Request, res: Response): boolean {
  const configured = normalizedConfiguredOrigin();
  const origin = req.get("origin");
  if (origin === configured) {
    res.set("Access-Control-Allow-Origin", configured);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(origin === configured ? 204 : 403).send();
    return true;
  }
  return false;
}

function routePath(req: Request): string {
  const path = req.path.replace(/\/+$/, "") || "/";
  return path.startsWith("/api/") ? path.slice(4) : path;
}

function safeOnshapeOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing Onshape server.");
  const url = new URL(value);
  const validHost = url.hostname === "onshape.com" || url.hostname.endsWith(".onshape.com");
  if (url.protocol !== "https:" || !validHost || url.username || url.password) {
    throw new Error("Invalid Onshape server.");
  }
  return url.origin;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(req: Request): string {
  const match = req.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new HttpError(401, "Connect your Onshape account first.");
  return match[1];
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function exchangeToken(parameters: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({
    ...parameters,
    client_id: clientId.value(),
    client_secret: clientSecret.value(),
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const payload = (await response.json().catch(() => null)) as Partial<TokenResponse> & { error_description?: string } | null;
  if (!response.ok || !payload?.access_token) {
    throw new HttpError(502, payload?.error_description ?? "Onshape authorization failed.");
  }
  return payload as TokenResponse;
}

async function refreshSessionAccessToken(session: StoredSession, sessionId: string): Promise<void> {
  const refreshed = await exchangeToken({ grant_type: "refresh_token", refresh_token: session.refreshToken });
  session.accessToken = refreshed.access_token;
  session.refreshToken = refreshed.refresh_token ?? session.refreshToken;
  session.accessExpiresAt = Timestamp.fromMillis(Date.now() + (refreshed.expires_in ?? 3600) * 1000);
  await db.collection("onshapeSessions").doc(sessionId).update({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function authorizedOnshapeFetch(
  url: string,
  init: RequestInit,
  session: StoredSession,
  sessionId: string,
): Promise<globalThis.Response> {
  const invoke = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
  let response = await invoke(session.accessToken);
  if (response.status === 401) {
    await refreshSessionAccessToken(session, sessionId);
    response = await invoke(session.accessToken);
  }
  return response;
}

async function loadSession(req: Request): Promise<{ id: string; data: StoredSession }> {
  const id = tokenHash(bearerToken(req));
  const ref = db.collection("onshapeSessions").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError(401, "Your Onshape connection has expired. Connect again.");
  const data = snapshot.data() as StoredSession;
  if (data.expiresAt.toMillis() <= Date.now()) {
    await ref.delete();
    throw new HttpError(401, "Your Onshape connection has expired. Connect again.");
  }
  if (data.accessExpiresAt.toMillis() <= Date.now() + 60_000) {
    const refreshed = await exchangeToken({ grant_type: "refresh_token", refresh_token: data.refreshToken });
    data.accessToken = refreshed.access_token;
    data.refreshToken = refreshed.refresh_token ?? data.refreshToken;
    data.accessExpiresAt = Timestamp.fromMillis(Date.now() + (refreshed.expires_in ?? 3600) * 1000);
    await ref.update({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { id, data };
}

function readString(value: unknown, label: string, maxLength = 100): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required.`);
  const clean = value.trim();
  if (clean.length > maxLength || /[\u0000-\u001f]/.test(clean)) throw new HttpError(400, `${label} is invalid.`);
  return clean;
}

function readOptionalString(value: unknown, label: string, maxLength = 100): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return readString(value, label, maxLength);
}

function readId(value: unknown, label: string): string {
  const id = readString(value, label, 512);
  if (!/^[A-Za-z0-9_+\-=:.,]+$/.test(id)) throw new HttpError(400, `${label} is invalid.`);
  return id;
}

function parseExportBody(value: unknown): ExportBody {
  if (!value || typeof value !== "object") throw new HttpError(400, "A JSON request body is required.");
  const body = value as Partial<ExportBody>;
  const kind = body.kind;
  if (kind !== "dxf" && kind !== "step") throw new HttpError(400, "Export type must be DXF or STEP.");
  const expectedType: SelectionType = kind === "dxf" ? "FACE" : "BODY";
  if (!body.context || !body.selection || body.selection.entityType !== expectedType) {
    throw new HttpError(400, `Select exactly one ${kind === "dxf" ? "face" : "part"}.`);
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, "Quantity must be between 1 and 999.");
  const machining = kind === "step" ? "3d printed" : body.machiningType;
  if (kind === "dxf" && !["laser", "plasma", "waterjet"].includes(String(machining))) {
    throw new HttpError(400, "Choose a valid machining type.");
  }
  const validMaterials = ["wood", "aluminum", "steel", "SRPP", "polycarb", "carbon fiber"];
  if (kind === "dxf" && !validMaterials.includes(String(body.material))) throw new HttpError(400, "Choose a valid material.");
  const wv = body.context.workspaceOrVersion;
  if (wv !== "w" && wv !== "v") throw new HttpError(400, "Invalid workspace or version type.");

  return {
    kind,
    friendlyName: readString(body.friendlyName, "Friendly name", 80),
    quantity,
    machiningType: machining as ExportBody["machiningType"],
    material: kind === "dxf" ? body.material : undefined,
    subsystem: kind === "dxf" ? readOptionalString(body.subsystem, "Subsystem", 80) : undefined,
    context: {
      documentId: readId(body.context.documentId, "Document ID"),
      workspaceOrVersion: wv,
      workspaceOrVersionId: readId(body.context.workspaceOrVersionId, "Workspace or version ID"),
      elementId: readId(body.context.elementId, "Element ID"),
      server: safeOnshapeOrigin(body.context.server),
      configuration: readOptionalString(body.context.configuration, "Configuration", 2000),
      onshapeUserId: readOptionalString(body.context.onshapeUserId, "Onshape user ID", 128),
    },
    selection: {
      entityType: expectedType,
      selectionId: readId(body.selection.selectionId, "Selection ID"),
      partId: body.selection.partId ? readId(body.selection.partId, "Part ID") : undefined,
      name: readOptionalString(body.selection.name, "Selection name", 120),
    },
  };
}

function safeFileStem(value: string): string {
  const stem = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return stem || "part";
}

async function callOnshapeExport(body: ExportBody, session: StoredSession, sessionId: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (body.context.server !== session.server) throw new HttpError(400, "The selected document does not match the connected Onshape server.");
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = body.context;
  const version = apiVersion.value().replace(/^\//, "");
  const endpoint = `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}/translations`;
  const selectedId = body.kind === "dxf" ? body.selection.selectionId : body.selection.partId ?? body.selection.selectionId;
  const payload: Record<string, unknown> = {
    formatName: body.kind.toUpperCase(),
    partIds: selectedId,
    storeInDocument: false,
    translate: true,
    ...(configuration ? { configuration } : {}),
  };
  if (body.kind === "dxf") {
    Object.assign(payload, {
      flatten: true,
      splinesAsPolylines: false,
    });
  }

  let response = await authorizedOnshapeFetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/octet-stream, application/json",
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(payload),
    redirect: "follow",
  }, session, sessionId);

  let resultUrl: string | undefined;
  const deadline = Date.now() + EXPORT_RESULT_TIMEOUT_MS;
  while (true) {
    if (!response.ok) {
      const retryable = Boolean(resultUrl) && [404, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (retryable && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, EXPORT_RESULT_POLL_MS));
        response = await authorizedOnshapeFetch(resultUrl!, {
          method: "GET",
          headers: { Accept: "application/octet-stream, application/json" },
          redirect: "follow",
        }, session, sessionId);
        continue;
      }
      const errorText = await response.text();
      let detail = errorText.slice(0, 500);
      try {
        const parsed = JSON.parse(errorText) as { message?: string; error?: string };
        detail = parsed.message ?? parsed.error ?? detail;
      } catch { /* Onshape sometimes returns plain text. */ }
      throw new HttpError(response.status >= 400 && response.status < 500 ? 422 : 502, `Onshape could not create this export. ${detail}`.trim());
    }

    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "application/octet-stream";
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EXPORT_BYTES) {
      throw new HttpError(413, "The export is larger than the 250 MB classroom limit.");
    }

    if (!contentType.includes("json") && response.status !== 202 && response.status !== 204) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new HttpError(502, "Onshape returned an empty export.");
      if (bytes.length > MAX_EXPORT_BYTES) throw new HttpError(413, "The export is larger than the 250 MB classroom limit.");
      return { bytes, contentType };
    }

    if (contentType.includes("json")) {
      const metadata = await response.json().catch(() => null) as {
        href?: unknown;
        id?: unknown;
        requestState?: unknown;
        failureReason?: unknown;
        message?: unknown;
        documentId?: unknown;
        resultDocumentId?: unknown;
        resultExternalDataIds?: unknown;
      } | null;
      const state = typeof metadata?.requestState === "string" ? metadata.requestState.toUpperCase() : "";
      if (state === "FAILED") {
        const reason = typeof metadata?.failureReason === "string" ? metadata.failureReason : "The export job failed.";
        throw new HttpError(502, `Onshape could not create this export. ${reason}`);
      }

      const externalIds = Array.isArray(metadata?.resultExternalDataIds)
        ? metadata.resultExternalDataIds.filter((value): value is string => typeof value === "string" && Boolean(value))
        : [];
      if (state === "DONE" && externalIds.length) {
        const resultDocumentId = typeof metadata?.resultDocumentId === "string"
          ? metadata.resultDocumentId
          : typeof metadata?.documentId === "string" ? metadata.documentId : documentId;
        resultUrl = `${session.server}/api/${version}/documents/d/${encodeURIComponent(resultDocumentId)}/externaldata/${encodeURIComponent(externalIds[0])}`;
      } else if (state === "DONE") {
        throw new HttpError(502, "Onshape completed the export but did not provide a downloadable file.");
      } else if (typeof metadata?.href === "string") {
        try {
          const candidate = new URL(metadata.href, session.server);
          safeOnshapeOrigin(candidate.origin);
          resultUrl = candidate.toString();
        } catch {
          throw new HttpError(502, "Onshape returned an invalid export result URL.");
        }
      } else if (typeof metadata?.id === "string") {
        resultUrl = `${session.server}/api/${version}/translations/${encodeURIComponent(metadata.id)}`;
      } else if (!resultUrl && state !== "ACTIVE") {
        const detail = typeof metadata?.message === "string" ? metadata.message : "The response did not contain a result URL.";
        throw new HttpError(502, `Onshape returned incomplete export metadata. ${detail}`);
      }
    }

    if (!resultUrl) throw new HttpError(502, "Onshape did not provide an export result URL.");
    if (Date.now() >= deadline) throw new HttpError(504, "Onshape did not finish the export within two minutes.");
    await new Promise((resolve) => setTimeout(resolve, EXPORT_RESULT_POLL_MS));
    response = await authorizedOnshapeFetch(resultUrl, {
      method: "GET",
      headers: { Accept: "application/octet-stream, application/json" },
      redirect: "follow",
    }, session, sessionId);
  }
}

async function startOAuth(req: Request, res: Response): Promise<void> {
  const returnUrl = new URL(readString(req.query.returnUrl, "Return URL", 4000));
  if (returnUrl.origin !== normalizedConfiguredOrigin()) throw new HttpError(400, "Invalid return URL.");
  returnUrl.hash = "";
  const server = safeOnshapeOrigin(req.query.server);
  const state = randomToken();
  await db.collection("oauthStates").doc(tokenHash(state)).set({
    returnUrl: returnUrl.toString(),
    server,
    expectedUserId: readOptionalString(req.query.userId, "User ID", 128),
    expiresAt: Timestamp.fromMillis(Date.now() + STATE_TTL_MS),
    createdAt: FieldValue.serverTimestamp(),
  });
  const authorize = new URL(OAUTH_AUTHORIZE_URL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId.value());
  authorize.searchParams.set("redirect_uri", redirectUri.value());
  authorize.searchParams.set("state", state);
  res.redirect(authorize.toString());
}

function oauthReturnUrl(returnUrl: string, key: "oauthSession" | "oauthError", value: string): string {
  const target = new URL(returnUrl);
  const fragment = new URLSearchParams();
  fragment.set(key, value);
  target.hash = fragment.toString();
  return target.toString();
}

async function finishOAuth(req: Request, res: Response): Promise<void> {
  const state = readString(req.query.state, "OAuth state", 200);
  const stateRef = db.collection("oauthStates").doc(tokenHash(state));
  const snapshot = await stateRef.get();
  if (!snapshot.exists) throw new HttpError(400, "This authorization request is invalid or has already been used.");
  const stateData = snapshot.data() as { returnUrl: string; server: string; expectedUserId?: string; expiresAt: Timestamp };
  await stateRef.delete();
  if (stateData.expiresAt.toMillis() <= Date.now()) throw new HttpError(400, "This authorization request expired. Try connecting again.");

  if (typeof req.query.error === "string") {
    res.redirect(303, oauthReturnUrl(stateData.returnUrl, "oauthError", `Onshape authorization was denied: ${req.query.error}`));
    return;
  }

  try {
    const code = readString(req.query.code, "Authorization code", 2000);
    const token = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri.value() });
    const profileResponse = await fetch(`${stateData.server}/api/users/sessioninfo`, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });
    if (!profileResponse.ok) throw new HttpError(502, "Could not read the signed-in Onshape user.");
    const profile = await profileResponse.json() as Record<string, unknown>;
    const nestedUser = profile.user && typeof profile.user === "object" ? profile.user as Record<string, unknown> : profile;
    const userId = String(nestedUser.id ?? nestedUser.userId ?? "");
    const userName = String(nestedUser.name ?? nestedUser.displayName ?? nestedUser.email ?? "Onshape user");
    const email = typeof nestedUser.email === "string" ? nestedUser.email : undefined;
    if (!userId) throw new HttpError(502, "Onshape did not return a user ID.");
    if (stateData.expectedUserId && stateData.expectedUserId !== userId) throw new HttpError(403, "The connected account does not match the active Onshape user.");
    if (!token.refresh_token) throw new HttpError(502, "Onshape did not return a refresh token.");

    const sessionToken = randomToken();
    await db.collection("onshapeSessions").doc(tokenHash(sessionToken)).set({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: Timestamp.fromMillis(Date.now() + (token.expires_in ?? 3600) * 1000),
      expiresAt: Timestamp.fromMillis(Date.now() + SESSION_TTL_MS),
      server: stateData.server,
      user: { id: userId, name: userName, ...(email ? { email } : {}) },
      createdAt: FieldValue.serverTimestamp(),
    });
    res.redirect(303, oauthReturnUrl(stateData.returnUrl, "oauthSession", sessionToken));
  } catch (error) {
    console.error(error);
    const message = error instanceof HttpError ? error.message : "Onshape authorization failed.";
    res.redirect(303, oauthReturnUrl(stateData.returnUrl, "oauthError", message));
  }
}

async function disconnectSession(req: Request, res: Response): Promise<void> {
  const id = tokenHash(bearerToken(req));
  await db.collection("onshapeSessions").doc(id).delete();
  res.status(204).send();
}

async function handleExport(req: Request, res: Response): Promise<void> {
  const { id: sessionId, data: session } = await loadSession(req);
  const body = parseExportBody(req.body);
  const { bytes, contentType } = await callOnshapeExport(body, session, sessionId);
  const exportId = db.collection("exports").doc().id;
  const extension = body.kind;
  const fileName = `${safeFileStem(body.friendlyName)}-${exportId.slice(0, 8)}.${extension}`;
  const dateFolder = new Date().toISOString().slice(0, 10);
  const storagePath = `manufacturing/${body.kind}/${dateFolder}/${fileName}`;
  const bucket = getStorage().bucket(storageBucket.value() || undefined);
  const customMetadata: Record<string, string> = {
    exportId,
    friendlyName: body.friendlyName,
    quantity: String(body.quantity),
    machiningType: body.machiningType,
    onshapeUserId: session.user.id,
    onshapeUserName: session.user.name,
    documentId: body.context.documentId,
    elementId: body.context.elementId,
    selectionId: body.selection.selectionId,
    ...(body.material ? { material: body.material } : {}),
    ...(body.subsystem ? { subsystem: body.subsystem } : {}),
  };
  await bucket.file(storagePath).save(bytes, {
    resumable: false,
    contentType,
    metadata: { cacheControl: "private, max-age=0", metadata: customMetadata },
  });
  await db.collection("exports").doc(exportId).set({
    ...body,
    fileName,
    storagePath,
    byteLength: bytes.length,
    contentType,
    requestedBy: session.user,
    sessionId,
    status: "complete",
    createdAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ exportId, storagePath, fileName });
}

async function handler(req: Request, res: Response): Promise<void> {
  if (setCors(req, res)) return;
  const path = routePath(req);
  if (req.method === "GET" && path === "/health") {
    res.json({ ok: true });
    return;
  }
  if (req.method === "GET" && path === "/oauth/start") return startOAuth(req, res);
  if (req.method === "GET" && path === "/oauth/callback") return finishOAuth(req, res);
  if (req.method === "GET" && path === "/session") {
    const { data } = await loadSession(req);
    res.json({ user: data.user });
    return;
  }
  if (req.method === "DELETE" && path === "/session") return disconnectSession(req, res);
  if (req.method === "POST" && path === "/exports") return handleExport(req, res);
  throw new HttpError(404, "Not found.");
}

export const api = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "1GiB",
    maxInstances: 20,
    secrets: [clientSecret],
  },
  async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      console.error(error);
      if (!res.headersSent) res.status(status).json({ error: status === 500 ? "Unexpected server error." : message });
    }
  },
);
