"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createExport, disconnectSession, getApiBase, getExportSuggestions, getSession } from "@/lib/api";
import { postToOnshape, readOnshapeContext, selectionsFromMessage } from "@/lib/onshape";
import type {
  DxfBounds,
  ExportKind,
  LatheEndOperation,
  LatheStockType,
  Material,
  OnshapeContext,
  OnshapeSelection,
  SessionUser,
} from "@/lib/types";

type DxfMachiningType = "laser" | "plasma" | "waterjet";

const dxfMaterialsByMachining: Record<DxfMachiningType, Material[]> = {
  laser: ["SRPP", "polycarb", "wood"],
  plasma: ["steel", "aluminum 6061", "aluminum 7075", "aluminum 5052"],
  waterjet: ["wood", "aluminum 6061", "aluminum 7075", "aluminum 5052", "steel", "SRPP", "polycarb", "carbon fiber"],
};
const latheMaterials: Material[] = ["aluminum 7075", "polycarb", "steel", "carbon fiber"];
const preferredMachiningByMaterial: Partial<Record<Material, DxfMachiningType>> = {
  wood: "laser",
  polycarb: "laser",
  SRPP: "laser",
  "aluminum 6061": "waterjet",
  "aluminum 7075": "waterjet",
  "aluminum 5052": "waterjet",
  steel: "plasma",
  "carbon fiber": "waterjet",
};
const latheStockTypes: LatheStockType[] = [
  "1/2 true hex",
  "1/2 rounded hex",
  "3/8 true hex",
  "3/8 rounded hex",
  "round shaft",
  "round tube",
];

function formatInches(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
const SESSION_KEY = "shop-export-session";
const THEME_KEY = "shop-export-theme";

type Theme = "light" | "dark";
type SubmissionState = "idle" | "working" | "complete" | "error";

const subscribeToBrowser = () => () => undefined;

function SunIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z"/></svg>;
}

function CubeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4.4 6.7 7.6 4.2 7.6-4.2M12 11v9"/></svg>;
}

function FaceIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="m4 14 5-5 3 3 3-3 5 5"/></svg>;
}

function LatheIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3l2-2h8l2 2h3v8h-3l-2 2H8l-2-2H3z"/><path d="M8 9v6m8-6v6M2 19h20"/></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>;
}

function blankEndOperation(): LatheEndOperation {
  return { operation: "leave as modeled" };
}

function defaultEndOperation(operation: LatheEndOperation["operation"]): LatheEndOperation {
  return operation === "tap"
    ? { operation, thread: "10-32", depthInches: 1 }
    : { operation };
}

function selectionTypesForKind(kind: ExportKind): readonly OnshapeSelection["entityType"][] {
  return kind === "step" ? ["BODY", "FACE"] : ["FACE"];
}

function compatibleSelectionsForKind(kind: ExportKind, selections: OnshapeSelection[]): OnshapeSelection[] {
  const compatible = selections.filter((selection) => selectionTypesForKind(kind).includes(selection.entityType));
  return compatible.slice(0, kind === "lathe" ? 2 : 1);
}

function positive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function endOperationComplete(value: LatheEndOperation): boolean {
  if (value.operation === "turn down") return positive(value.diameterInches) && positive(value.lengthInches);
  if (value.operation === "tap") return Boolean(value.thread?.trim()) && positive(value.depthInches);
  if (value.operation === "drill") return positive(value.diameterInches) && positive(value.depthInches);
  if (value.operation === "other") return Boolean(value.notes?.trim());
  return true;
}

function optionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

