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
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const EXPORT_RESULT_TIMEOUT_MS = 2 * 60 * 1000;
const EXPORT_RESULT_POLL_MS = 1_000;
const PREVIEW_SIZE = 512;
const ISOMETRIC_VIEW_MATRIX = "0.612,0.612,0,0,-0.354,0.354,0.707,0,0.707,-0.707,0.707,0";

type ExportKind = "dxf" | "step" | "lathe";
type SelectionType = "FACE" | "BODY";
type LatheStockType = "1/2 true hex" | "1/2 rounded hex" | "3/8 true hex" | "3/8 rounded hex" | "round shaft" | "round tube";
type LatheEndOperationType = "leave as modeled" | "turn down" | "tap" | "drill" | "other";

interface LatheEndOperation {
  operation: LatheEndOperationType;
  diameterInches?: number;
  lengthInches?: number;
  thread?: string;
  depthInches?: number;
  notes?: string;
}

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
  machiningType: "laser" | "plasma" | "waterjet" | "3D printed" | "lathe";
  material?: "wood" | "aluminum" | "aluminum 7075" | "steel" | "SRPP" | "polycarb" | "carbon fiber" | "3D Print";
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
  selections: Array<{
    entityType: SelectionType;
    selectionId: string;
    partId?: string;
    name?: string;
  }>;
  lathe?: {
    stockType: LatheStockType;
    diameterInches?: number;
    outerDiameterInches?: number;
    innerDiameterInches?: number;
    endA: LatheEndOperation;
    endB: LatheEndOperation;
    endReference?: string;
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

function readOptionalOnshapeParameter(value: unknown, label: string, maxLength = 100): string | undefined {
  const clean = readOptionalString(value, label, maxLength);
  return clean && !/^\{\$[^{}]+\}$/.test(clean) ? clean : undefined;
}

function readId(value: unknown, label: string): string {
  const id = readString(value, label, 512);
  if (!/^[A-Za-z0-9_+\-=:.,]+$/.test(id)) throw new HttpError(400, `${label} is invalid.`);
  return id;
}

function readPositiveDimension(value: unknown, label: string): number {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension <= 0 || dimension > 100) {
    throw new HttpError(400, `${label} must be greater than 0 and no more than 100 inches.`);
  }
  return dimension;
}

function parseLatheEnd(value: unknown, label: string): LatheEndOperation {
  if (!value || typeof value !== "object") throw new HttpError(400, `${label} instructions are required.`);
  const raw = value as Partial<LatheEndOperation>;
  const validOperations: LatheEndOperationType[] = ["leave as modeled", "turn down", "tap", "drill", "other"];
  if (!validOperations.includes(raw.operation as LatheEndOperationType)) throw new HttpError(400, `Choose a valid operation for ${label}.`);
  const operation = raw.operation as LatheEndOperationType;
  if (operation === "turn down") {
    return {
      operation,
      diameterInches: readPositiveDimension(raw.diameterInches, `${label} target diameter`),
      lengthInches: readPositiveDimension(raw.lengthInches, `${label} turned length`),
    };
  }
  if (operation === "tap") {
    return {
      operation,
      thread: readString(raw.thread, `${label} thread`, 40),
      depthInches: readPositiveDimension(raw.depthInches, `${label} thread depth`),
    };
  }
  if (operation === "drill") {
    return {
      operation,
      diameterInches: readPositiveDimension(raw.diameterInches, `${label} hole diameter`),
      depthInches: readPositiveDimension(raw.depthInches, `${label} hole depth`),
    };
  }
  if (operation === "other") return { operation, notes: readString(raw.notes, `${label} instructions`, 300) };
  return { operation };
}

function parseLatheDetails(value: unknown): NonNullable<ExportBody["lathe"]> {
  if (!value || typeof value !== "object") throw new HttpError(400, "Lathe details are required.");
  const raw = value as Partial<NonNullable<ExportBody["lathe"]>>;
  const validStockTypes: LatheStockType[] = ["1/2 true hex", "1/2 rounded hex", "3/8 true hex", "3/8 rounded hex", "round shaft", "round tube"];
  if (!validStockTypes.includes(raw.stockType as LatheStockType)) throw new HttpError(400, "Choose a valid lathe stock profile.");
  const stockType = raw.stockType as LatheStockType;
  const diameterInches = stockType === "round shaft" ? readPositiveDimension(raw.diameterInches, "Shaft diameter") : undefined;
  const outerDiameterInches = stockType === "round tube" ? readPositiveDimension(raw.outerDiameterInches, "Tube outside diameter") : undefined;
  const innerDiameterInches = stockType === "round tube" ? readPositiveDimension(raw.innerDiameterInches, "Tube inside diameter") : undefined;
  if (outerDiameterInches !== undefined && innerDiameterInches !== undefined && innerDiameterInches >= outerDiameterInches) {
    throw new HttpError(400, "Tube inside diameter must be smaller than its outside diameter.");
  }
  const endA = parseLatheEnd(raw.endA, "End A");
  const endB = parseLatheEnd(raw.endB, "End B");
  const endReference = readOptionalString(raw.endReference, "End identification", 300);
  return {
    stockType,
    diameterInches,
    outerDiameterInches,
    innerDiameterInches,
    endA,
    endB,
    endReference,
  };
}

