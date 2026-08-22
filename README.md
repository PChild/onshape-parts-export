# Shop Export for Onshape

A classroom-focused Onshape right-panel extension that sends manufacturing files and manual machining requests to Firebase:

- Select one planar face and export a DXF for laser, plasma, or waterjet cutting.
- Select one solid part—or any face on that part—and export a binary STL file for 3D printing.
- Store 3D-print requests with the fixed material value `3d Print`.
- Create a manual-lathe request without exporting a file by selecting its two planar end faces.
- Measure and store the lathe part's overall face-to-face length in inches and generate an isometric preview.
- Require a friendly name and quantity; DXF requests also require material thickness in inches, while DXF and lathe requests require material.
- Measure the selected DXF face's tight, export-aligned rectangular envelope in inches so students can choose appropriately sized stock.
- Measure 3D-print parts with a tight X/Y/Z bounding box in inches so students can compare them with printer build volumes.
- Prefill the editable subsystem field from the Onshape document name for every request, and loosely match a selected DXF part's Onshape material to a supported shop material when possible.
- Prefill the editable friendly name from the selected Onshape part for STL and lathe requests.
- Filter DXF materials by process: laser supports SRPP, polycarbonate, and wood; plasma supports steel plus Aluminum 6061, 7075, and 5052; waterjet supports every listed DXF material.
- Match explicit Onshape aluminum grades when available and default an unspecified aluminum material to the commonly used Aluminum 6061.
- Refresh the editable part-name and material defaults when the selected part changes; inferred aluminum DXF parts default to waterjet cutting.
- Capture fixed hex profiles, custom round shaft/tube diameters, and independent turn-down, tap, drill, or custom instructions for both ends.
- Keep the two lathe end-operation sections collapsible for smaller classroom screens.
- Adopt face selections made while the panel is open, preserve compatible selections when switching processes, and reuse one selected face as Lathe End A.
- Highlight every missing required selection, input, lathe operation, and account connection that is blocking submission.
- Record the authenticated Onshape user with every export or manual request.
- Store generated files in Cloud Storage and every manufacturing record in Firestore.
- Follow the browser color scheme on first use, with a remembered light/dark override.

## Architecture

The Next.js UI is a static export hosted on GitHub Pages. It uses Onshape client messaging to request and receive a face or body selection. A Firebase HTTPS function handles Onshape OAuth, calls the Onshape export API, uploads the returned bytes with custom metadata, and writes the audit record.

The split is required: Onshape does not support REST API calls directly from browser clients, and an OAuth client secret must never be shipped in a GitHub Pages bundle.

```text
Onshape right panel (GitHub Pages)
    │ selection + manufacturing details
    ▼
Firebase HTTPS function
    ├── Onshape OAuth and export API
    ├── Cloud Storage: manufacturing/{dxf|step}/YYYY-MM-DD/file
    ├── Cloud Storage: manufacturing/previews/cache/content-hash.image
    └── Firestore: exports/{exportId} (files and manual lathe requests)
```

## Prerequisites

- Node.js 22+
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with Firestore and Cloud Storage enabled
- A Firebase Blaze plan (currently required for Cloud Storage and deployed functions)
- A Classroom-owned Onshape OAuth application with read access to documents and export permission

## 1. Install and test locally

```bash
npm install
npm --prefix functions install
cp .env.example .env.local
npm run check
```

Set `NEXT_PUBLIC_API_BASE_URL` in `.env.local` to the deployed function URL. Selection is only available when the page is opened as an Onshape extension, but the standalone page is useful for checking layout and theme behavior.

## 2. Configure Firebase

Copy `.firebaserc.example` to `.firebaserc` and replace the project ID. Create a Firestore database and the default Storage bucket in the Firebase console, then deploy the deny-by-default rules:

```bash
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore:rules,storage
```

Set the OAuth secret:

```bash
firebase functions:secrets:set ONSHAPE_CLIENT_SECRET
```

On the first function deployment, Firebase prompts for these parameter values:

