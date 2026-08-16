# Shop Export for Onshape

A classroom-focused Onshape right-panel extension that sends manufacturing files and manual machining requests to Firebase:

- Select one planar face and export a DXF for laser, plasma, or waterjet cutting.
- Select one solid part—or any face on that part—and export a STEP file for 3D printing.
- Create a manual-lathe request without exporting a file by selecting its two planar end faces.
- Require a friendly name and quantity; DXF and lathe requests also require material and accept an optional subsystem.
- Capture fixed hex profiles, custom round shaft/tube diameters, and independent turn-down, tap, drill, or custom instructions for both ends.
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

Add an extension to the OAuth application with:

- Location: **Element right panel**
- Context: **Inside Part Studio** (or the available Part Studio context in your Onshape plan)
- Action URL:

```text
https://GITHUB_USER.github.io/REPOSITORY/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

Onshape supplies `server` and `userId` as default query parameters. The app validates `postMessage` events against that `server` origin before accepting selections.

## 5. Deploy the UI to GitHub Pages

In the GitHub repository:

1. Open Settings → Pages and select **GitHub Actions** as the source.
2. Add an Actions variable named `NEXT_PUBLIC_API_BASE_URL` containing the deployed Firebase function URL, without a trailing slash.
3. Push to `main` or manually run **Deploy UI to GitHub Pages**.

The workflow supplies the repository base path during the Next.js static build and deploys the `out/` directory.

## Data written for each request

The Storage object includes custom metadata for the request and the `exports/{exportId}` Firestore document includes:

- friendly name, quantity, machining type, material, and subsystem
- DXF or STEP type and selected face/body topology ID
- Onshape document, workspace/version, element, and configuration
- authenticated Onshape user ID, name, and email when available
- file name, Storage path, MIME type, byte count, status, and server timestamp

Lathe requests do not create a Storage object. Their material is limited to Aluminum 7075, Polycarb, Steel, or Carbon Fiber. Their Firestore record has `kind: "lathe"`, `machiningType: "lathe"`, a queued status, the resolved owning part ID, stock dimensions in inches, and the instructions for End A and End B.

OAuth refresh tokens are stored only in the backend-only `onshapeSessions` collection. Firestore and Storage rules deny all direct browser access; Firebase Admin SDK calls from the function bypass those rules.

OAuth opens inside the Onshape application pane. After connecting, the app stores an opaque session token in that pane's session storage. **Disconnect** deletes the corresponding backend session and removes the browser token.

## Notes on exports

- DXF requests resolve the selected planar face with the Part Studio body-details API, then use Onshape's document DXF exporter with that face ID and its derived view plane.
- STEP requests resolve a selected body or face to its owning Part Studio body, then use the Part Studio translation workflow with that deterministic part ID.
- Lathe requests verify that the selected edge or faces belong to one Part Studio body. The app uses the known dimensions of fixed hex stock and asks for round-stock dimensions instead of guessing them from model topology.
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