function parseExportBody(value: unknown): ExportBody {
  if (!value || typeof value !== "object") throw new HttpError(400, "A JSON request body is required.");
  const body = value as Partial<ExportBody> & { selection?: ExportBody["selections"][number] };
  const kind = body.kind;
  if (kind !== "dxf" && kind !== "step" && kind !== "lathe") throw new HttpError(400, "Choose DXF, STEP, or lathe.");
  if (!body.context) throw new HttpError(400, "The Onshape document context is required.");
  const lathe = kind === "lathe" ? parseLatheDetails(body.lathe) : undefined;
  const rawSelections = Array.isArray(body.selections) ? body.selections : body.selection ? [body.selection] : [];
  const selections = rawSelections.map((rawSelection, index) => {
    if (!rawSelection || typeof rawSelection !== "object") throw new HttpError(400, `Selection ${index + 1} is invalid.`);
    const rawSelectionType = String(rawSelection.entityType).toUpperCase();
    const entityType: SelectionType | undefined = rawSelectionType === "FACE" ? "FACE"
        : ["BODY", "PART", "SOLID"].includes(rawSelectionType) ? "BODY" : undefined;
    if (!entityType) throw new HttpError(400, `Selection ${index + 1} has an invalid type.`);
    return {
      entityType,
      selectionId: readId(rawSelection.selectionId, `Selection ${index + 1} ID`),
      partId: rawSelection.partId ? readId(rawSelection.partId, `Selection ${index + 1} part ID`) : undefined,
      name: readOptionalString(rawSelection.name, `Selection ${index + 1} name`, 120),
    };
  });
  if (new Set(selections.map((selection) => selection.selectionId)).size !== selections.length) {
    throw new HttpError(400, "Select distinct geometry for each selection.");
  }
  if (kind === "dxf" && (selections.length !== 1 || selections[0]?.entityType !== "FACE")) {
    throw new HttpError(400, "Select exactly one face for a DXF export.");
  }
  if (kind === "step" && (selections.length !== 1 || !["BODY", "FACE"].includes(selections[0]?.entityType ?? ""))) {
    throw new HttpError(400, "Select exactly one part or face for a STEP export.");
  }
  if (kind === "lathe" && (selections.length !== 2 || selections.some((selection) => selection.entityType !== "FACE"))) {
    throw new HttpError(400, "Select exactly two end faces for the lathe part.");
  }
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, "Quantity must be between 1 and 999.");
  const machining = kind === "step" ? "3d printed" : kind === "lathe" ? "lathe" : body.machiningType;
  if (kind === "dxf" && !["laser", "plasma", "waterjet"].includes(String(machining))) {
    throw new HttpError(400, "Choose a valid machining type.");
  }
  const validDxfMaterialsByMachining: Record<"laser" | "plasma" | "waterjet", string[]> = {
    laser: ["SRPP", "polycarb", "wood"],
    plasma: ["steel", "aluminum"],
    waterjet: ["wood", "aluminum", "steel", "SRPP", "polycarb", "carbon fiber"],
  };
  const validLatheMaterials = ["aluminum 7075", "polycarb", "steel", "carbon fiber"];
  if (kind === "dxf" && !validDxfMaterialsByMachining[machining as "laser" | "plasma" | "waterjet"].includes(String(body.material))) {
    throw new HttpError(400, `Choose a material that can be cut by ${machining}.`);
  }
  if (kind === "lathe" && !validLatheMaterials.includes(String(body.material))) throw new HttpError(400, "Choose Aluminum 7075, Polycarb, Steel, or Carbon Fiber for the lathe material.");
  const wv = body.context.workspaceOrVersion;
  if (wv !== "w" && wv !== "v") throw new HttpError(400, "Invalid workspace or version type.");

  return {
    kind,
    friendlyName: readString(body.friendlyName, "Friendly name", 80),
    quantity,
    machiningType: machining as ExportBody["machiningType"],
    material: kind === "step" ? "3D Print" : body.material,
    subsystem: kind === "dxf" || kind === "lathe" ? readOptionalString(body.subsystem, "Subsystem", 80) : undefined,
    context: {
      documentId: readId(body.context.documentId, "Document ID"),
      workspaceOrVersion: wv,
      workspaceOrVersionId: readId(body.context.workspaceOrVersionId, "Workspace or version ID"),
      elementId: readId(body.context.elementId, "Element ID"),
      server: safeOnshapeOrigin(body.context.server),
      configuration: readOptionalOnshapeParameter(body.context.configuration, "Configuration", 2000),
      onshapeUserId: readOptionalString(body.context.onshapeUserId, "Onshape user ID", 128),
    },
    selections,
    lathe,
  };
}

