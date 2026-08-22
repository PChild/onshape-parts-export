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
const EXPORT_RESULT_POLL_MS = 3_000;
const EXPORT_RESULT_MAX_POLL_MS = 15_000;
const PREVIEW_SIZE = 512;
const METERS_TO_INCHES = 39.37007874015748;
const WORKSPACE_SUGGESTION_CACHE_MS = 10 * 60 * 1000;
const IMMUTABLE_SUGGESTION_CACHE_MS = 180 * 24 * 60 * 60 * 1000;
const DOCUMENT_NAME_CACHE_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_PREVIEW_CACHE_MS = 10 * 60 * 1000;
const IMMUTABLE_PREVIEW_CACHE_MS = 180 * 24 * 60 * 60 * 1000;
const ISOMETRIC_VIEW_MATRIX = "0.612,0.612,0,0,-0.354,0.354,0.707,0,0.707,-0.707,0.707,0";
const DXF_BOUNDS_FEATURESCRIPT = `function(context is Context, queries is map)
{
  const selectedFace = queries.face;
  const facePlane = evPlane(context, { "face" : selectedFace });
  const normal = facePlane.normal;
  const reference = abs(normal[2]) < 0.9 ? vector(0, 0, 1) : vector(0, 1, 0);
  const xDirection = normalize(cross(reference, normal));
  const faceSystem = coordSystem(facePlane.origin, xDirection, normal);
  const bounds = evBox3d(context, {
    "topology" : selectedFace,
    "cSys" : faceSystem,
    "tight" : true
  });
  return [
    (bounds.maxCorner[0] - bounds.minCorner[0]) / inch,
    (bounds.maxCorner[1] - bounds.minCorner[1]) / inch
  ];
}`;
const STEP_BOUNDS_FEATURESCRIPT = `function(context is Context, queries is map)
{
  const bounds = evBox3d(context, {
    "topology" : queries.part,
    "tight" : true
  });
  return [
    (bounds.maxCorner[0] - bounds.minCorner[0]) / inch,
    (bounds.maxCorner[1] - bounds.minCorner[1]) / inch,
    (bounds.maxCorner[2] - bounds.minCorner[2]) / inch
  ];
}`;
const PART_ANALYSIS_FEATURESCRIPT = `function(context is Context, queries is map)
{
  const selectedPart = queries.part;
  const bounds = evBox3d(context, {
    "topology" : selectedPart,
    "tight" : true
  });
  return {
    "name" : try silent (getProperty(context, {
      "entity" : selectedPart,
      "propertyType" : PropertyType.NAME
    })),
    "material" : try silent (getProperty(context, {
      "entity" : selectedPart,
      "propertyType" : PropertyType.MATERIAL
    })),
    "partBounds" : [
      (bounds.maxCorner[0] - bounds.minCorner[0]) / inch,
      (bounds.maxCorner[1] - bounds.minCorner[1]) / inch,
      (bounds.maxCorner[2] - bounds.minCorner[2]) / inch
    ]
  };
}`;
const DXF_PART_ANALYSIS_FEATURESCRIPT = `function(context is Context, queries is map)
{
  const selectedPart = queries.part;
  const selectedFace = queries.face;
  const partBounds = evBox3d(context, {
    "topology" : selectedPart,
    "tight" : true
  });
  const facePlane = evPlane(context, { "face" : selectedFace });
  const normal = facePlane.normal;
  const reference = abs(normal[2]) < 0.9 ? vector(0, 0, 1) : vector(0, 1, 0);
  const xDirection = normalize(cross(reference, normal));
  const faceSystem = coordSystem(facePlane.origin, xDirection, normal);
  const faceBounds = evBox3d(context, {
    "topology" : selectedFace,
    "cSys" : faceSystem,
    "tight" : true
  });
  return {
    "name" : try silent (getProperty(context, {
      "entity" : selectedPart,
      "propertyType" : PropertyType.NAME
    })),
    "material" : try silent (getProperty(context, {
      "entity" : selectedPart,
      "propertyType" : PropertyType.MATERIAL
    })),
    "partBounds" : [
      (partBounds.maxCorner[0] - partBounds.minCorner[0]) / inch,
      (partBounds.maxCorner[1] - partBounds.minCorner[1]) / inch,
      (partBounds.maxCorner[2] - partBounds.minCorner[2]) / inch
    ],
    "faceBounds" : [
      (faceBounds.maxCorner[0] - faceBounds.minCorner[0]) / inch,
      (faceBounds.maxCorner[1] - faceBounds.minCorner[1]) / inch
    ],
    "faceNormal" : [normal[0], normal[1], normal[2]]
  };
}`;
const LATHE_ANALYSIS_FEATURESCRIPT = `function(context is Context, queries is map)
{
  const faceA = queries.faceA;
  const faceB = queries.faceB;
  if (evaluateQueryCount(context, faceA) != 1 || evaluateQueryCount(context, faceB) != 1)
    return { "status" : "missingFace" };
  const ownerA = qOwnerBody(faceA);
  const ownerB = qOwnerBody(faceB);
  if (evaluateQueryCount(context, ownerA) != 1 || evaluateQueryCount(context, ownerB) != 1)
    return { "status" : "missingPart" };
  if (!areQueriesEquivalent(context, ownerA, ownerB))
    return { "status" : "differentParts" };
  if (evaluateQueryCount(context, queries.part) != 1 || !areQueriesEquivalent(context, ownerA, queries.part))
    return { "status" : "partMismatch" };
  const planeA = try silent (evPlane(context, { "face" : faceA }));
  const planeB = try silent (evPlane(context, { "face" : faceB }));
  if (planeA == undefined || planeB == undefined)
    return { "status" : "notPlanar" };
  if (abs(dot(planeA.normal, planeB.normal)) < 0.999)
    return { "status" : "notParallel" };
  const length = abs(dot(planeB.origin - planeA.origin, planeA.normal)) / inch;
  if (length <= 0)
    return { "status" : "noLength" };
  return { "status" : "ok", "overallLengthInches" : length };
}`;