| Parameter | Example |
| --- | --- |
| `ONSHAPE_CLIENT_ID` | OAuth client ID from Onshape |
| `ONSHAPE_REDIRECT_URI` | `https://us-central1-PROJECT.cloudfunctions.net/api/oauth/callback` |
| `APP_ORIGIN` | `https://GITHUB_USER.github.io` |
| `STORAGE_BUCKET` | `PROJECT.firebasestorage.app` |
| `ONSHAPE_API_VERSION` | `v16` |

Deploy the backend:

```bash
firebase deploy --only functions
```

`APP_ORIGIN` is an origin, not a complete page URL: do not include the repository path or a trailing slash. The backend uses it for CORS and to validate the same-pane OAuth return URL.

## 3. Configure the Onshape OAuth app

In Classroom settings → OAuth applications:

1. Create an application owned by the classroom.
2. Enable document read/export access.
3. Add the exact `ONSHAPE_REDIRECT_URI` above to Redirect URLs.
4. Save the client ID and put the client secret in Firebase Secret Manager using the command above.

For an internal classroom app, an administrator can assign the application directly to classroom users or teams; a public App Store listing is not required.

## 4. Add the Onshape extension

Add a Part Studio extension to the OAuth application with:

- Location: **Element right panel**
- Context: **Inside Part Studio** (or the available Part Studio context in your Onshape plan)
- Action URL:

```text
https://GITHUB_USER.github.io/REPOSITORY/?contextType=partstudio&documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

Onshape supplies `server` and `userId` as default query parameters. The app validates `postMessage` events against that `server` origin before accepting selections.

To keep the exporter visible before students select anything in an assembly, add a second **Element right panel** extension with the **Assembly** context. Use this action URL:

```text
https://GITHUB_USER.github.io/REPOSITORY/?contextType=assembly&documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

Open that panel first, then click geometry directly or use its normal selection button. A selected face can be reused for DXF or STL, and it becomes End A when switching to Lathe so only End B remains to be selected. The backend reads the assembly definition after the selection and resolves the chosen occurrence to its source document microversion, Part Studio, configuration, and part ID. Keep the original **Part Studio** extension too.

Onshape currently does not provide a right-panel message for retrieving geometry that was selected before the panel was first initialized. Keep the panel open before selecting a face; the app then receives normal `SELECTION` messages automatically.

Standard Content instances are not currently supported because they do not have an ordinary source Part Studio export context.

## 5. Deploy the UI to GitHub Pages

In the GitHub repository:

1. Open Settings → Pages and select **GitHub Actions** as the source.
2. Add an Actions variable named `NEXT_PUBLIC_API_BASE_URL` containing the deployed Firebase function URL, without a trailing slash.
3. Push to `main` or manually run **Deploy UI to GitHub Pages**.

The workflow supplies the repository base path during the Next.js static build and deploys the `out/` directory.

## Data written for each request

The Storage object includes custom metadata for the request and the `exports/{exportId}` Firestore document includes:

- friendly name, quantity, machining type, material, DXF material thickness in inches, and subsystem
- DXF or 3D-print type and selected face/body topology ID
- Onshape document, workspace/version, element, and configuration
- authenticated Onshape user ID, name, and email when available
- file name, Storage path, MIME type, byte count, status, and server timestamp
- preview status and, when available, preview file name, Storage path, MIME type, dimensions, and byte count
- DXF bounding-box status and, when available, `dxfBounds` with width, height, and rectangular area in inches
- 3D-print bounding-box status and, when available, the legacy-compatible `stepBounds` field with X, Y, Z, and bounding-box volume in inches

Lathe requests do not create an exported CAD file. Their material is limited to Aluminum 7075, Polycarb, Steel, or Carbon Fiber. Their Firestore record has `kind: "lathe"`, `machiningType: "lathe"`, a queued status, the resolved owning part ID, `overallLengthInches`, stock dimensions in inches, and the instructions for End A and End B. When available, their preview image is stored alongside the other manufacturing previews.

OAuth refresh tokens are stored only in the backend-only `onshapeSessions` collection. Full exports remain inaccessible to browser clients; preview images are readable by signed-in Firebase users so the production dashboard can display them. Firebase Admin SDK calls from the function bypass those rules.

OAuth opens inside the Onshape application pane. After connecting, the app stores an opaque session token in that pane's session storage. **Disconnect** deletes the corresponding backend session and removes the browser token.