function safeFileStem(value: string): string {
  const stem = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return stem || "part";
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    );
  }
  return value;
}

interface OnshapeVector3 {
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

interface OnshapeFaceDetails {
  id?: unknown;
  surface?: {
    type?: unknown;
    direction?: OnshapeVector3;
    directionOrientedWithFace?: OnshapeVector3;
    normal?: OnshapeVector3;
  };
}

interface OnshapeBodyDetails {
  id?: unknown;
  faces?: OnshapeFaceDetails[];
}

function normalizedVector(value: OnshapeVector3 | undefined): [number, number, number] | undefined {
  const vector = [Number(value?.x), Number(value?.y), Number(value?.z)] as [number, number, number];
  if (!vector.every(Number.isFinite)) return undefined;
  const length = Math.hypot(...vector);
  if (length < 1e-12) return undefined;
  return vector.map((component) => component / length) as [number, number, number];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function faceViewMatrix(normal: [number, number, number]): string {
  // Onshape's document exporter expects a flattened 4x4 view. Choose a
  // stable in-plane X axis; the selected face normal becomes the view Z axis.
  const reference: [number, number, number] = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const rawXAxis = cross(reference, normal);
  const xAxis = normalizedVector({ x: rawXAxis[0], y: rawXAxis[1], z: rawXAxis[2] });
  if (!xAxis) throw new HttpError(422, "Could not determine the selected face orientation.");
  const yAxis = cross(normal, xAxis);
  return [...xAxis, 0, ...yAxis, 0, ...normal, 0, 0, 0, 0, 1].join(",");
}

async function getPartStudioBodyDetails(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<OnshapeBodyDetails[]> {
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = body.context;
  const endpoint = new URL(
    `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}/bodydetails`,
  );
  if (configuration) endpoint.searchParams.set("configuration", configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  }, session, sessionId);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new HttpError(response.status >= 400 && response.status < 500 ? 422 : 502, `Onshape could not inspect the selected Part Studio geometry. ${detail}`.trim());
  }
  const details = await response.json().catch(() => null) as {
    bodies?: OnshapeBodyDetails[];
  } | null;
  if (!Array.isArray(details?.bodies)) throw new HttpError(502, "Onshape returned invalid Part Studio body details.");
  return details.bodies;
}

async function selectedFaceView(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
  bodyDetails?: OnshapeBodyDetails[],
): Promise<string> {
  const bodies = bodyDetails ?? await getPartStudioBodyDetails(body, session, sessionId, version);
  const selection = body.selections[0];
  const face = bodies
    .flatMap((part) => Array.isArray(part.faces) ? part.faces : [])
    .find((candidate) => candidate.id === selection.selectionId);
  if (!face) throw new HttpError(422, "The selected face no longer exists in the current Part Studio configuration.");
  if (face.surface?.type !== "PLANE") throw new HttpError(422, "Select a planar face for a DXF export.");
  const normal = normalizedVector(
    face.surface.directionOrientedWithFace ?? face.surface.normal ?? face.surface.direction,
  );
  if (!normal) throw new HttpError(422, "Onshape did not return a valid plane for the selected face.");
  return faceViewMatrix(normal);
}

async function selectedPartId(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
  bodyDetails?: OnshapeBodyDetails[],
): Promise<string> {
  const bodies = bodyDetails ?? await getPartStudioBodyDetails(body, session, sessionId, version);
  const selection = body.selections[0];
  const selectedIds = new Set([selection.selectionId, selection.partId].filter((value): value is string => Boolean(value)));
  const selectedBody = bodies.find((candidate) =>
    (typeof candidate.id === "string" && selectedIds.has(candidate.id))
    || candidate.faces?.some((face) => typeof face.id === "string" && selectedIds.has(face.id)),
  );
  if (typeof selectedBody?.id === "string" && selectedBody.id) return selectedBody.id;
  if (selection.entityType === "BODY") return selection.partId ?? selection.selectionId;
  throw new HttpError(422, "The selected face no longer belongs to a part in the current Part Studio configuration.");
}

interface ExportPreview {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
}

function decodeShadedView(payload: unknown): ExportPreview | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const images = (payload as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  const groups = images.filter((group): group is unknown[] => Array.isArray(group));
  const individualCandidates = groups.flatMap((group) => group);
  const joinedCandidates = groups.map((group) => group.filter((item): item is string => typeof item === "string").join(""));
  const candidates = [...individualCandidates, ...joinedCandidates];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const encoded = candidate.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > MAX_PREVIEW_BYTES) continue;
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { bytes, contentType: "image/png", extension: "png" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { bytes, contentType: "image/jpeg", extension: "jpg" };
    }
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
      return { bytes, contentType: "image/webp", extension: "webp" };
    }
  }
  return undefined;
}

