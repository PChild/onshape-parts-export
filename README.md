# Shop Export for Onshape

A classroom-focused Onshape right-panel extension that sends manufacturing files and manual machining requests to Firebase:

- Select one planar face and export a DXF for laser, plasma, or waterjet cutting.
- Select one solid part—or any face on that part—and export a STEP file for 3D printing.
- Store STEP requests with the fixed material value `3d Print`.
- Create a manual-lathe request without exporting a file by selecting its two planar end faces.
- Measure and store the lathe part's overall face-to-face length in inches and generate an isometric preview.
- Require a friendly name and quantity; DXF requests also require material thickness in inches, while DXF and lathe requests require material.
- Prefill the editable subsystem field from the Onshape document name for every request, and loosely match a selected DXF part's Onshape material to a supported shop material when possible.
- Prefill the editable friendly name from the selected Onshape part for STEP and lathe requests.
- Filter DXF materials by process: laser supports SRPP, polycarbonate, and wood; plasma supports steel plus Aluminum 6061, 7075, and 5052; waterjet supports every listed DXF material.
- Match explicit Onshape aluminum grades when available and default an unspecified aluminum material to the commonly used Aluminum 6061.
- Capture fixed hex profiles, custom round shaft/tube diameters, and independent turn-down, tap, drill, or custom instructions for both ends.
- Keep the two lathe end-operation sections collapsible for smaller classroom screens.
- Adopt face selections made while the panel is open, preserve compatible selections when switching processes, and reuse one selected face as Lathe End A.
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
    ├── Cloud Storage: manufacturing/previews/YYYY-MM-DD/image
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

Open that panel first, then click geometry directly or use its normal selection button. A selected face can be reused for DXF or STEP, and it becomes End A when switching to Lathe so only End B remains to be selected. The backend reads the assembly definition after the selection and resolves the chosen occurrence to its source document microversion, Part Studio, configuration, and part ID. Keep the original **Part Studio** extension too.

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
- DXF or STEP type and selected face/body topology ID
- Onshape document, workspace/version, element, and configuration
- authenticated Onshape user ID, name, and email when available
- file name, Storage path, MIME type, byte count, status, and server timestamp
- preview status and, when available, preview file name, Storage path, MIME type, dimensions, and byte count

Lathe requests do not create an exported CAD file. Their material is limited to Aluminum 7075, Polycarb, Steel, or Carbon Fiber. Their Firestore record has `kind: "lathe"`, `machiningType: "lathe"`, a queued status, the resolved owning part ID, `overallLengthInches`, stock dimensions in inches, and the instructions for End A and End B. When available, their preview image is stored alongside the other manufacturing previews.

OAuth refresh tokens are stored only in the backend-only `onshapeSessions` collection. Full exports remain inaccessible to browser clients; preview images are readable by signed-in Firebase users so the production dashboard can display them. Firebase Admin SDK calls from the function bypass those rules.

OAuth opens inside the Onshape application pane. After connecting, the app stores an opaque session token in that pane's session storage. **Disconnect** deletes the corresponding backend session and removes the browser token.

## Notes on exports

- DXF requests resolve the selected planar face with the Part Studio body-details API, then use Onshape's document DXF exporter with that face ID and its derived view plane.
- STEP requests resolve a selected body or face to its owning Part Studio body, then use the Part Studio translation workflow with that deterministic part ID.
- DXF, STEP, and lathe requests ask Onshape for a 512×512 shaded PNG/JPEG/WebP preview of the selected part. DXF previews use the selected face orientation; STEP and lathe previews use an isometric orientation. Preview failure does not discard an otherwise valid manufacturing request.
- Lathe requests verify that both selected end faces are planar, parallel, and belong to one Part Studio body. Their plane separation is converted from Onshape model units to `overallLengthInches`. The app uses the known dimensions of fixed hex stock and asks for round-stock dimensions instead of guessing them from model topology.
- Suggested document names and materials are best-effort conveniences. Students can edit them, and a failed or unknown metadata lookup does not prevent an export.
- Onshape may prepare exports asynchronously; the function follows the returned result URL and polls for up to two minutes before reporting a timeout.
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
