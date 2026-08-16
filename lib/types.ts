export type ExportKind = "dxf" | "step" | "lathe";
export type MachiningType = "laser" | "plasma" | "waterjet" | "3d printed" | "lathe";
export type Material = "wood" | "aluminum" | "aluminum 7075" | "steel" | "SRPP" | "polycarb" | "carbon fiber" | "3D Print";
export type LatheStockType =
  | "1/2 true hex"
  | "1/2 rounded hex"
  | "3/8 true hex"
  | "3/8 rounded hex"
  | "round shaft"
  | "round tube";
export type LatheEndOperationType = "leave as modeled" | "turn down" | "tap" | "drill" | "other";

export interface LatheEndOperation {
  operation: LatheEndOperationType;
  diameterInches?: number;
  lengthInches?: number;
  thread?: string;
  depthInches?: number;
  notes?: string;
}

export interface LatheDetails {
  stockType: LatheStockType;
  diameterInches?: number;
  outerDiameterInches?: number;
  innerDiameterInches?: number;
  endA: LatheEndOperation;
  endB: LatheEndOperation;
  endReference?: string;
}

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
  materialThicknessInches?: number;
  subsystem?: string;
  context: OnshapeContext;
  selections: OnshapeSelection[];
  lathe?: LatheDetails;
}

export interface ExportResult {
  exportId: string;
  kind: ExportKind;
  storagePath?: string;
  fileName?: string;
  previewStoragePath?: string;
}