function EndOperationFields({
  title,
  subtitle,
  value,
  onChange,
  defaultOpen = false,
}: {
  title: string;
  subtitle: string;
  value: LatheEndOperation;
  onChange: (next: LatheEndOperation) => void;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const update = (changes: Partial<LatheEndOperation>) => onChange({ ...value, ...changes });
  const operationLabel = value.operation.replace(/\b\w/g, (character) => character.toUpperCase());
  const incomplete = !endOperationComplete(value);
  return (
    <details className={`end-operation ${incomplete ? "missing" : ""}`} open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary><span><strong>{title}</strong><small>{subtitle} · {operationLabel}</small></span></summary>
      <div className="end-operation-fields">
        <label className="field span-2"><span>Operation</span><select value={value.operation} onChange={(event) => onChange(defaultEndOperation(event.target.value as LatheEndOperation["operation"]))}><option value="leave as modeled">Leave as modeled</option><option value="turn down">Turn down for bearing</option><option value="tap">Tap</option><option value="drill">Drill</option><option value="other">Other</option></select></label>
        {value.operation === "turn down" && <><label className={`field ${positive(value.diameterInches) ? "" : "missing"}`}><span>Target diameter <em>in</em></span><input aria-invalid={!positive(value.diameterInches)} type="number" min="0.001" max="100" step="any" value={value.diameterInches ?? ""} onChange={(event) => update({ diameterInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.375" required /></label><label className={`field ${positive(value.lengthInches) ? "" : "missing"}`}><span>Turned length <em>in</em></span><input aria-invalid={!positive(value.lengthInches)} type="number" min="0.001" max="100" step="any" value={value.lengthInches ?? ""} onChange={(event) => update({ lengthInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.5" required /></label></>}
        {value.operation === "tap" && <><label className={`field ${value.thread?.trim() ? "" : "missing"}`}><span>Thread</span><input aria-invalid={!value.thread?.trim()} value={value.thread ?? ""} onChange={(event) => update({ thread: event.target.value })} placeholder="e.g. 1/4-20" maxLength={40} required /></label><label className={`field ${positive(value.depthInches) ? "" : "missing"}`}><span>Thread depth <em>in</em></span><input aria-invalid={!positive(value.depthInches)} type="number" min="0.001" max="100" step="any" value={value.depthInches ?? ""} onChange={(event) => update({ depthInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.75" required /></label></>}
        {value.operation === "drill" && <><label className={`field ${positive(value.diameterInches) ? "" : "missing"}`}><span>Hole diameter <em>in</em></span><input aria-invalid={!positive(value.diameterInches)} type="number" min="0.001" max="100" step="any" value={value.diameterInches ?? ""} onChange={(event) => update({ diameterInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.25" required /></label><label className={`field ${positive(value.depthInches) ? "" : "missing"}`}><span>Hole depth <em>in</em></span><input aria-invalid={!positive(value.depthInches)} type="number" min="0.001" max="100" step="any" value={value.depthInches ?? ""} onChange={(event) => update({ depthInches: optionalNumber(event.target.value) })} placeholder="e.g. 1.0" required /></label></>}
        {value.operation === "other" && <label className={`field span-2 ${value.notes?.trim() ? "" : "missing"}`}><span>Instructions</span><textarea aria-invalid={!value.notes?.trim()} value={value.notes ?? ""} onChange={(event) => update({ notes: event.target.value })} placeholder="Describe the operation and dimensions" maxLength={300} required /></label>}
      </div>
    </details>
  );
}

export function ExportApp() {
  const browserReady = useSyncExternalStore(subscribeToBrowser, () => true, () => false);
  const context = useMemo<OnshapeContext | null>(
    () => browserReady ? readOnshapeContext(new URL(window.location.href)) : null,
    [browserReady],
  );
  const embedded = browserReady && window.parent !== window;
  const [kind, setKind] = useState<ExportKind>("dxf");
  const [selections, setSelections] = useState<OnshapeSelection[]>([]);
  const [selecting, setSelecting] = useState(false);
  const allowedSelectionTypes = useRef<readonly OnshapeSelection["entityType"][]>(["FACE"]);
  const expectedSelectionCount = useRef(1);
  const selectionRequestActive = useRef(false);
  const [themeOverride, setThemeOverride] = useState<Theme | null>(null);
  const theme = useMemo<Theme>(() => {
    if (themeOverride) return themeOverride;
    if (!browserReady) return "light";
    const saved = localStorage.getItem(THEME_KEY) as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }, [browserReady, themeOverride]);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [friendlyName, setFriendlyName] = useState("");
  const friendlyNameEdited = useRef(false);
  const [quantity, setQuantity] = useState(1);
  const [machining, setMachining] = useState<DxfMachiningType>("laser");
  const machiningRef = useRef<DxfMachiningType>("laser");
  const [material, setMaterial] = useState<Material>("wood");
  const [materialThickness, setMaterialThickness] = useState<number | undefined>();
  const [dxfBoundsResult, setDxfBoundsResult] = useState<{
    requestKey: string;
    status: "complete" | "unavailable";
    bounds?: DxfBounds;
  } | null>(null);
  const [subsystem, setSubsystem] = useState("");
  const materialEdited = useRef(false);
  const machiningEdited = useRef(false);
  const subsystemEdited = useRef(false);
  const suggestionRequest = useRef(0);
  const lastSuggestionSelectionKey = useRef("");
  const lastSuggestionRequestKey = useRef("");
  const [latheStockType, setLatheStockType] = useState<LatheStockType>("1/2 rounded hex");
  const [latheDiameter, setLatheDiameter] = useState<number | undefined>();
  const [tubeOuterDiameter, setTubeOuterDiameter] = useState<number | undefined>();
  const [tubeInnerDiameter, setTubeInnerDiameter] = useState<number | undefined>();
  const [endA, setEndA] = useState<LatheEndOperation>(blankEndOperation);
  const [endB, setEndB] = useState<LatheEndOperation>(blankEndOperation);
  const [endReference, setEndReference] = useState("");
  const [submission, setSubmission] = useState<SubmissionState>("idle");
  const [message, setMessage] = useState("");

  const requiredSelectionCount = kind === "lathe" ? 2 : 1;

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const returnedSession = fragment.get("oauthSession");
    const oauthError = fragment.get("oauthError");
    if (returnedSession || oauthError) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (oauthError) {
      queueMicrotask(() => {
        setSubmission("error");
        setMessage(oauthError);
      });
    }
    const savedSession = returnedSession ?? sessionStorage.getItem(SESSION_KEY);
    if (savedSession) {
      if (returnedSession) sessionStorage.setItem(SESSION_KEY, returnedSession);
      getSession(savedSession).then(({ user: restored }) => {
        setSessionToken(savedSession);
        setUser(restored);
      }).catch(() => {
        sessionStorage.removeItem(SESSION_KEY);
      });
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    setThemeOverride(next);
  };

  useEffect(() => {
    if (!context) return;
    const handler = (event: MessageEvent) => {
      if (event.origin !== context.server) return;
      const parsed = selectionsFromMessage(event.data, allowedSelectionTypes.current);
      if (parsed.length) {
        setSelections((current) => {
          const count = expectedSelectionCount.current;
          const requested = selectionRequestActive.current;
          const candidates = requested && count > 1 ? [...current, ...parsed] : parsed;
          const accepted = candidates.filter((selection, index, all) =>
            all.findIndex((candidate) => candidate.entityType === selection.entityType && candidate.selectionId === selection.selectionId) === index,
          ).slice(0, count);
          if (requested) {
            const pending = accepted.length < count;
            selectionRequestActive.current = pending;
            setSelecting(pending);
          } else {
            setSelecting(false);
          }
          return accepted;
        });
      }
    };
    window.addEventListener("message", handler);
    postToOnshape(context, { messageName: "applicationInit" });
    return () => window.removeEventListener("message", handler);
  }, [context]);

  const selectTarget = useCallback((replaceExisting = false) => {
    if (!context) return;
    if (selectionRequestActive.current) postToOnshape(context, { messageName: "stopRequest" });
    const entityTypes = selectionTypesForKind(kind);
    const preserved = !replaceExisting && kind === "lathe" && selections.length === 1 && selections[0].entityType === "FACE"
      ? selections
      : [];
    const selectionCount = kind === "lathe" ? 2 : 1;
    const requestedSelectionCount = selectionCount - preserved.length;
    allowedSelectionTypes.current = entityTypes;
    expectedSelectionCount.current = selectionCount;
    selectionRequestActive.current = true;
    setSelections(preserved);
    setSelecting(true);
    setMessage("");
    postToOnshape(context, {
      messageName: "requestSelection",
      messageId: crypto.randomUUID(),
      entityTypeSpecifier: entityTypes,
      requiredSelectionCount: requestedSelectionCount,
    });
  }, [context, kind, selections]);

  const changeKind = (next: ExportKind) => {
    if (context && selectionRequestActive.current) postToOnshape(context, { messageName: "stopRequest" });
    selectionRequestActive.current = false;
    allowedSelectionTypes.current = selectionTypesForKind(next);
    expectedSelectionCount.current = next === "lathe" ? 2 : 1;
    setKind(next);
    if (next === "lathe" && !latheMaterials.includes(material)) setMaterial("aluminum 7075");
    if (next === "dxf" && !dxfMaterialsByMachining[machining].includes(material)) {
      setMaterial(dxfMaterialsByMachining[machining][0]);
    }
    setSelections((current) => compatibleSelectionsForKind(next, current));
    setSelecting(false);
    setSubmission("idle");
    setMessage("");
  };

  const changeMachining = (next: DxfMachiningType) => {
    machiningEdited.current = true;
    machiningRef.current = next;
    setMachining(next);
    if (!dxfMaterialsByMachining[next].includes(material)) setMaterial(dxfMaterialsByMachining[next][0]);
    setSubmission("idle");
    setMessage("");
  };

  const changeLatheStock = (next: LatheStockType) => {
    setLatheStockType(next);
    setSubmission("idle");
    setMessage("");
  };

  const signIn = () => {
    if (!context) return;
    const apiBase = getApiBase();
    if (!apiBase) {
      setMessage("The Firebase API URL has not been configured.");
      return;
    }
    const url = new URL(`${apiBase}/oauth/start`);
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = "";
    url.searchParams.set("returnUrl", returnUrl.toString());
    url.searchParams.set("server", context.server);
    if (context.onshapeUserId) url.searchParams.set("userId", context.onshapeUserId);
    window.location.assign(url.toString());
  };

  const disconnect = async () => {
    if (!sessionToken || disconnecting) return;
    setDisconnecting(true);
    setSubmission("idle");
    setMessage("Disconnecting your Onshape account…");
    try {
      await disconnectSession(sessionToken);
      sessionStorage.removeItem(SESSION_KEY);
      setSessionToken("");
      setUser(null);
      setSubmission("idle");
      setMessage("Onshape account disconnected.");
    } catch (error) {
      setSubmission("error");
      setMessage(error instanceof Error ? error.message : "Could not disconnect your Onshape account.");
    } finally {
      setDisconnecting(false);
    }
  };

  const suggestionSelection = selections[0];
  const suggestionSelectionKey = suggestionSelection
    ? [
        suggestionSelection.entityType,
        suggestionSelection.selectionId,
        suggestionSelection.partId ?? "",
        ...(suggestionSelection.occurrencePath ?? []),
      ].join(":")
    : "";
  const suggestionRequestKey = [
    context?.documentId ?? "",
    context?.workspaceOrVersionId ?? "",
    context?.elementId ?? "",
    sessionToken,
    kind,
    suggestionSelectionKey,
  ].join(":");
  const currentDxfBoundsResult = dxfBoundsResult?.requestKey === suggestionRequestKey ? dxfBoundsResult : undefined;
  const dxfBounds = currentDxfBoundsResult?.bounds;
  const dxfBoundsStatus = kind !== "dxf" || !suggestionSelection || !context || !sessionToken
    ? "idle"
    : currentDxfBoundsResult?.status ?? "loading";
  useEffect(() => {
    const selectionChanged = suggestionSelectionKey !== lastSuggestionSelectionKey.current;
    if (selectionChanged) {
      lastSuggestionSelectionKey.current = suggestionSelectionKey;
      friendlyNameEdited.current = false;
      materialEdited.current = false;
      machiningEdited.current = false;
    }
    if (suggestionRequestKey === lastSuggestionRequestKey.current) return;
    lastSuggestionRequestKey.current = suggestionRequestKey;
    const requestNumber = ++suggestionRequest.current;
    if (!context || !sessionToken || (kind === "dxf" && !suggestionSelection)) return;
    const suggestionRequestBody = {
      context,
      selection: suggestionSelection,
      kind,
    };
    const loadSuggestions = async () => {
      try {
        const first = await getExportSuggestions(sessionToken, suggestionRequestBody);
        const metadataMissing = Boolean(suggestionSelection)
          && first.partMetadataFound !== true
          && !first.friendlyName
          && !first.material;
        if (!metadataMissing) return first;
      } catch {
        // Retry once below. Selection changes invalidate this request number.
      }
      if (requestNumber !== suggestionRequest.current) return undefined;
      return getExportSuggestions(sessionToken, suggestionRequestBody);
    };
    void loadSuggestions().then((suggestions) => {
      if (!suggestions) return;
      if (requestNumber !== suggestionRequest.current) return;
      if (kind === "dxf" && suggestionSelection) {
        setDxfBoundsResult({
          requestKey: suggestionRequestKey,
          status: suggestions.dxfBounds ? "complete" : "unavailable",
          bounds: suggestions.dxfBounds,
        });
      }
      if (!subsystemEdited.current && suggestions.subsystem) setSubsystem(suggestions.subsystem);
      const metadataMissing = Boolean(suggestionSelection)
        && suggestions.partMetadataFound !== true
        && !suggestions.friendlyName
        && !suggestions.material;
      if (metadataMissing) {
        setMessage("Could not load defaults for the selected part. You can enter them manually or select the part again.");
        return;
      }
      if (suggestionSelection) setMessage("");
      if (!friendlyNameEdited.current) setFriendlyName(suggestions.friendlyName ?? "");
      const suggestedMaterial = suggestions.material;
      if (materialEdited.current) return;
      if (kind === "lathe") {
        setMaterial(suggestedMaterial && latheMaterials.includes(suggestedMaterial) ? suggestedMaterial : "aluminum 7075");
        return;
      }
      if (kind !== "dxf") return;
      let targetMachining = machiningRef.current;
      if (!machiningEdited.current) {
        targetMachining = suggestedMaterial ? preferredMachiningByMaterial[suggestedMaterial] ?? "laser" : "laser";
        machiningRef.current = targetMachining;
        setMachining(targetMachining);
      }
      const supportedMaterials = dxfMaterialsByMachining[targetMachining];
      setMaterial(suggestedMaterial && supportedMaterials.includes(suggestedMaterial) ? suggestedMaterial : supportedMaterials[0]);
    }).catch(() => {
      if (requestNumber === suggestionRequest.current) {
        if (kind === "dxf" && suggestionSelection) {
          setDxfBoundsResult({ requestKey: suggestionRequestKey, status: "unavailable" });
        }
        setMessage("Could not load defaults for the selected part. You can enter them manually or select the part again.");
      }
    });
  }, [context, suggestionSelection, suggestionSelectionKey, suggestionRequestKey, kind, sessionToken]);

  const latheDetailsComplete = useMemo(() => {
    const stockComplete = latheStockType === "round shaft"
      ? positive(latheDiameter)
      : latheStockType === "round tube"
        ? positive(tubeOuterDiameter) && positive(tubeInnerDiameter) && tubeInnerDiameter! < tubeOuterDiameter!
        : true;
    return stockComplete && endOperationComplete(endA) && endOperationComplete(endB);
  }, [endA, endB, latheDiameter, latheStockType, tubeInnerDiameter, tubeOuterDiameter]);

  const selectionComplete = selections.length === requiredSelectionCount;
  const friendlyNameComplete = Boolean(friendlyName.trim());
  const quantityComplete = Number.isInteger(quantity) && quantity >= 1 && quantity <= 999;
  const materialThicknessComplete = kind !== "dxf" || positive(materialThickness);
  const accountComplete = Boolean(user && sessionToken);

  const canSubmit = useMemo(
    () => Boolean(
      context
      && selectionComplete
      && friendlyNameComplete
      && quantityComplete
      && accountComplete
      && submission !== "working"
      && materialThicknessComplete
      && (kind !== "lathe" || latheDetailsComplete),
    ),
    [context, selectionComplete, friendlyNameComplete, quantityComplete, accountComplete, submission, materialThicknessComplete, kind, latheDetailsComplete],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !context) return;
    setSubmission("working");
    setMessage(kind === "lathe" ? "Saving the lathe request…" : "Creating the export in Onshape…");
    try {
      const result = await createExport(sessionToken, {
        kind,
        friendlyName: friendlyName.trim(),
        quantity,
        machiningType: kind === "step" ? "3d printed" : kind === "lathe" ? "lathe" : machining,
        material: kind === "step" ? "3D Print" : material,
        materialThicknessInches: kind === "dxf" ? materialThickness : undefined,
        subsystem: subsystem.trim() ? subsystem.trim() : undefined,
        context,
        selections,
        lathe: kind === "lathe" ? {
          stockType: latheStockType,
          diameterInches: latheStockType === "round shaft" ? latheDiameter : undefined,
          outerDiameterInches: latheStockType === "round tube" ? tubeOuterDiameter : undefined,
          innerDiameterInches: latheStockType === "round tube" ? tubeInnerDiameter : undefined,
          endA,
          endB,
          endReference: endReference.trim() || undefined,
        } : undefined,
      });
      setSubmission("complete");
      setMessage(kind === "lathe" ? "Lathe request added to the manufacturing queue." : `${result.fileName} is in the manufacturing queue.`);
      postToOnshape(context, { messageName: "showMessageBubble", message: kind === "lathe" ? "Lathe request added to the manufacturing queue." : "Export added to the manufacturing queue." });
    } catch (error) {
      setSubmission("error");
      setMessage(error instanceof Error ? error.message : "The export failed.");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><CubeIcon /></span><span>Parts Exporter</span></div>
        <button className="icon-button" type="button" onClick={toggleTheme} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>

      <section className="content">
        <div className="intro">
          <p className="eyebrow">Manufacturing handoff</p>
          <h1>Send a part to be manufactured</h1>
          <p>Choose a manufacturing process, select geometry in Onshape, and add the details the shop needs.</p>
        </div>

        {!context && (
          <div className="notice warning">
            <strong>Open this app from an Onshape Part Studio or Assembly.</strong>
            <span>The source document, workspace, or element IDs are missing from the URL.</span>
          </div>
        )}

        <div className="segmented" aria-label="Manufacturing process">
          <button type="button" className={kind === "dxf" ? "active" : ""} onClick={() => changeKind("dxf")}><FaceIcon /><span><strong>DXF</strong><small>Planar face</small></span></button>
          <button type="button" className={kind === "step" ? "active" : ""} onClick={() => changeKind("step")}><CubeIcon /><span><strong>STEP</strong><small>3D part</small></span></button>
          <button type="button" className={kind === "lathe" ? "active" : ""} onClick={() => changeKind("lathe")}><LatheIcon /><span><strong>Lathe</strong><small>Manual job</small></span></button>
        </div>

        <form onSubmit={submit}>
          <section className={`card selection-card ${selectionComplete ? "" : "missing"}`}>
            <div className="step-number">1</div>
            <div className="card-copy">
              <h2>Select {kind === "dxf" ? "a planar face" : kind === "step" ? "a part or any face on it" : "the two end faces"}</h2>
              <p>{kind === "dxf" ? "Choose the face that should lie flat on the machine bed." : kind === "step" ? "Choose one solid body, or click any face belonging to that body." : "Choose both planar end faces of the same shaft or tube. The first face becomes End A and the second becomes End B."}</p>
            </div>
            <button className={`select-button ${selectionComplete ? "selected" : "missing"}`} type="button" onClick={() => selectTarget()} disabled={!context}>
              {selectionComplete ? <><CheckIcon /> Selected</> : selecting ? `${selections.length} of ${requiredSelectionCount} selected…` : `Select ${kind === "dxf" ? "face" : kind === "step" ? "part or face" : selections.length === 1 ? "End B" : "two faces"}`}
            </button>
            {selections.map((selection, index) => <div className="selection-detail" key={`${selection.entityType}:${selection.selectionId}`}><span>{kind === "lathe" ? `End ${index === 0 ? "A" : "B"}` : selection.entityType === "BODY" ? "Part" : "Face"}</span><code>{selection.name ?? selection.selectionId}</code>{index === 0 && <button type="button" onClick={() => selectTarget(true)}>Change</button>}</div>)}
          </section>

          <section className="card details-card">
            <div className="section-heading"><div className="step-number">2</div><div><h2>Manufacturing details</h2><p>{kind === "lathe" ? "These details become the manual machining request." : "These details travel with the exported file."}</p></div></div>
            <div className="fields">
              <label className={`field span-2 ${friendlyNameComplete ? "" : "missing"}`}><span>Friendly part name</span><input aria-invalid={!friendlyNameComplete} value={friendlyName} onChange={(e) => { friendlyNameEdited.current = true; setFriendlyName(e.target.value); }} placeholder={kind === "dxf" ? "e.g. Intake side plate" : "Defaults to the selected part name"} maxLength={80} required /></label>
              <label className={`field ${quantityComplete ? "" : "missing"}`}><span>Quantity</span><input aria-invalid={!quantityComplete} type="number" min="1" max="999" step="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required /></label>
              <label className="field"><span>Machining type</span>{kind === "step" ? <div className="fixed-value"><CubeIcon />3D Printed</div> : kind === "lathe" ? <div className="fixed-value"><LatheIcon />Manual lathe</div> : <select value={machining} onChange={(e) => changeMachining(e.target.value as DxfMachiningType)}><option value="laser">Laser</option><option value="plasma">Plasma</option><option value="waterjet">Waterjet</option></select>}</label>
              {kind === "step" && <label className="field"><span>Material</span><div className="fixed-value"><CubeIcon />3D Print</div></label>}
              {kind !== "step" && <label className="field"><span>Material</span><select value={material} onChange={(e) => { materialEdited.current = true; setMaterial(e.target.value as Material); }}>{(kind === "lathe" ? latheMaterials : dxfMaterialsByMachining[machining]).map((item) => <option value={item} key={item}>{item === "SRPP" ? item : item.replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}</select></label>}
              {kind === "dxf" && <label className={`field ${materialThicknessComplete ? "" : "missing"}`}><span>Material thickness <em>in</em></span><input aria-invalid={!materialThicknessComplete} type="number" min="0.001" max="100" step="any" value={materialThickness ?? ""} onChange={(event) => setMaterialThickness(optionalNumber(event.target.value))} placeholder="e.g. 0.125" required /></label>}
              {kind === "dxf" && suggestionSelection && <div className={`stock-envelope span-2 ${dxfBoundsStatus}`} aria-live="polite">
                <div><span>DXF stock envelope</span>{dxfBounds
                  ? <strong>{formatInches(dxfBounds.widthInches)} × {formatInches(dxfBounds.heightInches)} in</strong>
                  : <strong>{dxfBoundsStatus === "loading" ? "Measuring selected face…" : dxfBoundsStatus === "idle" ? "Connect to measure" : "Measurement unavailable"}</strong>}</div>
                <p>{dxfBounds
                  ? `${dxfBounds.areaSquareInches.toLocaleString(undefined, { maximumFractionDigits: 2 })} in² minimum rectangular area. Choose stock larger than this envelope for edge clearance.`
                  : "This estimate is optional and does not block the export."}</p>
              </div>}
              <label className={`field ${kind === "dxf" ? "span-2" : ""}`}><span>Subsystem <em>optional</em></span><input value={subsystem} onChange={(e) => { subsystemEdited.current = true; setSubsystem(e.target.value); }} placeholder="Defaults to the Onshape document name" maxLength={80} /></label>
              {kind === "lathe" && <>
                <label className="field span-2"><span>Stock profile</span><select value={latheStockType} onChange={(event) => changeLatheStock(event.target.value as LatheStockType)}>{latheStockTypes.map((stock) => <option value={stock} key={stock}>{stock.replace(/\b\w/g, (character) => character.toUpperCase())}</option>)}</select></label>
                {latheStockType === "round shaft" && <label className={`field span-2 ${positive(latheDiameter) ? "" : "missing"}`}><span>Shaft diameter <em>in</em></span><input aria-invalid={!positive(latheDiameter)} type="number" min="0.001" max="100" step="any" value={latheDiameter ?? ""} onChange={(event) => setLatheDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.5" required /></label>}
                {latheStockType === "round tube" && <><label className={`field ${positive(tubeOuterDiameter) ? "" : "missing"}`}><span>Outside diameter <em>in</em></span><input aria-invalid={!positive(tubeOuterDiameter)} type="number" min="0.001" max="100" step="any" value={tubeOuterDiameter ?? ""} onChange={(event) => setTubeOuterDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.75" required /></label><label className={`field ${positive(tubeInnerDiameter) && positive(tubeOuterDiameter) && tubeInnerDiameter! < tubeOuterDiameter! ? "" : "missing"}`}><span>Inside diameter <em>in</em></span><input aria-invalid={!(positive(tubeInnerDiameter) && positive(tubeOuterDiameter) && tubeInnerDiameter! < tubeOuterDiameter!)} type="number" min="0.001" max="100" step="any" value={tubeInnerDiameter ?? ""} onChange={(event) => setTubeInnerDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.5" required /></label></>}
              </>}
            </div>
            {kind === "lathe" && <div className="lathe-ends"><EndOperationFields title="End A" subtitle="First selected face" value={endA} onChange={setEndA} defaultOpen /><EndOperationFields title="End B" subtitle="Second selected face" value={endB} onChange={setEndB} /><label className="field"><span>Extra notes <em>optional</em></span><textarea value={endReference} onChange={(event) => setEndReference(event.target.value)} placeholder="e.g. Break all edges" maxLength={300} /></label></div>}
          </section>

          <section className={`identity-row ${accountComplete ? "" : "missing"}`}>
            <div className="avatar">{user ? user.name.slice(0, 1).toUpperCase() : "?"}</div>
            <div><span>Requested by</span><strong>{user?.name ?? "Onshape account not connected"}</strong></div>
            {user
              ? <button type="button" className="text-button disconnect-button" onClick={disconnect} disabled={disconnecting}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button>
              : <button type="button" className="text-button" onClick={signIn} disabled={!context}>Connect</button>}
          </section>

          {message && <div className={`status ${submission}`} role="status">{submission === "complete" && <CheckIcon />}<span>{message}</span></div>}

          <button className="submit-button" type="submit" disabled={!canSubmit}>
            {submission === "working" ? <><span className="spinner" />{kind === "lathe" ? "Saving request…" : "Exporting & uploading…"}</> : <>{kind === "lathe" ? "Add lathe request" : `Export ${kind.toUpperCase()}`}<span>→</span></>}
          </button>
          {!embedded && context && <p className="standalone-note">Connected to an Onshape document. Selection controls work only while this page is embedded in the right panel.</p>}
        </form>
      </section>
    </main>
  );
}
