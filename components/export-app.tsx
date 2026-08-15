"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createExport, getApiBase, getSession } from "@/lib/api";
import { postToOnshape, readOnshapeContext, selectionFromMessage } from "@/lib/onshape";
import type { ExportKind, Material, OnshapeContext, OnshapeSelection, SessionUser } from "@/lib/types";

const materials: Material[] = ["wood", "aluminum", "steel", "SRPP", "polycarb", "carbon fiber"];
const SESSION_KEY = "shop-export-session";
const THEME_KEY = "shop-export-theme";

type Theme = "light" | "dark";
type SubmissionState = "idle" | "exporting" | "complete" | "error";

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

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>;
}

export function ExportApp() {
  const browserReady = useSyncExternalStore(subscribeToBrowser, () => true, () => false);
  const context = useMemo<OnshapeContext | null>(
    () => browserReady ? readOnshapeContext(new URL(window.location.href)) : null,
    [browserReady],
  );
  const embedded = browserReady && window.parent !== window;
  const [kind, setKind] = useState<ExportKind>("dxf");
  const [selection, setSelection] = useState<OnshapeSelection | null>(null);
  const [selecting, setSelecting] = useState(false);
  const expectedSelection = useRef<"FACE" | "BODY">("FACE");
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
  const [friendlyName, setFriendlyName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [machining, setMachining] = useState<"laser" | "plasma" | "waterjet">("laser");
  const [material, setMaterial] = useState<Material>("wood");
  const [subsystem, setSubsystem] = useState("");
  const [submission, setSubmission] = useState<SubmissionState>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const savedSession = sessionStorage.getItem(SESSION_KEY);
    if (savedSession) {
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
      const parsed = selectionFromMessage(event.data, expectedSelection.current);
      if (parsed) {
        setSelection(parsed);
        setSelecting(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [context]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      let apiOrigin = "";
      try { apiOrigin = new URL(getApiBase()).origin; } catch { return; }
      if (event.origin !== apiOrigin || event.data?.type !== "onshape-oauth-success") return;
      const token = event.data.sessionToken;
      if (typeof token !== "string") return;
      sessionStorage.setItem(SESSION_KEY, token);
      setSessionToken(token);
      getSession(token).then(({ user: signedInUser }) => setUser(signedInUser)).catch((error: Error) => setMessage(error.message));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const selectTarget = useCallback(() => {
    if (!context) return;
    const entityType = kind === "dxf" ? "FACE" : "BODY";
    expectedSelection.current = entityType;
    setSelection(null);
    setSelecting(true);
    setMessage("");
    postToOnshape(context, {
      messageName: "requestSelection",
      messageId: crypto.randomUUID(),
      entityTypeSpecifier: [entityType],
      requiredSelectionCount: 1,
    });
  }, [context, kind]);

  const changeKind = (next: ExportKind) => {
    if (context && selecting) postToOnshape(context, { messageName: "stopRequest" });
    setKind(next);
    setSelection(null);
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
    url.searchParams.set("returnOrigin", window.location.origin);
    url.searchParams.set("server", context.server);
    if (context.onshapeUserId) url.searchParams.set("userId", context.onshapeUserId);
    const popup = window.open(url, "shop-export-oauth", "popup,width=620,height=760");
    if (!popup) setMessage("Please allow pop-ups to connect your Onshape account.");
  };

  const canSubmit = useMemo(
    () => Boolean(context && selection && friendlyName.trim() && quantity > 0 && user && sessionToken && submission !== "exporting"),
    [context, selection, friendlyName, quantity, user, sessionToken, submission],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !context || !selection) return;
    setSubmission("exporting");
    setMessage("Creating the export in Onshape…");
    try {
      const result = await createExport(sessionToken, {
        kind,
        friendlyName: friendlyName.trim(),
        quantity,
        machiningType: kind === "step" ? "3d printed" : machining,
        material: kind === "dxf" ? material : undefined,
        subsystem: kind === "dxf" && subsystem.trim() ? subsystem.trim() : undefined,
        context,
        selection,
      });
      setSubmission("complete");
      setMessage(`${result.fileName} is in the manufacturing queue.`);
      postToOnshape(context, { messageName: "showMessageBubble", message: "Export added to the manufacturing queue." });
    } catch (error) {
      setSubmission("error");
      setMessage(error instanceof Error ? error.message : "The export failed.");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><CubeIcon /></span><span>Shop Export</span></div>
        <button className="icon-button" type="button" onClick={toggleTheme} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>

      <section className="content">
        <div className="intro">
          <p className="eyebrow">Manufacturing handoff</p>
          <h1>Send a part to the shop</h1>
          <p>Choose the file type, select geometry in Onshape, and add the details the shop needs.</p>
        </div>

        {!context && (
          <div className="notice warning">
            <strong>Open this app from an Onshape Part Studio.</strong>
            <span>The document, workspace, and element IDs are missing from the URL.</span>
          </div>
        )}

        <div className="segmented" aria-label="Export type">
          <button type="button" className={kind === "dxf" ? "active" : ""} onClick={() => changeKind("dxf")}><FaceIcon /><span><strong>DXF</strong><small>Planar face</small></span></button>
          <button type="button" className={kind === "step" ? "active" : ""} onClick={() => changeKind("step")}><CubeIcon /><span><strong>STEP</strong><small>3D part</small></span></button>
        </div>

        <form onSubmit={submit}>
          <section className="card selection-card">
            <div className="step-number">1</div>
            <div className="card-copy">
              <h2>Select {kind === "dxf" ? "a planar face" : "a part"}</h2>
              <p>{kind === "dxf" ? "Choose the face that should lie flat on the machine bed." : "Choose one solid body to manufacture."}</p>
            </div>
            <button className={`select-button ${selection ? "selected" : ""}`} type="button" onClick={selectTarget} disabled={!context}>
              {selection ? <><CheckIcon /> Selected</> : selecting ? "Waiting for selection…" : `Select ${kind === "dxf" ? "face" : "part"}`}
            </button>
            {selection && <div className="selection-detail"><span>{selection.entityType === "FACE" ? "Face" : "Part"}</span><code>{selection.name ?? selection.selectionId}</code><button type="button" onClick={selectTarget}>Change</button></div>}
          </section>

          <section className="card details-card">
            <div className="section-heading"><div className="step-number">2</div><div><h2>Manufacturing details</h2><p>These details travel with the exported file.</p></div></div>
            <div className="fields">
              <label className="field span-2"><span>Friendly part name</span><input value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} placeholder="e.g. Intake side plate" maxLength={80} required /></label>
              <label className="field"><span>Quantity</span><input type="number" min="1" max="999" step="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required /></label>
              <label className="field"><span>Machining type</span>{kind === "step" ? <div className="fixed-value"><CubeIcon />3D printed</div> : <select value={machining} onChange={(e) => setMachining(e.target.value as typeof machining)}><option value="laser">Laser</option><option value="plasma">Plasma</option><option value="waterjet">Waterjet</option></select>}</label>
              {kind === "dxf" && <><label className="field"><span>Material</span><select value={material} onChange={(e) => setMaterial(e.target.value as Material)}>{materials.map((item) => <option value={item} key={item}>{item === "SRPP" ? item : item.replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}</select></label><label className="field"><span>Subsystem <em>optional</em></span><input value={subsystem} onChange={(e) => setSubsystem(e.target.value)} placeholder="e.g. Drivetrain" maxLength={80} /></label></>}
            </div>
          </section>

          <section className="identity-row">
            <div className="avatar">{user ? user.name.slice(0, 1).toUpperCase() : "?"}</div>
            <div><span>Requested by</span><strong>{user?.name ?? "Onshape account not connected"}</strong></div>
            {!user && <button type="button" className="text-button" onClick={signIn} disabled={!context}>Connect</button>}
          </section>

          {message && <div className={`status ${submission}`} role="status">{submission === "complete" && <CheckIcon />}<span>{message}</span></div>}

          <button className="submit-button" type="submit" disabled={!canSubmit}>
            {submission === "exporting" ? <><span className="spinner" /> Exporting & uploading…</> : <>Export {kind.toUpperCase()} to Firebase <span>→</span></>}
          </button>
          {!embedded && context && <p className="standalone-note">Connected to an Onshape document. Selection controls work only while this page is embedded in the right panel.</p>}
        </form>
      </section>
    </main>
  );
}
