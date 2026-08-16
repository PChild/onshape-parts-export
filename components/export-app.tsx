"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createExport, disconnectSession, getApiBase, getSession } from "@/lib/api";
import { postToOnshape, readOnshapeContext, selectionsFromMessage } from "@/lib/onshape";
import type {
  ExportKind,
  LatheEndOperation,
  LatheStockType,
  Material,
  OnshapeContext,
  OnshapeSelection,
  SessionUser,
} from "@/lib/types";

const dxfMaterials: Material[] = ["wood", "aluminum", "steel", "SRPP", "polycarb", "carbon fiber"];
const latheMaterials: Material[] = ["aluminum 7075", "polycarb", "steel", "carbon fiber"];
const latheStockTypes: LatheStockType[] = [
  "1/2 true hex",
  "1/2 rounded hex",
  "3/8 true hex",
  "3/8 rounded hex",
  "round shaft",
  "round tube",
];
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
}: {
  title: string;
  subtitle: string;
  value: LatheEndOperation;
  onChange: (next: LatheEndOperation) => void;
}) {
  const update = (changes: Partial<LatheEndOperation>) => onChange({ ...value, ...changes });
  return (
    <fieldset className="end-operation">
      <legend>{title}<small>{subtitle}</small></legend>
      <label className="field span-2"><span>Operation</span><select value={value.operation} onChange={(event) => onChange({ operation: event.target.value as LatheEndOperation["operation"] })}><option value="leave as modeled">Leave as modeled</option><option value="turn down">Turn down for bearing</option><option value="tap">Tap</option><option value="drill">Drill</option><option value="other">Other</option></select></label>
      {value.operation === "turn down" && <><label className="field"><span>Target diameter <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={value.diameterInches ?? ""} onChange={(event) => update({ diameterInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.375" required /></label><label className="field"><span>Turned length <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={value.lengthInches ?? ""} onChange={(event) => update({ lengthInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.5" required /></label></>}
      {value.operation === "tap" && <><label className="field"><span>Thread</span><input value={value.thread ?? ""} onChange={(event) => update({ thread: event.target.value })} placeholder="e.g. 1/4-20" maxLength={40} required /></label><label className="field"><span>Thread depth <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={value.depthInches ?? ""} onChange={(event) => update({ depthInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.75" required /></label></>}
      {value.operation === "drill" && <><label className="field"><span>Hole diameter <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={value.diameterInches ?? ""} onChange={(event) => update({ diameterInches: optionalNumber(event.target.value) })} placeholder="e.g. 0.25" required /></label><label className="field"><span>Hole depth <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={value.depthInches ?? ""} onChange={(event) => update({ depthInches: optionalNumber(event.target.value) })} placeholder="e.g. 1.0" required /></label></>}
      {value.operation === "other" && <label className="field span-2"><span>Instructions</span><textarea value={value.notes ?? ""} onChange={(event) => update({ notes: event.target.value })} placeholder="Describe the operation and dimensions" maxLength={300} required /></label>}
    </fieldset>
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
  const [quantity, setQuantity] = useState(1);
  const [machining, setMachining] = useState<"laser" | "plasma" | "waterjet">("laser");
  const [material, setMaterial] = useState<Material>("wood");
  const [subsystem, setSubsystem] = useState("");
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
    postToOnshape(context, { messageName: "applicationInit" });
    const handler = (event: MessageEvent) => {
      if (event.origin !== context.server) return;
      const parsed = selectionsFromMessage(event.data, allowedSelectionTypes.current);
      if (parsed.length) {
        const accepted = parsed.slice(0, expectedSelectionCount.current);
        setSelections(accepted);
        setSelecting(accepted.length < expectedSelectionCount.current);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [context]);

  const selectTarget = useCallback(() => {
    if (!context) return;
    const entityTypes: readonly OnshapeSelection["entityType"][] = kind === "dxf"
      ? ["FACE"]
      : kind === "step" ? ["BODY", "FACE"] : ["FACE"];
    const selectionCount = kind === "lathe" ? 2 : 1;
    allowedSelectionTypes.current = entityTypes;
    expectedSelectionCount.current = selectionCount;
    setSelections([]);
    setSelecting(true);
    setMessage("");
    postToOnshape(context, {
      messageName: "requestSelection",
      messageId: crypto.randomUUID(),
      entityTypeSpecifier: entityTypes,
      requiredSelectionCount: selectionCount,
    });
  }, [context, kind]);

  const changeKind = (next: ExportKind) => {
    if (context && selecting) postToOnshape(context, { messageName: "stopRequest" });
    setKind(next);
    if (next === "lathe" && !latheMaterials.includes(material)) setMaterial("aluminum 7075");
    if (next === "dxf" && !dxfMaterials.includes(material)) setMaterial("aluminum");
    setSelections([]);
    setSelecting(false);
    setSubmission("idle");
    setMessage("");
  };

  const changeLatheStock = (next: LatheStockType) => {
    if (context && selecting) postToOnshape(context, { messageName: "stopRequest" });
    setLatheStockType(next);
    setSelections([]);
    setSelecting(false);
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

  const latheDetailsComplete = useMemo(() => {
    const stockComplete = latheStockType === "round shaft"
      ? positive(latheDiameter)
      : latheStockType === "round tube"
        ? positive(tubeOuterDiameter) && positive(tubeInnerDiameter) && tubeInnerDiameter! < tubeOuterDiameter!
        : true;
    return stockComplete && endOperationComplete(endA) && endOperationComplete(endB);
  }, [endA, endB, latheDiameter, latheStockType, tubeInnerDiameter, tubeOuterDiameter]);

  const canSubmit = useMemo(
    () => Boolean(
      context
      && selections.length === requiredSelectionCount
      && friendlyName.trim()
      && Number.isInteger(quantity)
      && quantity > 0
      && user
      && sessionToken
      && submission !== "working"
      && (kind !== "lathe" || latheDetailsComplete),
    ),
    [context, selections.length, requiredSelectionCount, friendlyName, quantity, user, sessionToken, submission, kind, latheDetailsComplete],
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
        material: kind === "dxf" || kind === "lathe" ? material : undefined,
        subsystem: kind !== "step" && subsystem.trim() ? subsystem.trim() : undefined,
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
            <strong>Open this app from an Onshape Part Studio.</strong>
            <span>The document, workspace, and element IDs are missing from the URL.</span>
          </div>
        )}

        <div className="segmented" aria-label="Manufacturing process">
          <button type="button" className={kind === "dxf" ? "active" : ""} onClick={() => changeKind("dxf")}><FaceIcon /><span><strong>DXF</strong><small>Planar face</small></span></button>
          <button type="button" className={kind === "step" ? "active" : ""} onClick={() => changeKind("step")}><CubeIcon /><span><strong>STEP</strong><small>3D part</small></span></button>
          <button type="button" className={kind === "lathe" ? "active" : ""} onClick={() => changeKind("lathe")}><LatheIcon /><span><strong>Lathe</strong><small>Manual job</small></span></button>
        </div>

        <form onSubmit={submit}>
          <section className="card selection-card">
            <div className="step-number">1</div>
            <div className="card-copy">
              <h2>Select {kind === "dxf" ? "a planar face" : kind === "step" ? "a part or any face on it" : "the two end faces"}</h2>
              <p>{kind === "dxf" ? "Choose the face that should lie flat on the machine bed." : kind === "step" ? "Choose one solid body, or click any face belonging to that body." : "Choose both planar end faces of the same shaft or tube. The first face becomes End A and the second becomes End B."}</p>
            </div>
            <button className={`select-button ${selections.length === requiredSelectionCount ? "selected" : ""}`} type="button" onClick={selectTarget} disabled={!context}>
              {selections.length === requiredSelectionCount ? <><CheckIcon /> Selected</> : selecting ? `${selections.length} of ${requiredSelectionCount} selected…` : `Select ${kind === "dxf" ? "face" : kind === "step" ? "part or face" : "two faces"}`}
            </button>
            {selections.map((selection, index) => <div className="selection-detail" key={`${selection.entityType}:${selection.selectionId}`}><span>{kind === "lathe" && selections.length > 1 ? `End ${index === 0 ? "A" : "B"}` : selection.entityType === "BODY" ? "Part" : "Face"}</span><code>{selection.name ?? selection.selectionId}</code>{index === 0 && <button type="button" onClick={selectTarget}>Change</button>}</div>)}
          </section>

          <section className="card details-card">
            <div className="section-heading"><div className="step-number">2</div><div><h2>Manufacturing details</h2><p>{kind === "lathe" ? "These details become the manual machining request." : "These details travel with the exported file."}</p></div></div>
            <div className="fields">
              <label className="field span-2"><span>Friendly part name</span><input value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} placeholder="e.g. Intake side plate" maxLength={80} required /></label>
              <label className="field"><span>Quantity</span><input type="number" min="1" max="999" step="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required /></label>
              <label className="field"><span>Machining type</span>{kind === "step" ? <div className="fixed-value"><CubeIcon />3D printed</div> : kind === "lathe" ? <div className="fixed-value"><LatheIcon />Manual lathe</div> : <select value={machining} onChange={(e) => setMachining(e.target.value as typeof machining)}><option value="laser">Laser</option><option value="plasma">Plasma</option><option value="waterjet">Waterjet</option></select>}</label>
              {kind !== "step" && <><label className="field"><span>Material</span><select value={material} onChange={(e) => setMaterial(e.target.value as Material)}>{(kind === "lathe" ? latheMaterials : dxfMaterials).map((item) => <option value={item} key={item}>{item === "SRPP" ? item : item.replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}</select></label><label className="field"><span>Subsystem <em>optional</em></span><input value={subsystem} onChange={(e) => setSubsystem(e.target.value)} placeholder="e.g. Drivetrain" maxLength={80} /></label></>}
              {kind === "lathe" && <>
                <label className="field span-2"><span>Stock profile</span><select value={latheStockType} onChange={(event) => changeLatheStock(event.target.value as LatheStockType)}>{latheStockTypes.map((stock) => <option value={stock} key={stock}>{stock.replace(/\b\w/g, (character) => character.toUpperCase())}</option>)}</select></label>
                {latheStockType === "round shaft" && <label className="field span-2"><span>Shaft diameter <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={latheDiameter ?? ""} onChange={(event) => setLatheDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.5" required /></label>}
                {latheStockType === "round tube" && <><label className="field"><span>Outside diameter <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={tubeOuterDiameter ?? ""} onChange={(event) => setTubeOuterDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.75" required /></label><label className="field"><span>Inside diameter <em>in</em></span><input type="number" min="0.001" max="100" step="any" value={tubeInnerDiameter ?? ""} onChange={(event) => setTubeInnerDiameter(optionalNumber(event.target.value))} placeholder="e.g. 0.5" required /></label></>}
              </>}
            </div>
            {kind === "lathe" && <div className="lathe-ends"><EndOperationFields title="End A" subtitle="First selected face" value={endA} onChange={setEndA} /><EndOperationFields title="End B" subtitle="Second selected face" value={endB} onChange={setEndB} /><label className="field"><span>Extra notes <em>optional</em></span><textarea value={endReference} onChange={(event) => setEndReference(event.target.value)} placeholder="e.g. Break all edges" maxLength={300} /></label></div>}
          </section>

          <section className="identity-row">
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