async function getPartPreview(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
  partId: string,
  viewMatrix: string,
): Promise<ExportPreview | undefined> {
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = body.context;
  const endpoint = new URL(
    `${session.server}/api/${version}/parts/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}/partid/${encodeURIComponent(partId)}/shadedviews`,
  );
  endpoint.searchParams.set("viewMatrix", viewMatrix);
  endpoint.searchParams.set("outputHeight", String(PREVIEW_SIZE));
  endpoint.searchParams.set("outputWidth", String(PREVIEW_SIZE));
  endpoint.searchParams.set("pixelSize", "0");
  endpoint.searchParams.set("edges", "show");
  endpoint.searchParams.set("useAntiAliasing", "true");
  if (configuration) endpoint.searchParams.set("configuration", configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  }, session, sessionId);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Onshape preview request failed (${response.status}). ${detail}`.trim());
  }
  const payload = await response.json().catch(() => null);
  const preview = decodeShadedView(payload);
  if (!preview) throw new Error("Onshape returned no supported shaded-view image.");
  return preview;
}

async function selectedLathePartId(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<string> {
  const bodies = await getPartStudioBodyDetails(body, session, sessionId, version);
  for (const selection of body.selections) {
    if (selection.entityType !== "FACE") continue;
    const face = bodies.flatMap((candidate) => candidate.faces ?? []).find((candidate) => candidate.id === selection.selectionId);
    if (face?.surface?.type !== "PLANE") throw new HttpError(422, "Select planar end faces for round lathe stock.");
  }
  const owners = body.selections.map((selection) => bodies.find((candidate) =>
    (typeof candidate.id === "string" && candidate.id === selection.partId)
    || candidate.faces?.some((face) => face.id === selection.selectionId),
  ));
  if (owners.some((owner) => !owner || typeof owner.id !== "string" || !owner.id)) {
    throw new HttpError(422, "Onshape could not find the part that owns the selected lathe geometry.");
  }
  const partIds = new Set(owners.map((owner) => owner!.id as string));
  if (partIds.size !== 1) throw new HttpError(422, "All selected lathe geometry must belong to the same part.");
  return [...partIds][0];
}

async function callOnshapeExport(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  resolvedPartId?: string,
  resolvedFaceView?: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (body.context.server !== session.server) throw new HttpError(400, "The selected document does not match the connected Onshape server.");
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = body.context;
  const version = apiVersion.value().replace(/^\//, "");
  let endpoint: string;
  let publicDxfEndpoint: string | undefined;
  let payload: Record<string, unknown>;
  if (body.kind === "dxf") {
    const documentExportBase = `${session.server}/api/${version}/documents/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}`;
    endpoint = `${documentExportBase}/exportinternal`;
    publicDxfEndpoint = `${documentExportBase}/export`;
    payload = {
      documentId,
      elementId,
      format: "DXF",
      destinationName: safeFileStem(body.friendlyName),
      partIds: body.selections[0].selectionId,
      view: resolvedFaceView ?? await selectedFaceView(body, session, sessionId, version),
      version: "2018",
      flatten: true,
      splinesAsPolylines: true,
      storeInDocument: false,
      triggerAutoDownload: true,
      zipSingleFileOutput: false,
      ...(workspaceOrVersion === "w" ? { workspaceId: workspaceOrVersionId } : { documentVersionId: workspaceOrVersionId }),
      ...(configuration ? { configuration } : {}),
    };
  } else if (body.kind === "step") {
    endpoint = `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}/translations`;
    payload = {
      formatName: "STEP",
      partIds: resolvedPartId ?? await selectedPartId(body, session, sessionId, version),
      storeInDocument: false,
      translate: true,
      ...(configuration ? { configuration } : {}),
    };
  } else {
    throw new HttpError(400, "Lathe requests do not create an Onshape export file.");
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
  if (!response.ok && publicDxfEndpoint) {
    response = await authorizedOnshapeFetch(publicDxfEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/octet-stream, application/json",
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify(payload),
      redirect: "follow",
    }, session, sessionId);
  }

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
  const exportId = db.collection("exports").doc().id;
  if (body.kind === "lathe") {
    if (body.context.server !== session.server) throw new HttpError(400, "The selected document does not match the connected Onshape server.");
    const version = apiVersion.value().replace(/^\//, "");
    const partId = await selectedLathePartId(body, session, sessionId, version);
    const requestMetadata = withoutUndefined(body) as Record<string, unknown>;
    await db.collection("exports").doc(exportId).set({
      ...requestMetadata,
      partId,
      requestedBy: session.user,
      sessionId,
      status: "queued",
      createdAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ exportId, kind: body.kind });
    return;
  }
  const version = apiVersion.value().replace(/^\//, "");
  const bodyDetails = await getPartStudioBodyDetails(body, session, sessionId, version);
  const partId = await selectedPartId(body, session, sessionId, version, bodyDetails);
  const faceView = body.kind === "dxf"
    ? await selectedFaceView(body, session, sessionId, version, bodyDetails)
    : undefined;
  const previewView = faceView ? faceView.split(",").slice(0, 12).join(",") : ISOMETRIC_VIEW_MATRIX;
  const previewPromise = getPartPreview(body, session, sessionId, version, partId, previewView).catch((error: unknown) => {
    console.error("Could not create Onshape export preview.", error);
    return undefined;
  });
  const [{ bytes, contentType }, preview] = await Promise.all([
    callOnshapeExport(body, session, sessionId, partId, faceView),
    previewPromise,
  ]);
  const extension = body.kind;
  const fileName = `${safeFileStem(body.friendlyName)}-${exportId.slice(0, 8)}.${extension}`;
  const dateFolder = new Date().toISOString().slice(0, 10);
  const storagePath = `manufacturing/${body.kind}/${dateFolder}/${fileName}`;
  const previewFileName = preview ? `${safeFileStem(body.friendlyName)}-${exportId.slice(0, 8)}-preview.${preview.extension}` : undefined;
  const previewStoragePath = previewFileName ? `manufacturing/previews/${dateFolder}/${previewFileName}` : undefined;
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
    partId,
    selectionId: body.selections[0].selectionId,
    ...(previewStoragePath ? { previewStoragePath } : {}),
    ...(body.material ? { material: body.material } : {}),
    ...(body.subsystem ? { subsystem: body.subsystem } : {}),
  };
  const uploads: Promise<unknown>[] = [bucket.file(storagePath).save(bytes, {
    resumable: false,
    contentType,
    metadata: { cacheControl: "private, max-age=0", metadata: customMetadata },
  })];
  if (preview && previewStoragePath) {
    uploads.push(bucket.file(previewStoragePath).save(preview.bytes, {
      resumable: false,
      contentType: preview.contentType,
      metadata: {
        cacheControl: "private, max-age=0",
        metadata: {
          exportId,
          friendlyName: body.friendlyName,
          kind: body.kind,
          partId,
          source: "onshape-shaded-view",
        },
      },
    }));
  }
  await Promise.all(uploads);
  const exportRequestMetadata = withoutUndefined(body) as Record<string, unknown>;
  await db.collection("exports").doc(exportId).set({
    ...exportRequestMetadata,
    partId,
    fileName,
    storagePath,
    byteLength: bytes.length,
    contentType,
    previewStatus: preview ? "complete" : "unavailable",
    ...(preview && previewFileName && previewStoragePath ? {
      previewFileName,
      previewStoragePath,
      previewByteLength: preview.bytes.length,
      previewContentType: preview.contentType,
      previewWidth: PREVIEW_SIZE,
      previewHeight: PREVIEW_SIZE,
    } : {}),
    requestedBy: session.user,
    sessionId,
    status: "complete",
    createdAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ exportId, kind: body.kind, storagePath, fileName, previewStoragePath });
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
