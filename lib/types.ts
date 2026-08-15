export type ExportKind = "dxf" | "step";
export type MachiningType = "laser" | "plasma" | "waterjet" | "3d printed";
export type Material = "wood" | "aluminum" | "steel" | "SRPP" | "polycarb" | "carbon fiber";

export interface OnshapeContext {
  documentId: string;
  workspaceOrVersion: "w" | "v";
  workspaceOrVersionId: string;
  elementId: string;
  server: string;
  configuration?: string;
  onshapeUserId?: string;
}

export interface OnshapeSelection {
  entityType: "FACE" | "BODY";
  selectionId: string;
  partId?: string;
  name?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email?: string;
}

export interface ExportRequest {
  kind: ExportKind;
  friendlyName: string;
  quantity: number;
  machiningType: MachiningType;
  material?: Material;
  subsystem?: string;
  context: OnshapeContext;
  selection: OnshapeSelection;
}

export interface ExportResult {
  exportId: string;
  storagePath: string;
  fileName: string;
}