type ExportKind = "dxf" | "step" | "lathe";
type SelectionType = "FACE" | "BODY";
type DxfMaterial = "wood" | "aluminum 6061" | "aluminum 7075" | "aluminum 5052" | "steel" | "SRPP" | "polycarb" | "carbon fiber";
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
  material?: "wood" | "aluminum 6061" | "aluminum 7075" | "aluminum 5052" | "steel" | "SRPP" | "polycarb" | "carbon fiber" | "3D Print";
  materialThicknessInches?: number;
  subsystem?: string;
  context: {
    documentId: string;
    workspaceOrVersion: "w" | "v" | "m";
    workspaceOrVersionId: string;
    elementId: string;
    tabElementId?: string;
    contextType?: "partstudio" | "assembly";
    server: string;
    configuration?: string;
    onshapeUserId?: string;
  };
  selections: Array<{
    entityType: SelectionType;
    selectionId: string;
    partId?: string;
    occurrencePath?: string[];
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

interface DxfBounds {
  widthInches: number;
  heightInches: number;
  areaSquareInches: number;
}

interface StepBounds {
  xInches: number;
  yInches: number;
  zInches: number;
  volumeCubicInches: number;
}

interface ExportSuggestionResult {
  subsystem?: string;
  material?: DxfMaterial;
  friendlyName?: string;
  partMetadataFound: boolean;
  dxfBounds?: DxfBounds;
  stepBounds?: StepBounds;
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

function readOnshapeSelectionId(value: unknown, label: string): string {
  // Selection and occurrence identifiers are opaque Onshape values. Nested,
  // configured, patterned, and replicated assembly instances can contain
  // delimiters beyond the character set used by document/workspace IDs. They
  // remain safe here because URL uses are encoded and request bodies are JSON
  // serialized; readString still rejects empty values and control characters.
  return readString(value, label, 4096);
}

function readPositiveDimension(value: unknown, label: string): number {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension <= 0 || dimension > 100) {
    throw new HttpError(400, `${label} must be greater than 0 and no more than 100 inches.`);
  }
  return dimension;
}

function parseOnshapeContext(value: unknown): ExportBody["context"] {
  if (!value || typeof value !== "object") throw new HttpError(400, "The Onshape document context is required.");
  const context = value as Partial<ExportBody["context"]>;
  const workspaceOrVersion = context.workspaceOrVersion;
  if (workspaceOrVersion !== "w" && workspaceOrVersion !== "v" && workspaceOrVersion !== "m") throw new HttpError(400, "Invalid workspace, version, or microversion type.");
  if (context.contextType !== undefined && context.contextType !== "partstudio" && context.contextType !== "assembly") {
    throw new HttpError(400, "Invalid Onshape context type.");
  }
  return {
    documentId: readId(context.documentId, "Document ID"),
    workspaceOrVersion,
    workspaceOrVersionId: readId(context.workspaceOrVersionId, "Workspace or version ID"),
    elementId: readId(context.elementId, "Element ID"),
    tabElementId: context.tabElementId ? readId(context.tabElementId, "Current tab element ID") : undefined,
    contextType: context.contextType,
    server: safeOnshapeOrigin(context.server),
    configuration: readOptionalOnshapeParameter(context.configuration, "Configuration", 2000),
    onshapeUserId: readOptionalString(context.onshapeUserId, "Onshape user ID", 128),
  };
}

function parseOnshapeSelection(value: unknown, index = 0): ExportBody["selections"][number] {
  if (!value || typeof value !== "object") throw new HttpError(400, `Selection ${index + 1} is invalid.`);
  const rawSelection = value as Partial<ExportBody["selections"][number]>;
  const rawSelectionType = String(rawSelection.entityType).toUpperCase();
  const entityType: SelectionType | undefined = rawSelectionType === "FACE" ? "FACE"
      : ["BODY", "PART", "SOLID"].includes(rawSelectionType) ? "BODY" : undefined;
  if (!entityType) throw new HttpError(400, `Selection ${index + 1} has an invalid type.`);
  return {
    entityType,
    selectionId: readOnshapeSelectionId(rawSelection.selectionId, `Selection ${index + 1} ID`),
    partId: rawSelection.partId ? readOnshapeSelectionId(rawSelection.partId, `Selection ${index + 1} part ID`) : undefined,
    occurrencePath: rawSelection.occurrencePath === undefined ? undefined
      : Array.isArray(rawSelection.occurrencePath) && rawSelection.occurrencePath.length
        ? rawSelection.occurrencePath.map((id, pathIndex) => readOnshapeSelectionId(id, `Selection ${index + 1} occurrence ${pathIndex + 1}`))
        : (() => { throw new HttpError(400, `Selection ${index + 1} has an invalid occurrence path.`); })(),
    name: readOptionalString(rawSelection.name, `Selection ${index + 1} name`, 120),
  };
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
  if (kind !== "dxf" && kind !== "step" && kind !== "lathe") throw new HttpError(400, "Choose DXF, 3D print, or lathe.");
  const context = parseOnshapeContext(body.context);
  const lathe = kind === "lathe" ? parseLatheDetails(body.lathe) : undefined;
  const rawSelections = Array.isArray(body.selections) ? body.selections : body.selection ? [body.selection] : [];
  const selections = rawSelections.map(parseOnshapeSelection);
  if (new Set(selections.map((selection) => selection.selectionId)).size !== selections.length) {
    throw new HttpError(400, "Select distinct geometry for each selection.");
  }
  if (kind === "dxf" && (selections.length !== 1 || selections[0]?.entityType !== "FACE")) {
    throw new HttpError(400, "Select exactly one face for a DXF export.");
  }
  if (kind === "step" && (selections.length !== 1 || !["BODY", "FACE"].includes(selections[0]?.entityType ?? ""))) {
    throw new HttpError(400, "Select exactly one part or face for a 3D-print STL export.");
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
    plasma: ["steel", "aluminum 6061", "aluminum 7075", "aluminum 5052"],
    waterjet: ["wood", "aluminum 6061", "aluminum 7075", "aluminum 5052", "steel", "SRPP", "polycarb", "carbon fiber"],
  };
  const validLatheMaterials = ["aluminum 7075", "polycarb", "steel", "carbon fiber"];
  if (kind === "dxf" && !validDxfMaterialsByMachining[machining as "laser" | "plasma" | "waterjet"].includes(String(body.material))) {
    throw new HttpError(400, `Choose a material that can be cut by ${machining}.`);
  }
  if (kind === "lathe" && !validLatheMaterials.includes(String(body.material))) throw new HttpError(400, "Choose Aluminum 7075, Polycarb, Steel, or Carbon Fiber for the lathe material.");
  const materialThicknessInches = kind === "dxf"
    ? readPositiveDimension(body.materialThicknessInches, "Material thickness")
    : undefined;
  return {
    kind,
    friendlyName: readString(body.friendlyName, "Friendly name", 80),
    quantity,
    machiningType: machining as ExportBody["machiningType"],
    material: kind === "step" ? "3D Print" : body.material,
    materialThicknessInches,
    subsystem: readOptionalString(body.subsystem, "Subsystem", 80),
    context,
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
    origin?: OnshapeVector3;
    direction?: OnshapeVector3;
    directionOrientedWithFace?: OnshapeVector3;
    normal?: OnshapeVector3;
  };
}

interface OnshapeBodyDetails {
  id?: unknown;
  faces?: OnshapeFaceDetails[];
}

interface OnshapePartInfo {
  id?: unknown;
  partId?: unknown;
  name?: unknown;
  material?: {
    displayName?: unknown;
    id?: unknown;
    libraryName?: unknown;
  } | null;
}

interface OnshapeAssemblyInstance {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  partId?: unknown;
  documentId?: unknown;
  documentMicroversion?: unknown;
  documentVersion?: unknown;
  elementId?: unknown;
  configuration?: unknown;
  fullConfiguration?: unknown;
  isStandardContent?: unknown;
}

interface OnshapeAssemblyContainer {
  documentId?: unknown;
  documentMicroversion?: unknown;
  documentVersion?: unknown;
  elementId?: unknown;
  configuration?: unknown;
  fullConfiguration?: unknown;
  instances?: OnshapeAssemblyInstance[];
  occurrences?: Array<{ path?: unknown }>;
}

interface OnshapeAssemblyDefinition {
  rootAssembly?: OnshapeAssemblyContainer;
  subAssemblies?: OnshapeAssemblyContainer[];
  parts?: OnshapeAssemblyInstance[];
}

type OnshapeAssemblySource = OnshapeAssemblyInstance | OnshapeAssemblyContainer;

interface ResolvedSelections {
  context: ExportBody["context"];
  selections: ExportBody["selections"];
  exportTarget: {
    context: ExportBody["context"];
    occurrencePath?: string[];
  };
}

interface CachedExportSuggestions {
  result: ExportSuggestionResult;
  resolved: ResolvedSelections;
  partId?: string;
  faceView?: string;
  expiresAt: Timestamp;
}

function exportSuggestionCacheId(
  userId: string,
  context: ExportBody["context"],
  selection: ExportBody["selections"][number],
  kind: ExportKind,
): string {
  return tokenHash(JSON.stringify({
    userId,
    server: context.server,
    documentId: context.documentId,
    workspaceOrVersion: context.workspaceOrVersion,
    workspaceOrVersionId: context.workspaceOrVersionId,
    elementId: context.elementId,
    configuration: context.configuration ?? "",
    contextType: context.contextType ?? "",
    kind,
    selection,
  }));
}

async function readCachedExportSuggestions(cacheId: string): Promise<CachedExportSuggestions | undefined> {
  const snapshot = await db.collection("onshapeExportSuggestionCache").doc(cacheId).get();
  if (!snapshot.exists) return undefined;
  const cached = snapshot.data() as Partial<CachedExportSuggestions>;
  if (!(cached.expiresAt instanceof Timestamp) || cached.expiresAt.toMillis() <= Date.now()) return undefined;
  if (!cached.result || !cached.resolved) return undefined;
  return cached as CachedExportSuggestions;
}

async function writeCachedExportSuggestions(
  cacheId: string,
  context: ExportBody["context"],
  value: Omit<CachedExportSuggestions, "expiresAt">,
): Promise<CachedExportSuggestions> {
  const ttl = context.workspaceOrVersion === "w" ? WORKSPACE_SUGGESTION_CACHE_MS : IMMUTABLE_SUGGESTION_CACHE_MS;
  const cached: CachedExportSuggestions = {
    ...value,
    expiresAt: Timestamp.fromMillis(Date.now() + ttl),
  };
  const serialized = {
    result: withoutUndefined(cached.result),
    resolved: withoutUndefined(cached.resolved),
    ...(cached.partId ? { partId: cached.partId } : {}),
    ...(cached.faceView ? { faceView: cached.faceView } : {}),
    expiresAt: cached.expiresAt,
  } as Record<string, unknown>;
  await db.collection("onshapeExportSuggestionCache").doc(cacheId).set(serialized);
  return cached;
}

async function cachedDocumentName(
  context: ExportBody["context"],
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<string | undefined> {
  const cacheId = tokenHash(JSON.stringify({
    userId: session.user.id,
    server: context.server,
    documentId: context.documentId,
  }));
  const ref = db.collection("onshapeDocumentNameCache").doc(cacheId);
  const snapshot = await ref.get();
  if (snapshot.exists) {
    const cached = snapshot.data() as { name?: unknown; expiresAt?: unknown };
    if (cached.expiresAt instanceof Timestamp && cached.expiresAt.toMillis() > Date.now()) {
      return cleanSuggestion(cached.name);
    }
  }
  const endpoint = `${session.server}/api/${version}/documents/${encodeURIComponent(context.documentId)}`;
  const response = await authorizedOnshapeFetch(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, session, sessionId);
  if (!response.ok) throw new Error(`Onshape document lookup failed (${response.status}).`);
  const document = await response.json().catch(() => null) as { name?: unknown } | null;
  const name = cleanSuggestion(document?.name);
  if (name) {
    await ref.set({ name, expiresAt: Timestamp.fromMillis(Date.now() + DOCUMENT_NAME_CACHE_MS) });
  }
  return name;
}

function assemblySourceRevision(source: OnshapeAssemblySource): string | undefined {
  if (typeof source.documentMicroversion === "string" && source.documentMicroversion) return `m:${source.documentMicroversion}`;
  if (typeof source.documentVersion === "string" && source.documentVersion) return `v:${source.documentVersion}`;
  return undefined;
}

function assemblySourceConfiguration(source: OnshapeAssemblySource): string {
  return String(source.fullConfiguration ?? source.configuration ?? "");
}

function assemblyElementSourceKey(source: OnshapeAssemblySource): string | undefined {
  if (typeof source.documentId !== "string" || typeof source.elementId !== "string") return undefined;
  const revision = assemblySourceRevision(source);
  return revision ? `${source.documentId}:${revision}:${source.elementId}:${assemblySourceConfiguration(source)}` : undefined;
}

function assemblyInstanceSourceKey(instance: OnshapeAssemblyInstance): string | undefined {
  if (typeof instance.partId !== "string") return undefined;
  const elementKey = assemblyElementSourceKey(instance);
  return elementKey ? `${elementKey}:${instance.partId}` : undefined;
}

function sameAssemblyElementRevision(instance: OnshapeAssemblyInstance, assembly: OnshapeAssemblyContainer): boolean {
  if (instance.documentId !== assembly.documentId || instance.elementId !== assembly.elementId) return false;
  const instanceMicroversion = typeof instance.documentMicroversion === "string" ? instance.documentMicroversion : undefined;
  const assemblyMicroversion = typeof assembly.documentMicroversion === "string" ? assembly.documentMicroversion : undefined;
  if (instanceMicroversion && assemblyMicroversion && instanceMicroversion !== assemblyMicroversion) return false;
  const instanceVersion = typeof instance.documentVersion === "string" ? instance.documentVersion : undefined;
  const assemblyVersion = typeof assembly.documentVersion === "string" ? assembly.documentVersion : undefined;
  if (!instanceMicroversion && !assemblyMicroversion && instanceVersion && assemblyVersion && instanceVersion !== assemblyVersion) return false;
  return true;
}

function partInstancesAtOccurrencePath(
  definition: OnshapeAssemblyDefinition,
  occurrencePath: string[],
): OnshapeAssemblyInstance[] {
  if (!definition.rootAssembly || !occurrencePath.length) return [];
  const walk = (assembly: OnshapeAssemblyContainer, index: number): OnshapeAssemblyInstance[] => {
    const instances = (assembly.instances ?? []).filter((candidate) => candidate.id === occurrencePath[index]);
    if (index === occurrencePath.length - 1) {
      return instances.filter((instance) => String(instance.type).toLowerCase() === "part");
    }
    const results: OnshapeAssemblyInstance[] = [];
    for (const instance of instances) {
      if (String(instance.type).toLowerCase() !== "assembly") continue;
      const compatible = (definition.subAssemblies ?? []).filter((candidate) => sameAssemblyElementRevision(instance, candidate));
      const exactConfiguration = compatible.filter((candidate) =>
        assemblySourceConfiguration(instance) === assemblySourceConfiguration(candidate),
      );
      const preferred = exactConfiguration.length ? exactConfiguration : compatible;
      let nested = preferred.flatMap((candidate) => walk(candidate, index + 1));
      // Some configured and flexible subassemblies report equivalent source
      // configurations using different encoded strings. Fall back to every
      // matching source element when the exact configuration cannot walk the
      // occurrence path.
      if (!nested.length && exactConfiguration.length && exactConfiguration.length !== compatible.length) {
        nested = compatible.flatMap((candidate) => walk(candidate, index + 1));
      }
      results.push(...nested);
    }
    return results;
  };
  return walk(definition.rootAssembly, 0);
}

function uniqueAssemblySource(candidates: OnshapeAssemblyInstance[]): OnshapeAssemblyInstance | undefined {
  if (!candidates.length) return undefined;
  const keyedCandidates = candidates
    .map((candidate) => ({ candidate, key: assemblyInstanceSourceKey(candidate) }))
    .filter((entry): entry is { candidate: OnshapeAssemblyInstance; key: string } => Boolean(entry.key));
  const sourceKeys = new Set(keyedCandidates.map((entry) => entry.key));
  if (sourceKeys.size === 1) return keyedCandidates[0].candidate;
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

function hydrateAssemblyPartSource(
  instance: OnshapeAssemblyInstance,
  parts: OnshapeAssemblyInstance[],
): OnshapeAssemblyInstance {
  if (typeof instance.partId !== "string") return instance;
  const compatible = parts.filter((part) => {
    if (part.partId !== instance.partId) return false;
    for (const field of ["documentId", "elementId", "documentMicroversion", "documentVersion"] as const) {
      if (typeof instance[field] === "string" && typeof part[field] === "string" && instance[field] !== part[field]) return false;
    }
    return true;
  });
  const source = uniqueAssemblySource(compatible);
  if (!source) return instance;
  const definedInstanceFields = Object.fromEntries(
    Object.entries(instance).filter(([, value]) => value !== undefined && value !== null),
  ) as OnshapeAssemblyInstance;
  return { ...source, ...definedInstanceFields };
}

function sourceExportContext(
  instance: OnshapeAssemblyInstance,
  assemblyContext: ExportBody["context"],
  sourceContext: ExportBody["context"],
): ExportBody["context"] | undefined {
  const documentVersion = typeof instance.documentVersion === "string" && instance.documentVersion
    ? instance.documentVersion
    : undefined;
  if (documentVersion) {
    return {
      ...sourceContext,
      workspaceOrVersion: "v",
      workspaceOrVersionId: documentVersion,
    };
  }
  // An unversioned occurrence can only come from the active document
  // workspace. The instance includes its microversion but not its workspace
  // id, so reuse the assembly's document-wide workspace/version id.
  if (instance.documentId === assemblyContext.documentId && assemblyContext.workspaceOrVersion !== "m") {
    return {
      ...sourceContext,
      workspaceOrVersion: assemblyContext.workspaceOrVersion,
      workspaceOrVersionId: assemblyContext.workspaceOrVersionId,
    };
  }
  return undefined;
}

async function resolveAssemblySelections(
  context: ExportBody["context"],
  selections: ExportBody["selections"],
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<ResolvedSelections> {
  if (context.contextType !== "assembly") return { context, selections, exportTarget: { context } };
  const endpoint = new URL(
    `${session.server}/api/${version}/assemblies/d/${encodeURIComponent(context.documentId)}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(context.elementId)}`,
  );
  if (context.configuration) endpoint.searchParams.set("configuration", context.configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  }, session, sessionId);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new HttpError(response.status >= 400 && response.status < 500 ? 422 : 502, `Onshape could not inspect the current assembly. ${detail}`.trim());
  }
  const definition = await response.json().catch(() => null) as OnshapeAssemblyDefinition | null;
  if (!definition?.rootAssembly) throw new HttpError(502, "Onshape returned an invalid assembly definition.");
  const instances = [
    ...(Array.isArray(definition?.rootAssembly?.instances) ? definition.rootAssembly.instances : []),
    ...(Array.isArray(definition?.subAssemblies) ? definition.subAssemblies.flatMap((assembly) => Array.isArray(assembly.instances) ? assembly.instances : []) : []),
  ].filter((instance) => String(instance.type).toLowerCase() === "part" && instance.isStandardContent !== true);
  if (!instances.length) throw new HttpError(422, "The assembly contains no supported Part Studio instances.");

  const assemblyParts = Array.isArray(definition.parts) ? definition.parts : [];
  const selectedInstances = selections.map((selection, index) => {
    const occurrenceInstance = selection.occurrencePath
      ? uniqueAssemblySource(partInstancesAtOccurrencePath(definition, selection.occurrencePath))
      : undefined;
    if (occurrenceInstance && occurrenceInstance.isStandardContent !== true) {
      return hydrateAssemblyPartSource(occurrenceInstance, assemblyParts);
    }
    const leafOccurrenceId = selection.occurrencePath?.at(-1);
    const candidateGroups = [
      leafOccurrenceId && selection.partId
        ? instances.filter((instance) => instance.id === leafOccurrenceId && instance.partId === selection.partId)
        : [],
      leafOccurrenceId ? instances.filter((instance) => instance.id === leafOccurrenceId) : [],
      selection.entityType === "BODY"
        ? instances.filter((instance) => instance.id === selection.selectionId || instance.partId === selection.selectionId)
        : [],
      selection.partId ? instances.filter((instance) => instance.partId === selection.partId) : [],
    ];
    for (const candidates of candidateGroups) {
      const candidate = uniqueAssemblySource(candidates);
      if (candidate) return hydrateAssemblyPartSource(candidate, assemblyParts);
    }
    if (selection.partId) {
      const part = uniqueAssemblySource(assemblyParts.filter((candidate) =>
        candidate.partId === selection.partId && candidate.isStandardContent !== true,
      ));
      if (part) return { ...part, type: "Part", name: selection.name };
    }
    throw new HttpError(422, `Onshape could not resolve selection ${index + 1} to one assembly part instance.`);
  });
  const selectedOccurrenceKeys = new Set(selections.map((selection, index) =>
    selection.occurrencePath?.join("/") ?? String(selectedInstances[index].id ?? ""),
  ));
  if (selections.length > 1 && selectedOccurrenceKeys.size > 1) {
    throw new HttpError(422, "Select all required faces from the same assembly part instance.");
  }
  const selectedSourceKeys = selectedInstances.map(assemblyInstanceSourceKey);
  if (selectedSourceKeys.some((key) => !key)) throw new HttpError(422, "Onshape returned incomplete source information for the selected assembly part.");
  const sourceKeys = new Set(selectedSourceKeys);
  if (sourceKeys.size !== 1) throw new HttpError(422, "All selected geometry must resolve to the same source part.");
  const instance = selectedInstances[0];
  if (typeof instance.documentId !== "string" || typeof instance.elementId !== "string" || typeof instance.partId !== "string") {
    throw new HttpError(422, "Onshape returned incomplete source information for the selected assembly part.");
  }
  const documentMicroversion = typeof instance.documentMicroversion === "string" && instance.documentMicroversion ? instance.documentMicroversion : undefined;
  const documentVersion = typeof instance.documentVersion === "string" && instance.documentVersion ? instance.documentVersion : undefined;
  if (!documentVersion && !documentMicroversion) throw new HttpError(422, "Onshape did not identify the selected part's source version.");
  const sourceContext: ExportBody["context"] = {
    documentId: instance.documentId,
    workspaceOrVersion: documentMicroversion ? "m" : "v",
    workspaceOrVersionId: documentMicroversion ?? documentVersion!,
    elementId: instance.elementId,
    server: context.server,
    configuration: cleanSuggestion(instance.fullConfiguration, 2000) ?? cleanSuggestion(instance.configuration, 2000),
    contextType: "partstudio",
    onshapeUserId: context.onshapeUserId,
  };
  const translatedContext = sourceExportContext(instance, context, sourceContext);
  const occurrencePath = selections[0].occurrencePath;
  if (!translatedContext && (context.workspaceOrVersion === "m" || !occurrencePath?.length)) {
    throw new HttpError(422, "Onshape identified the selected assembly part only by microversion and did not provide an exportable workspace, version, or occurrence path.");
  }
  return {
    context: sourceContext,
    selections: selections.map((selection, index) => ({
      ...selection,
      selectionId: selection.entityType === "BODY" ? selectedInstances[index].partId as string : selection.selectionId,
      partId: selectedInstances[index].partId as string,
      name: selection.name ?? (typeof selectedInstances[index].name === "string" ? selectedInstances[index].name : undefined),
    })),
    exportTarget: translatedContext
      ? { context: translatedContext }
      : { context, occurrencePath },
  };
}

function suggestedDxfMaterial(...values: unknown[]): DxfMaterial | undefined {
  const description = values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(carbon[\s_-]*fib(?:er|re)|cfrp)\b/.test(description)) return "carbon fiber";
  if (/\b(polycarbonate|polycarb|lexan)\b/.test(description)) return "polycarb";
  if (/\b(srpp|self[\s_-]*reinforced[\s_-]*polypropylene|polypropylene)\b/.test(description)) return "SRPP";
  if (/\b7075(?:-t\d+)?\b/.test(description)) return "aluminum 7075";
  if (/\b5052(?:-h\d+)?\b/.test(description)) return "aluminum 5052";
  if (/\b6061(?:-t\d+)?\b/.test(description)) return "aluminum 6061";
  if (/\b(aluminum|aluminium)\b/.test(description)) return "aluminum 6061";
  if (/\bsteel\b/.test(description)) return "steel";
  if (/\b(wood|plywood|mdf|timber)\b/.test(description)) return "wood";
  return undefined;
}

function cleanSuggestion(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().replace(/[\u0000-\u001f]/g, " ").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function normalizedVector(value: OnshapeVector3 | undefined): [number, number, number] | undefined {
  const vector = finiteVector(value);
  if (!vector) return undefined;
  const length = Math.hypot(...vector);
  if (length < 1e-12) return undefined;
  return vector.map((component) => component / length) as [number, number, number];
}

function finiteVector(value: OnshapeVector3 | undefined): [number, number, number] | undefined {
  const vector = [Number(value?.x), Number(value?.y), Number(value?.z)] as [number, number, number];
  return vector.every(Number.isFinite) ? vector : undefined;
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
  body: Pick<ExportBody, "context">,
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

function partIdForSelection(
  bodies: OnshapeBodyDetails[],
  selection: ExportBody["selections"][number],
): string | undefined {
  const selectedIds = new Set([selection.selectionId, selection.partId].filter((value): value is string => Boolean(value)));
  const selectedBody = bodies.find((candidate) =>
    (typeof candidate.id === "string" && selectedIds.has(candidate.id))
    || candidate.faces?.some((face) => typeof face.id === "string" && selectedIds.has(face.id)),
  );
  if (typeof selectedBody?.id === "string" && selectedBody.id) return selectedBody.id;
  return selection.entityType === "BODY" ? selection.partId ?? selection.selectionId : undefined;
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

function featureScriptNumberArray(value: unknown): number[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const items = (result as { value?: unknown }).value;
  if (!Array.isArray(items)) return undefined;
  const numbers = items.map((item) => {
    if (!item || typeof item !== "object") return Number.NaN;
    return Number((item as { value?: unknown }).value);
  });
  return numbers.every(Number.isFinite) ? numbers : undefined;
}

function decodeFeatureScriptValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as { btType?: unknown; value?: unknown };
  const btType = typeof typed.btType === "string" ? typed.btType : "";
  if (btType.includes("Undefined") || btType.includes("TooBig")) return undefined;
  if (btType.includes("Array") && Array.isArray(typed.value)) {
    return typed.value.map(decodeFeatureScriptValue);
  }
  if (btType.includes("Map") && Array.isArray(typed.value)) {
    const entries = typed.value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const pair = entry as { key?: unknown; value?: unknown };
      const key = decodeFeatureScriptValue(pair.key);
      return typeof key === "string" ? [[key, decodeFeatureScriptValue(pair.value)] as const] : [];
    });
    return Object.fromEntries(entries);
  }
  if ("value" in typed) return typed.value;
  return undefined;
}

interface OnshapePartAnalysis {
  friendlyName?: string;
  material?: DxfMaterial;
  dxfBounds?: DxfBounds;
  stepBounds?: StepBounds;
  faceView?: string;
}

function positiveNumberArray(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const numbers = value.map(Number);
  return numbers.every((number) => Number.isFinite(number) && number > 0) ? numbers : undefined;
}

async function getOnshapePartAnalysis(
  context: ExportBody["context"],
  partId: string,
  faceId: string | undefined,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<OnshapePartAnalysis> {
  const endpoint = new URL(
    `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(context.documentId)}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(context.elementId)}/featurescript`,
  );
  endpoint.searchParams.set("rollbackBarIndex", "-1");
  if (context.configuration) endpoint.searchParams.set("configuration", context.configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json;charset=UTF-8; qs=0.09",
    },
    body: JSON.stringify({
      script: faceId ? DXF_PART_ANALYSIS_FEATURESCRIPT : PART_ANALYSIS_FEATURESCRIPT,
      queries: {
        part: [partId],
        ...(faceId ? { face: [faceId] } : {}),
      },
    }),
  }, session, sessionId);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Onshape combined part analysis failed (${response.status}). ${responseText.slice(0, 300)}`.trim());
  }
  const payload = (() => {
    try { return JSON.parse(responseText) as { result?: unknown }; } catch { return undefined; }
  })();
  const decoded = decodeFeatureScriptValue(payload?.result);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Onshape returned an invalid combined part analysis.");
  }
  const result = decoded as Record<string, unknown>;
  const friendlyName = cleanSuggestion(result.name);
  const materialDescription = result.material === undefined ? undefined : JSON.stringify(result.material);
  const material = suggestedDxfMaterial(materialDescription);
  const partBounds = positiveNumberArray(result.partBounds, 3);
  const stepBounds = partBounds ? {
    xInches: roundedMeasurement(partBounds[0]),
    yInches: roundedMeasurement(partBounds[1]),
    zInches: roundedMeasurement(partBounds[2]),
    volumeCubicInches: roundedMeasurement(partBounds[0] * partBounds[1] * partBounds[2]),
  } : undefined;
  const faceBounds = positiveNumberArray(result.faceBounds, 2);
  const dxfBounds = faceBounds ? {
    widthInches: roundedMeasurement(faceBounds[0]),
    heightInches: roundedMeasurement(faceBounds[1]),
    areaSquareInches: roundedMeasurement(faceBounds[0] * faceBounds[1]),
  } : undefined;
  const rawNormal = Array.isArray(result.faceNormal) && result.faceNormal.length === 3
    ? result.faceNormal.map(Number) as [number, number, number]
    : undefined;
  const normal = rawNormal?.every(Number.isFinite)
    ? normalizedVector({ x: rawNormal[0], y: rawNormal[1], z: rawNormal[2] })
    : undefined;
  const faceView = normal ? faceViewMatrix(normal) : undefined;
  return {
    ...(friendlyName ? { friendlyName } : {}),
    ...(material ? { material } : {}),
    ...(dxfBounds ? { dxfBounds } : {}),
    ...(stepBounds ? { stepBounds } : {}),
    ...(faceView ? { faceView } : {}),
  };
}

async function getPartMetadataSuggestion(
  context: ExportBody["context"],
  partId: string,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<Pick<OnshapePartAnalysis, "friendlyName" | "material">> {
  const endpoint = new URL(
    `${session.server}/api/${version}/parts/d/${encodeURIComponent(context.documentId)}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(context.elementId)}`,
  );
  if (context.configuration) endpoint.searchParams.set("configuration", context.configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  }, session, sessionId);
  if (!response.ok) throw new Error(`Onshape part metadata lookup failed (${response.status}).`);
  const parts = await response.json().catch(() => null) as OnshapePartInfo[] | null;
  if (!Array.isArray(parts)) return {};
  const part = parts.find((candidate) => candidate.id === partId || candidate.partId === partId);
  if (!part) return {};
  const friendlyName = cleanSuggestion(part.name);
  const material = suggestedDxfMaterial(part.material?.displayName, part.material?.libraryName, part.material?.id);
  return {
    ...(friendlyName ? { friendlyName } : {}),
    ...(material ? { material } : {}),
  };
}

function roundedMeasurement(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function getDxfFaceBounds(
  context: ExportBody["context"],
  selection: ExportBody["selections"][number],
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<DxfBounds> {
  if (selection.entityType !== "FACE") throw new HttpError(422, "Select a planar face to measure its DXF stock envelope.");
  const endpoint = new URL(
    `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(context.documentId)}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(context.elementId)}/featurescript`,
  );
  endpoint.searchParams.set("rollbackBarIndex", "-1");
  if (context.configuration) endpoint.searchParams.set("configuration", context.configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json;charset=UTF-8; qs=0.09",
    },
    body: JSON.stringify({
      script: DXF_BOUNDS_FEATURESCRIPT,
      queries: { face: [selection.selectionId] },
    }),
  }, session, sessionId);
  const responseText = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status >= 400 && response.status < 500 ? 422 : 502, `Onshape could not measure the selected DXF face. ${responseText.slice(0, 500)}`.trim());
  }
  const payload = (() => {
    try { return JSON.parse(responseText) as unknown; } catch { return undefined; }
  })();
  const dimensions = featureScriptNumberArray(payload);
  const widthInches = dimensions?.[0];
  const heightInches = dimensions?.[1];
  if (!widthInches || !heightInches || widthInches <= 0 || heightInches <= 0) {
    throw new HttpError(502, "Onshape returned an invalid DXF face measurement.");
  }
  return {
    widthInches: roundedMeasurement(widthInches),
    heightInches: roundedMeasurement(heightInches),
    areaSquareInches: roundedMeasurement(widthInches * heightInches),
  };
}

async function getStepPartBounds(
  context: ExportBody["context"],
  partId: string,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<StepBounds> {
  const endpoint = new URL(
    `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(context.documentId)}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(context.elementId)}/featurescript`,
  );
  endpoint.searchParams.set("rollbackBarIndex", "-1");
  if (context.configuration) endpoint.searchParams.set("configuration", context.configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json;charset=UTF-8; qs=0.09",
    },
    body: JSON.stringify({
      script: STEP_BOUNDS_FEATURESCRIPT,
      queries: { part: [partId] },
    }),
  }, session, sessionId);
  const responseText = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status >= 400 && response.status < 500 ? 422 : 502, `Onshape could not measure the selected STEP part. ${responseText.slice(0, 500)}`.trim());
  }
  const payload = (() => {
    try { return JSON.parse(responseText) as unknown; } catch { return undefined; }
  })();
  const dimensions = featureScriptNumberArray(payload);
  const xInches = dimensions?.[0];
  const yInches = dimensions?.[1];
  const zInches = dimensions?.[2];
  if (!xInches || !yInches || !zInches || xInches <= 0 || yInches <= 0 || zInches <= 0) {
    throw new HttpError(502, "Onshape returned an invalid STEP part measurement.");
  }
  return {
    xInches: roundedMeasurement(xInches),
    yInches: roundedMeasurement(yInches),
    zInches: roundedMeasurement(zInches),
    volumeCubicInches: roundedMeasurement(xInches * yInches * zInches),
  };
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
  const partId = partIdForSelection(bodies, selection);
  if (partId) return partId;
  throw new HttpError(422, "The selected face no longer belongs to a part in the current Part Studio configuration.");
}

interface ExportPreview {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
}

interface StoredExportPreview {
  storagePath: string;
  fileName: string;
  contentType: ExportPreview["contentType"];
  byteLength: number;
}

const pendingPreviewRequests = new Map<string, Promise<StoredExportPreview>>();

function recognizedPreview(bytes: Buffer): ExportPreview | undefined {
  if (!bytes.length || bytes.length > MAX_PREVIEW_BYTES) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, contentType: "image/png", extension: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, contentType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { bytes, contentType: "image/webp", extension: "webp" };
  }
  return undefined;
}

function shadedViewCandidates(value: unknown, candidates: Array<string | Buffer>, depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") {
    if (value) candidates.push(value);
    return;
  }
  if (!Array.isArray(value) || !value.length) return;
  if (value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    candidates.push(Buffer.from(value as number[]));
    return;
  }
  const stringChunks = value.filter((item): item is string => typeof item === "string" && Boolean(item));
  if (stringChunks.length > 1) candidates.push(stringChunks.join(""));
  value.forEach((item) => shadedViewCandidates(item, candidates, depth + 1));
}

function decodeShadedView(payload: unknown): ExportPreview | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const images = (payload as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  const candidates: Array<string | Buffer> = [];
  shadedViewCandidates(images, candidates);
  for (const candidate of candidates) {
    const bytes = Buffer.isBuffer(candidate)
      ? candidate
      : Buffer.from(candidate.replace(/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i, "").replace(/\s+/g, ""), "base64");
    const recognized = recognizedPreview(bytes);
    if (recognized) return recognized;

    // Some older Onshape API versions wrap an already-base64 image in a
    // byte array, resulting in one additional encoding layer.
    const nestedBase64 = bytes.toString("ascii").replace(/\s+/g, "");
    if (nestedBase64.length && nestedBase64.length <= Math.ceil(MAX_PREVIEW_BYTES * 4 / 3) + 16 && /^[A-Za-z0-9+/_=-]+$/.test(nestedBase64)) {
      const nestedRecognized = recognizedPreview(Buffer.from(nestedBase64, "base64"));
      if (nestedRecognized) return nestedRecognized;
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

async function readCachedPartPreview(cacheId: string): Promise<StoredExportPreview | undefined> {
  const snapshot = await db.collection("onshapePreviewCache").doc(cacheId).get();
  if (!snapshot.exists) return undefined;
  const cached = snapshot.data() as {
    storagePath?: unknown;
    fileName?: unknown;
    contentType?: unknown;
    byteLength?: unknown;
    expiresAt?: unknown;
  };
  if (!(cached.expiresAt instanceof Timestamp) || cached.expiresAt.toMillis() <= Date.now()) return undefined;
  if (typeof cached.storagePath !== "string" || typeof cached.fileName !== "string") return undefined;
  if (!(["image/png", "image/jpeg", "image/webp"] as unknown[]).includes(cached.contentType)) return undefined;
  const byteLength = Number(cached.byteLength);
  if (!Number.isFinite(byteLength) || byteLength <= 0 || byteLength > MAX_PREVIEW_BYTES) return undefined;
  const [exists] = await getStorage().bucket(storageBucket.value() || undefined).file(cached.storagePath).exists();
  if (!exists) return undefined;
  return {
    storagePath: cached.storagePath,
    fileName: cached.fileName,
    contentType: cached.contentType as StoredExportPreview["contentType"],
    byteLength,
  };
}

async function getOrCreatePartPreview(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
  partId: string,
  viewMatrix: string,
): Promise<StoredExportPreview> {
  const cacheId = tokenHash(JSON.stringify({
    server: body.context.server,
    documentId: body.context.documentId,
    workspaceOrVersion: body.context.workspaceOrVersion,
    workspaceOrVersionId: body.context.workspaceOrVersionId,
    elementId: body.context.elementId,
    configuration: body.context.configuration ?? "",
    partId,
    viewMatrix,
    previewSize: PREVIEW_SIZE,
  }));
  const cached = await readCachedPartPreview(cacheId).catch((error: unknown) => {
    console.warn("Could not read the shaded-preview cache.", error);
    return undefined;
  });
  if (cached) return cached;
  const pending = pendingPreviewRequests.get(cacheId);
  if (pending) return pending;
  const request = (async () => {
    const preview = await getPartPreview(body, session, sessionId, version, partId, viewMatrix);
    if (!preview) throw new Error("Onshape returned no shaded preview.");
    const contentHash = createHash("sha256").update(preview.bytes).digest("hex");
    const fileName = `${contentHash}.${preview.extension}`;
    const storagePath = `manufacturing/previews/cache/${fileName}`;
    await getStorage().bucket(storageBucket.value() || undefined).file(storagePath).save(preview.bytes, {
      resumable: false,
      contentType: preview.contentType,
      metadata: {
        cacheControl: "private, max-age=31536000, immutable",
        metadata: {
          source: "onshape-shaded-view",
          cacheId,
          partId,
        },
      },
    });
    const stored: StoredExportPreview = {
      storagePath,
      fileName,
      contentType: preview.contentType,
      byteLength: preview.bytes.length,
    };
    const ttl = body.context.workspaceOrVersion === "w" ? WORKSPACE_PREVIEW_CACHE_MS : IMMUTABLE_PREVIEW_CACHE_MS;
    await db.collection("onshapePreviewCache").doc(cacheId).set({
      ...stored,
      expiresAt: Timestamp.fromMillis(Date.now() + ttl),
      createdAt: FieldValue.serverTimestamp(),
    }).catch((error: unknown) => {
      // The immutable Storage object is still usable for this export even if
      // the cache index cannot be written.
      console.warn("Could not write the shaded-preview cache.", error);
    });
    return stored;
  })();
  pendingPreviewRequests.set(cacheId, request);
  try {
    return await request;
  } finally {
    pendingPreviewRequests.delete(cacheId);
  }
}

async function selectedLathePartDetailsFromBodyDetails(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<{ partId: string; overallLengthInches: number }> {
  const bodies = await getPartStudioBodyDetails(body, session, sessionId, version);
  const owners = body.selections.map((selection) => bodies.find((candidate) =>
    (typeof candidate.id === "string" && candidate.id === selection.partId)
    || candidate.faces?.some((face) => face.id === selection.selectionId),
  ));
  if (owners.some((owner) => !owner || typeof owner.id !== "string" || !owner.id)) {
    throw new HttpError(422, "Onshape could not find the part that owns the selected lathe geometry.");
  }
  const partIds = new Set(owners.map((owner) => owner!.id as string));
  if (partIds.size !== 1) throw new HttpError(422, "All selected lathe geometry must belong to the same part.");
  const faces = body.selections.map((selection) => owners[0]!.faces?.find((face) => face.id === selection.selectionId));
  if (faces.some((face) => face?.surface?.type !== "PLANE")) {
    throw new HttpError(422, "Select two planar end faces for the lathe part.");
  }
  const origins = faces.map((face) => finiteVector(face?.surface?.origin));
  const normals = faces.map((face) => normalizedVector(
    face?.surface?.directionOrientedWithFace ?? face?.surface?.normal ?? face?.surface?.direction,
  ));
  if (!origins[0] || !origins[1] || !normals[0] || !normals[1]) {
    throw new HttpError(422, "Onshape did not return valid planes for the selected lathe end faces.");
  }
  if (Math.abs(dot(normals[0], normals[1])) < 0.999) {
    throw new HttpError(422, "The selected lathe end faces must be parallel.");
  }
  const separationMeters = Math.abs(dot([
    origins[1][0] - origins[0][0],
    origins[1][1] - origins[0][1],
    origins[1][2] - origins[0][2],
  ], normals[0]));
  const overallLengthInches = Math.round(separationMeters * METERS_TO_INCHES * 1_000_000) / 1_000_000;
  if (!Number.isFinite(overallLengthInches) || overallLengthInches <= 0) {
    throw new HttpError(422, "The selected lathe end faces do not define a positive overall length.");
  }
  return { partId: [...partIds][0], overallLengthInches };
}

async function selectedLathePartDetails(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  version: string,
): Promise<{ partId: string; overallLengthInches: number }> {
  const knownPartIds = new Set(body.selections.flatMap((selection) => {
    const partId = selection.partId
      ?? (selection.entityType === "BODY" ? selection.selectionId : undefined);
    return partId ? [partId] : [];
  }));
  if (knownPartIds.size > 1) {
    throw new HttpError(422, "All selected lathe geometry must belong to the same part.");
  }
  const partId = [...knownPartIds][0];
  if (!partId) {
    // Older/exceptional selection messages can omit the owning part ID. Body
    // details remains a one-call fallback for those messages only.
    return selectedLathePartDetailsFromBodyDetails(body, session, sessionId, version);
  }

  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = body.context;
  const endpoint = new URL(
    `${session.server}/api/${version}/partstudios/d/${encodeURIComponent(documentId)}/${workspaceOrVersion}/${encodeURIComponent(workspaceOrVersionId)}/e/${encodeURIComponent(elementId)}/featurescript`,
  );
  endpoint.searchParams.set("rollbackBarIndex", "-1");
  if (configuration) endpoint.searchParams.set("configuration", configuration);
  const response = await authorizedOnshapeFetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json;charset=UTF-8; qs=0.09",
    },
    body: JSON.stringify({
      script: LATHE_ANALYSIS_FEATURESCRIPT,
      queries: {
        part: [partId],
        faceA: [body.selections[0].selectionId],
        faceB: [body.selections[1].selectionId],
      },
    }),
  }, session, sessionId);
  const responseText = await response.text();
  if (!response.ok) {
    throw new HttpError(
      response.status >= 400 && response.status < 500 ? 422 : 502,
      `Onshape could not inspect the selected lathe faces. ${responseText.slice(0, 500)}`.trim(),
    );
  }
  const payload = (() => {
    try { return JSON.parse(responseText) as { result?: unknown }; } catch { return undefined; }
  })();
  const decoded = decodeFeatureScriptValue(payload?.result);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new HttpError(502, "Onshape returned invalid lathe measurements.");
  }
  const result = decoded as Record<string, unknown>;
  switch (result.status) {
    case "missingFace":
      throw new HttpError(422, "One or both selected lathe end faces no longer exist.");
    case "missingPart":
    case "partMismatch":
      throw new HttpError(422, "Onshape could not find the part that owns the selected lathe faces.");
    case "differentParts":
      throw new HttpError(422, "Both selected lathe end faces must belong to the same part.");
    case "notPlanar":
      throw new HttpError(422, "Select two planar end faces for the lathe part.");
    case "notParallel":
      throw new HttpError(422, "The selected lathe end faces must be parallel.");
    case "noLength":
      throw new HttpError(422, "The selected lathe end faces do not define a positive overall length.");
    case "ok":
      break;
    default:
      throw new HttpError(502, "Onshape returned an unknown lathe measurement result.");
  }
  const overallLengthInches = roundedMeasurement(Number(result.overallLengthInches));
  if (!Number.isFinite(overallLengthInches) || overallLengthInches <= 0) {
    throw new HttpError(422, "The selected lathe end faces do not define a positive overall length.");
  }
  return { partId, overallLengthInches };
}

async function callOnshapeExport(
  body: ExportBody,
  session: StoredSession,
  sessionId: string,
  resolvedPartId?: string,
  resolvedFaceView?: string,
  exportTarget: ResolvedSelections["exportTarget"] = { context: body.context },
  linkDocumentId?: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  if (body.context.server !== session.server || exportTarget.context.server !== session.server) {
    throw new HttpError(400, "The selected document does not match the connected Onshape server.");
  }
  if (body.kind === "step") {
    if (!resolvedPartId) throw new HttpError(422, "The selected geometry no longer belongs to a supported part.");
    const source = body.context;
    const stlEndpoint = new URL(
      `${session.server}/api/${apiVersion.value().replace(/^\//, "")}/parts/d/${encodeURIComponent(source.documentId)}/${source.workspaceOrVersion}/${encodeURIComponent(source.workspaceOrVersionId)}/e/${encodeURIComponent(source.elementId)}/partid/${encodeURIComponent(resolvedPartId)}/stl`,
    );
    stlEndpoint.searchParams.set("mode", "binary");
    stlEndpoint.searchParams.set("grouping", "true");
    stlEndpoint.searchParams.set("scale", "1");
    // STL has no embedded unit metadata. Millimeter coordinates match the
    // convention used by classroom slicers and prevent 25.4x scale errors.
    stlEndpoint.searchParams.set("units", "millimeter");
    if (source.configuration) stlEndpoint.searchParams.set("configuration", source.configuration);
    if (linkDocumentId && linkDocumentId !== source.documentId) {
      stlEndpoint.searchParams.set("linkDocumentId", linkDocumentId);
    }
    const stlResponse = await authorizedOnshapeFetch(stlEndpoint.toString(), {
      method: "GET",
      headers: { Accept: "model/stl, application/sla, application/octet-stream" },
      redirect: "follow",
    }, session, sessionId);
    if (!stlResponse.ok) {
      const detail = (await stlResponse.text()).slice(0, 500);
      throw new HttpError(stlResponse.status >= 400 && stlResponse.status < 500 ? 422 : 502, `Onshape could not create this STL export. ${detail}`.trim());
    }
    const declaredLength = Number(stlResponse.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EXPORT_BYTES) {
      throw new HttpError(413, "The export is larger than the 250 MB classroom limit.");
    }
    const bytes = Buffer.from(await stlResponse.arrayBuffer());
    if (!bytes.length) throw new HttpError(502, "Onshape returned an empty STL export.");
    if (bytes.length > MAX_EXPORT_BYTES) throw new HttpError(413, "The export is larger than the 250 MB classroom limit.");
    return { bytes, contentType: "model/stl" };
  }
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId, configuration } = exportTarget.context;
  const version = apiVersion.value().replace(/^\//, "");
  let endpoint: string;
  let publicDxfEndpoint: string | undefined;
  let payload: Record<string, unknown>;
  if (body.kind === "dxf") {
    if (exportTarget.context.contextType === "assembly") {
      throw new HttpError(422, "Onshape did not provide an exportable Part Studio workspace or version for this assembly face.");
    }
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
      ...(workspaceOrVersion === "w" ? { workspaceId: workspaceOrVersionId } : {}),
      ...(workspaceOrVersion === "v" ? { documentVersionId: workspaceOrVersionId } : {}),
      ...(configuration ? { configuration } : {}),
    };
  } else {
    throw new HttpError(400, "This request does not create an Onshape export file.");
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
  let nextPollMs = EXPORT_RESULT_POLL_MS;
  const waitForExportResult = async () => {
    await new Promise((resolve) => setTimeout(resolve, nextPollMs));
    nextPollMs = Math.min(nextPollMs * 2, EXPORT_RESULT_MAX_POLL_MS);
  };
  while (true) {
    if (!response.ok) {
      const retryable = Boolean(resultUrl) && [404, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (retryable && Date.now() < deadline) {
        await waitForExportResult();
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
    await waitForExportResult();
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

async function handleExportSuggestions(req: Request, res: Response): Promise<void> {
  const { id: sessionId, data: session } = await loadSession(req);
  if (!req.body || typeof req.body !== "object") throw new HttpError(400, "A JSON request body is required.");
  const raw = req.body as { context?: unknown; selection?: unknown; kind?: unknown };
  const context = parseOnshapeContext(raw.context);
  if (context.server !== session.server) {
    throw new HttpError(400, "The selected document does not match the connected Onshape server.");
  }
  const selection = raw.selection === undefined ? undefined : parseOnshapeSelection(raw.selection);
  const suggestionKind = raw.kind === undefined ? undefined
    : raw.kind === "dxf" || raw.kind === "step" || raw.kind === "lathe" ? raw.kind
      : (() => { throw new HttpError(400, "Invalid export type."); })();
  const version = apiVersion.value().replace(/^\//, "");
  const kind = suggestionKind ?? "step";
  if (!selection) {
    const subsystem = await cachedDocumentName(context, session, sessionId, version).catch((error: unknown) => {
      console.warn("Could not suggest the Onshape document name.", error);
      return undefined;
    });
    res.json({ ...(subsystem ? { subsystem } : {}), partMetadataFound: false });
    return;
  }

  const cacheId = exportSuggestionCacheId(session.user.id, context, selection, kind);
  const cached = await readCachedExportSuggestions(cacheId);
  if (cached) {
    res.json(cached.result);
    return;
  }

  const subsystemPromise = cachedDocumentName(context, session, sessionId, version).catch((error: unknown) => {
    console.warn("Could not suggest the Onshape document name.", error);
    return undefined;
  });
  const resolved = await resolveAssemblySelections(context, [selection], session, sessionId, version);
  const sourceContext = resolved.context;
  const sourceSelection = resolved.selections[0];
  let partId = sourceSelection.partId
    ?? (sourceSelection.entityType === "BODY" ? sourceSelection.selectionId : undefined);
  if (!partId) {
    // Some Part Studio face-selection messages omit the owning part. Pay for a
    // body-details lookup only in that exceptional case.
    const bodies = await getPartStudioBodyDetails({ context: sourceContext }, session, sessionId, version);
    partId = partIdForSelection(bodies, sourceSelection);
  }
  const instanceName = cleanSuggestion(sourceSelection.name);
  let analysis: OnshapePartAnalysis | undefined;
  if (partId) {
    analysis = await getOnshapePartAnalysis(
      sourceContext,
      partId,
      kind === "dxf" && sourceSelection.entityType === "FACE" ? sourceSelection.selectionId : undefined,
      session,
      sessionId,
      version,
    ).catch((error: unknown) => {
      // Under a hard annual API quota, do not cascade into several legacy
      // metadata/measurement requests when the combined call fails.
      console.warn("Could not run the combined Onshape part analysis.", error);
      return undefined;
    });
  }
  const needsMetadataFallback = Boolean(partId) && !analysis && (
    !instanceName || kind === "dxf" || kind === "lathe"
  );
  const metadataFallback: Pick<OnshapePartAnalysis, "friendlyName" | "material"> = needsMetadataFallback && partId
    ? await getPartMetadataSuggestion(sourceContext, partId, session, sessionId, version).catch((error: unknown) => {
        console.warn("Could not read fallback Onshape part metadata.", error);
        return {};
      })
    : {};
  const subsystem = await subsystemPromise;
  const result: ExportSuggestionResult = {
    partMetadataFound: Boolean(partId && (analysis || metadataFallback.friendlyName || metadataFallback.material)),
    ...(subsystem ? { subsystem } : {}),
    ...(analysis?.material || metadataFallback.material ? { material: analysis?.material ?? metadataFallback.material } : {}),
    ...(analysis?.friendlyName || instanceName || metadataFallback.friendlyName
      ? { friendlyName: analysis?.friendlyName ?? instanceName ?? metadataFallback.friendlyName }
      : {}),
    ...(kind === "dxf" && analysis?.dxfBounds ? { dxfBounds: analysis.dxfBounds } : {}),
    ...(kind === "step" && analysis?.stepBounds ? { stepBounds: analysis.stepBounds } : {}),
  };
  await writeCachedExportSuggestions(cacheId, context, {
    result,
    resolved,
    ...(partId ? { partId } : {}),
    ...(analysis?.faceView ? { faceView: analysis.faceView } : {}),
  });
  res.json(result);
}

async function handleExport(req: Request, res: Response): Promise<void> {
  const { id: sessionId, data: session } = await loadSession(req);
  const submittedBody = parseExportBody(req.body);
  if (submittedBody.context.server !== session.server) throw new HttpError(400, "The selected document does not match the connected Onshape server.");
  const version = apiVersion.value().replace(/^\//, "");
  const suggestionCache = await readCachedExportSuggestions(exportSuggestionCacheId(
    session.user.id,
    submittedBody.context,
    submittedBody.selections[0],
    submittedBody.kind,
  ));
  const cachedLatheOccurrenceMatches = submittedBody.kind === "lathe" && suggestionCache
    && (submittedBody.context.contextType !== "assembly"
      || (submittedBody.selections.every((selection) => Array.isArray(selection.occurrencePath))
        && submittedBody.selections.every((selection) =>
          selection.occurrencePath!.join("/") === submittedBody.selections[0].occurrencePath!.join("/"))));
  const cachedResolved = submittedBody.kind !== "lathe"
    ? suggestionCache?.resolved
    : cachedLatheOccurrenceMatches && suggestionCache
      ? {
          ...suggestionCache.resolved,
          selections: submittedBody.selections.map((selection) => ({
            ...selection,
            ...(suggestionCache.partId ? { partId: suggestionCache.partId } : {}),
          })),
        }
      : undefined;
  const resolved = cachedResolved
    ?? await resolveAssemblySelections(submittedBody.context, submittedBody.selections, session, sessionId, version);
  const body: ExportBody = { ...submittedBody, context: resolved.context, selections: resolved.selections };
  const assemblyContext = submittedBody.context.contextType === "assembly" ? submittedBody.context : undefined;
  const exportId = db.collection("exports").doc().id;
  if (body.kind === "lathe") {
    const { partId, overallLengthInches } = await selectedLathePartDetails(body, session, sessionId, version);
    const preview = await getOrCreatePartPreview(body, session, sessionId, version, partId, ISOMETRIC_VIEW_MATRIX).catch((error: unknown) => {
      console.error("Could not create Onshape lathe preview.", error);
      return undefined;
    });
    const previewFileName = preview?.fileName;
    const previewStoragePath = preview?.storagePath;
    const requestMetadata = withoutUndefined({ ...body, assemblyContext }) as Record<string, unknown>;
    await db.collection("exports").doc(exportId).set({
      ...requestMetadata,
      partId,
      overallLengthInches,
      previewStatus: preview ? "complete" : "unavailable",
      ...(preview && previewFileName && previewStoragePath ? {
        previewFileName,
        previewStoragePath,
        previewByteLength: preview.byteLength,
        previewContentType: preview.contentType,
        previewWidth: PREVIEW_SIZE,
        previewHeight: PREVIEW_SIZE,
      } : {}),
      requestedBy: session.user,
      sessionId,
      status: "queued",
      createdAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ exportId, kind: body.kind, previewStoragePath });
    return;
  }
  let partId = suggestionCache?.partId
    ?? body.selections[0].partId
    ?? (body.selections[0].entityType === "BODY" ? body.selections[0].selectionId : undefined);
  let faceView = body.kind === "dxf" ? suggestionCache?.faceView : undefined;
  if (!partId || (body.kind === "dxf" && !faceView)) {
    const bodyDetails = await getPartStudioBodyDetails(body, session, sessionId, version);
    partId = partId ?? await selectedPartId(body, session, sessionId, version, bodyDetails);
    faceView = body.kind === "dxf"
      ? faceView ?? await selectedFaceView(body, session, sessionId, version, bodyDetails)
      : undefined;
  }
  if (!partId) throw new HttpError(422, "The selected geometry no longer belongs to a supported part.");
  const previewView = faceView ? faceView.split(",").slice(0, 12).join(",") : ISOMETRIC_VIEW_MATRIX;
  const previewPromise = getOrCreatePartPreview(body, session, sessionId, version, partId, previewView).catch((error: unknown) => {
    console.error("Could not create Onshape export preview.", error);
    return undefined;
  });
  const dxfBoundsPromise = body.kind === "dxf" && !suggestionCache
    ? getDxfFaceBounds(body.context, body.selections[0], session, sessionId, version).catch((error: unknown) => {
        console.error("Could not measure the exported DXF face.", error);
        return undefined;
      })
    : Promise.resolve(suggestionCache?.result.dxfBounds);
  const stepBoundsPromise = body.kind === "step" && !suggestionCache
    ? getStepPartBounds(body.context, partId, session, sessionId, version).catch((error: unknown) => {
        console.error("Could not measure the exported 3D-print part.", error);
        return undefined;
      })
    : Promise.resolve(suggestionCache?.result.stepBounds);
  const [{ bytes, contentType }, preview, dxfBounds, stepBounds] = await Promise.all([
    callOnshapeExport(body, session, sessionId, partId, faceView, resolved.exportTarget, assemblyContext?.documentId),
    previewPromise,
    dxfBoundsPromise,
    stepBoundsPromise,
  ]);
  const extension = body.kind === "step" ? "stl" : body.kind;
  const fileFormat = body.kind === "step" ? "STL" : "DXF";
  const fileName = `${safeFileStem(body.friendlyName)}-${exportId.slice(0, 8)}.${extension}`;
  const dateFolder = new Date().toISOString().slice(0, 10);
  const storagePath = `manufacturing/${body.kind}/${dateFolder}/${fileName}`;
  const previewFileName = preview?.fileName;
  const previewStoragePath = preview?.storagePath;
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
    fileFormat,
    ...(previewStoragePath ? { previewStoragePath } : {}),
    ...(body.material ? { material: body.material } : {}),
    ...(body.materialThicknessInches ? { materialThicknessInches: String(body.materialThicknessInches) } : {}),
    ...(body.subsystem ? { subsystem: body.subsystem } : {}),
    ...(dxfBounds ? {
      dxfWidthInches: String(dxfBounds.widthInches),
      dxfHeightInches: String(dxfBounds.heightInches),
      dxfAreaSquareInches: String(dxfBounds.areaSquareInches),
    } : {}),
    ...(stepBounds ? {
      stepXInches: String(stepBounds.xInches),
      stepYInches: String(stepBounds.yInches),
      stepZInches: String(stepBounds.zInches),
      stepBoundingVolumeCubicInches: String(stepBounds.volumeCubicInches),
    } : {}),
  };
  const uploads: Promise<unknown>[] = [bucket.file(storagePath).save(bytes, {
    resumable: false,
    contentType,
    metadata: { cacheControl: "private, max-age=0", metadata: customMetadata },
  })];
  await Promise.all(uploads);
  const exportRequestMetadata = withoutUndefined({ ...body, assemblyContext }) as Record<string, unknown>;
  await db.collection("exports").doc(exportId).set({
    ...exportRequestMetadata,
    partId,
    fileName,
    storagePath,
    byteLength: bytes.length,
    contentType,
    fileFormat,
    previewStatus: preview ? "complete" : "unavailable",
    ...(body.kind === "dxf" ? { dxfBoundsStatus: dxfBounds ? "complete" : "unavailable" } : {}),
    ...(dxfBounds ? { dxfBounds } : {}),
    ...(body.kind === "step" ? { stepBoundsStatus: stepBounds ? "complete" : "unavailable" } : {}),
    ...(stepBounds ? { stepBounds } : {}),
    ...(preview && previewFileName && previewStoragePath ? {
      previewFileName,
      previewStoragePath,
      previewByteLength: preview.byteLength,
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
  if (req.method === "POST" && path === "/export-suggestions") return handleExportSuggestions(req, res);
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
