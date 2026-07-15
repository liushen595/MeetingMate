# MeetingMate PC MVP

This directory contains the first runnable PC desktop MVP for MeetingMate.

The goal of this version is to establish the desktop application skeleton and the core product workspace shape before adding real persistence, editor engine, backend APIs, and AI streaming.

## Tech Stack

- Electron for the desktop shell
- React for the renderer UI
- Slate.js for the structured document editor
- TypeScript for type safety
- Vite and electron-vite for development and build tooling
- TailwindCSS for styling
- Zustand for lightweight workspace state
- npm for package management

## What This MVP Includes

- A runnable Electron desktop app
- A React + TypeScript renderer process
- A basic secure preload bridge
- Local SQLite storage through Electron main-process services
- Document edit autosave to local SQLite
- A three-column PC workspace layout
- Mock manuscript data with audio, image, handwriting, and text blocks
- Mock document data with heading, paragraph, list, quote, and action blocks
- A document library panel
- A manuscript source panel
- Manuscript actions: create, rename, close, delete, open local JSON files, capture content, and export to document
- A central document preview/editor workspace
- A Slate-based central document editor with autosave
- A mock AI Agent panel with common actions
- A README describing the current work and next steps

## What Is Not Included Yet

- Real backend API integration
- Real SSE AI streaming
- Login and token management
- Sync queue
- PDF or DOCX export
- Installer packaging and auto-update

These should be added after the app shell and workspace flow are stable.

## Local SQLite

The current MVP uses Electron's main process to manage SQLite through Node's built-in `node:sqlite` module.

The renderer process does not access SQLite directly. It reads initial workspace data through the preload bridge:

```txt
React renderer
-> window.meetingMate.getInitialWorkspace()
-> preload IPC bridge
-> Electron main process
-> SQLite database service
```

For this repository setup, the database is created inside the PC project directory:

```txt
MeetingMate\PC\data\meetingmate.sqlite
```

If an older MVP database exists under Electron's `userData` directory, the app copies it into `PC\data` on first startup when the new database does not exist yet.

Current tables:

```txt
documents
manuscripts
settings
```

Notes:

- `node:sqlite` is currently marked experimental by Node/Electron, so startup may print an experimental warning.
- This avoids native dependency setup for `better-sqlite3` during the MVP stage.
- If `node:sqlite` becomes unsuitable later, replace the database service behind the same IPC boundary.
- `PC/data/` is ignored by Git because it contains local runtime data.

## Document Editing And Autosave

The central document editor uses Slate.js and persists back to the existing `DocumentBlock[]` JSON shape.

Current supported document block types:

```txt
heading
paragraph
list
quote
action
```

Document autosave flow:

```txt
Slate editor change
-> convert Slate value to DocumentBlock[]
-> window.meetingMate.saveDocument(...)
-> preload IPC bridge
-> Electron main process
-> SQLite documents table
```

The editor saves only after content changes and the user stops typing for 5 seconds.

## Manuscript Editing And Autosave

The manuscript editor is still an MVP textarea. It supports a simple markdown-like format and autosaves to SQLite after changes.

Supported MVP syntax:

```txt
# Heading

Paragraph text

List title
- item 1
- item 2

> Quote

TODO: Action item
```

## Manuscript Files

The manuscript panel currently supports:

- New: creates an empty desktop manuscript in SQLite.
- Close: closes the current manuscript preview without deleting it from SQLite.
- Open local: imports a local `.json` manuscript file and stores it in SQLite.
- Rename: renames the selected manuscript and updates SQLite.
- Delete: asks for confirmation, removes the manuscript from the UI, and deletes it from SQLite.
- Text capture: appends typed text into the selected manuscript.
- Handwriting: currently uses a placeholder input and appends recognized handwriting text.
- Speech to text: currently opens an audio file and returns a placeholder result; this is the future ASR API boundary.
- Image to text: currently opens an image file and returns a placeholder result; this is the future OCR/VLM API boundary.
- Export document: converts the selected manuscript into a structured document and adds it to the document library.

Each manuscript now has its own editable draft. Switching between manuscripts loads that manuscript's own blocks into the editor, and edits autosave back to the selected manuscript after the user stops typing for 5 seconds.

The document library no longer creates documents directly. Documents are generated from manuscripts first, then edited in the central Slate document editor. The document library sidebar currently keeps document deletion as its management action.

Supported local JSON shape:

```json
{
  "title": "Imported meeting manuscript",
  "blocks": [
    {
      "id": "block-1",
      "type": "text",
      "title": "Note",
      "timestamp": "10:00",
      "summary": "A short note",
      "props": { "content": "Hello" }
    }
  ]
}
```

If `title` is missing, the file name is used. If `source` is missing, it is stored as `import`.

Autosave flow:

```txt
textarea edit
-> convert text to ManuscriptBlock[]
-> window.meetingMate.saveManuscript(...)
-> preload IPC bridge
-> Electron main process
-> SQLite manuscripts table
```

## Run Locally

From this directory:

```bash
npm install
npm run dev
```

Build the app:

```bash
npm run build
```

Preview the built app:

```bash
npm run preview
```

## Current Product Shape

The MVP follows the PC-side role described in `docs/foundation.md`:

- PC is the deep editing and AI workspace.
- Mobile web is expected to focus on capture and lightweight editing.
- Both sides should eventually share the same `Manuscript` and `Document` data models.

Current workspace layout:

```txt
Primary sidebar: switches between document library, manuscript workspace, AI workspace, exports, and settings.
Document library: document list + Slate document editor + AI panel.
Manuscript workspace: manuscript list + blank capture/editor canvas + manuscript actions.
AI workspace: standalone AI panel and future AI task surface.
```

The manuscript workspace is no longer compressed under the document library. Click `手稿` in the primary sidebar to open a dedicated manuscript workspace with text input, handwriting canvas, speech-to-text, and image-to-text entry points.

## Recommended Next Steps

1. Add a formatting toolbar and keyboard shortcuts to the Slate document editor.
2. Replace the MVP manuscript textarea with a block-aware editor.
3. Add a `sync_queue` table for future backend synchronization.
4. Move shared types into a future repository-level shared package.
5. Add API client modules for auth, manuscripts, documents, tasks, and AI.
6. Implement manuscript-to-document async task integration.
7. Add SSE support for AI Agent streaming output.
8. Add export task integration for PDF and DOCX.
