import type { OnshapeContext, OnshapeSelection } from "./types";

type UnknownRecord = Record<string, unknown>;

function resolvedParameter(value: string | null): string | undefined {
  const clean = value?.trim();
  if (!clean || /^\{\$[^{}]+\}$/.test(clean)) return undefined;
  return clean;
}

function normalizeOrigin(value: string | null): string {
  if (!value) return "https://cad.onshape.com";
  try {
    return new URL(value).origin;
  } catch {
    return "https://cad.onshape.com";
  }
}

export function readOnshapeContext(url: URL): OnshapeContext | null {
  const p = url.searchParams;
  const pathMatch = url.pathname.match(/\/documents\/([^/]+)\/(w|v)\/([^/]+)\/e\/([^/]+)/);
  const documentId = resolvedParameter(p.get("documentId")) ?? pathMatch?.[1] ?? "";
  const explicitWv = resolvedParameter(p.get("workspaceOrVersion"));
  const workspaceOrVersion = explicitWv === "v" || (!explicitWv && Boolean(resolvedParameter(p.get("versionId")))) ? "v" : "w";
  const workspaceOrVersionId =
    resolvedParameter(p.get("workspaceOrVersionId")) ??
    (workspaceOrVersion === "v" ? resolvedParameter(p.get("versionId")) : resolvedParameter(p.get("workspaceId"))) ??
    pathMatch?.[3] ??
    "";
  const elementId = resolvedParameter(p.get("elementId")) ?? resolvedParameter(p.get("tabElementId")) ?? pathMatch?.[4] ?? "";

  if (!documentId || !workspaceOrVersionId || !elementId) return null;

  return {
    documentId,
    workspaceOrVersion,
    workspaceOrVersionId,
    elementId,
    server: normalizeOrigin(p.get("server")),
    configuration: resolvedParameter(p.get("configuration")),
    onshapeUserId: resolvedParameter(p.get("userId")),
  };
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null;
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
}

type SelectionEntityType = OnshapeSelection["entityType"];

export function selectionsFromMessage(data: unknown, allowedTypes: readonly SelectionEntityType[]): OnshapeSelection[] {
  const root = asRecord(data);
  if (!root || root.messageName !== "SELECTION") return [];

  const candidates: UnknownRecord[] = [];
  const selections = root.selections;
  if (Array.isArray(selections)) {
    for (const item of selections) {
      const record = asRecord(item);
      if (record) candidates.push(record);
    }
  }
  const single = asRecord(root.selection);
  if (single) candidates.push(single);
  candidates.push(root);

  const parsed: OnshapeSelection[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const declaredType = firstString(candidate, ["entityType", "entityTypeSpecifier"])?.toUpperCase();
    const selectionType = firstString(candidate, ["selectionType", "type"])?.toUpperCase();
    const candidateType = declaredType ?? selectionType;
    const rawType: SelectionEntityType | undefined = candidateType === "FACE" ? "FACE"
      : candidateType === "BODY" || candidateType === "PART" || candidateType === "SOLID" ? "BODY" : undefined;
    if (rawType && !allowedTypes.includes(rawType)) continue;
    const selectionId = firstString(candidate, [
      "selectionId",
      "deterministicId",
      "geometryId",
      "entityId",
      "id",
    ]);
    if (!selectionId) continue;
    const entityType = rawType ?? (candidate.bodyType ? "BODY" : allowedTypes[0]);
    if (!entityType || !allowedTypes.includes(entityType)) continue;
    const key = `${entityType}:${selectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({
      entityType,
      selectionId,
      partId: firstString(candidate, ["partId", "idTag"]),
      name: firstString(candidate, ["name", "partName"]),
    });
  }
  return parsed;
}

export function selectionFromMessage(data: unknown, allowedTypes: readonly SelectionEntityType[]): OnshapeSelection | null {
  return selectionsFromMessage(data, allowedTypes)[0] ?? null;
}

export function postToOnshape(context: OnshapeContext, message: UnknownRecord): void {
  window.parent.postMessage(
    {
      documentId: context.documentId,
      workspaceId: context.workspaceOrVersionId,
      elementId: context.elementId,
      ...message,
    },
    context.server,
  );
}