## Onshape API usage

The export pane is intentionally conservative with Onshape API calls:

- It waits until a face or part is selected before loading defaults, debounces rapidly changing selections for 600 ms, sends one request for the settled selection, and does not automatically retry missing metadata.
- Part name, material, face orientation, and bounding boxes are collected by one combined FeatureScript evaluation when possible. A part-metadata request is used only when that combined request fails and the UI cannot rely on an assembly instance name.
- The browser and backend keep selection suggestions for ten minutes in editable workspaces. The backend keeps a long-lived cache for immutable versions or microversions, while document names are cached for 24 hours.
- Export reuses the resolved part, face orientation, and measurements from the suggestion cache instead of resolving and measuring the same selection again.
- Shaded previews are content-addressed in Storage and indexed by source part, configuration, view, and model state. Workspace previews are reused for ten minutes, immutable version/microversion previews for 180 days, and concurrent requests on a warm function instance share one in-flight Onshape call.
- Lathe submission validates both faces, verifies their common owning part, and measures their separation in one FeatureScript evaluation when the selection already includes its part ID. Body details are reserved for exceptional selection messages that omit it.
- Remaining asynchronous DXF result checks use exponential backoff from three to fifteen seconds rather than polling every second.
- 3D-print files use Onshape's synchronous per-part STL endpoint, so they require one logical file request and no translation-status polling or result-download request. The backend explicitly follows Onshape's `307` redirect to its regional modeling server and reapplies OAuth only after validating the destination as an Onshape host. Binary STL coordinates are exported in millimeters for slicer compatibility.

The backend-only `onshapeExportSuggestionCache`, `onshapeDocumentNameCache`, and `onshapePreviewCache` collections contain selection or preview metadata but never OAuth tokens. Their `expiresAt` fields can be configured as Firestore TTL fields if automatic cleanup is desired. Client access is denied by the default Firestore rules because no matching allow rule is present.

## Notes on exports

- DXF requests resolve the selected planar face to an owning Part Studio body, then use Onshape's document DXF exporter with that face ID and its derived view plane. The body-details API is needed only when Onshape's selection message does not include the owning part and no cached resolution exists.
- DXF stock envelopes use a tight FeatureScript bounding box in the same face-plane coordinate system as the export. They describe the minimum axis-aligned rectangle around the exported face and do not include kerf, clamping, or edge-clearance allowance.
- 3D-print bounding boxes use the selected part's tight Part Studio X/Y/Z extents. They do not include supports, rafts, or printer clearance, and slicer reorientation can change the required build volume.
- STL requests resolve a selected body or face to its owning Part Studio body, then synchronously export that deterministic part ID. Firestore retains `kind: "step"`, the `stepBounds` field, and the `manufacturing/step/` Storage folder for compatibility with the existing production dashboard; `fileFormat: "STL"` and the `.stl` file name identify the actual output.
- DXF, STL, and lathe requests use a cached 512×512 shaded PNG/JPEG/WebP preview of the selected part, asking Onshape only on a cache miss. DXF previews use the selected face orientation; STL and lathe previews use an isometric orientation. Preview failure does not discard an otherwise valid manufacturing request.
- Lathe requests verify that both selected end faces are planar, parallel, and belong to one Part Studio body in the same FeatureScript call that measures their separation as `overallLengthInches`. The app uses the known dimensions of fixed hex stock and asks for round-stock dimensions instead of guessing them from model topology.
- Suggested document names and materials are best-effort conveniences. Students can edit them, and a failed or unknown metadata lookup does not prevent an export.
- Onshape may prepare DXF exports asynchronously; the function follows the returned result URL and polls for up to two minutes before reporting a timeout.
- The function rejects exports above 250 MB and gives each file a collision-safe suffix.
- If your enterprise uses a custom Onshape domain, the extension-provided `server` is preserved through OAuth and API calls. Only HTTPS `*.onshape.com` origins are accepted.

## Useful commands

```bash
npm run dev                 # Next.js UI
npm run typecheck           # UI TypeScript
npm run lint                # UI lint
npm run functions:build     # Firebase function TypeScript
npm run build               # Static site in out/
npm run check               # Run all checks and both builds
```
