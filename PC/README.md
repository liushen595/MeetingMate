# MeetingMate PC MVP

This directory contains the first runnable PC desktop MVP for MeetingMate.

The goal of this version is to establish the desktop application skeleton and the core product workspace shape before adding real persistence, editor engine, backend APIs, and AI streaming.

## Tech Stack

- Electron for the desktop shell
- React for the renderer UI
- TypeScript for type safety
- Vite and electron-vite for development and build tooling
- TailwindCSS for styling
- Zustand for lightweight workspace state
- npm for package management

## What This MVP Includes

- A runnable Electron desktop app
- A React + TypeScript renderer process
- A basic secure preload bridge
- A three-column PC workspace layout
- Mock manuscript data with audio, image, handwriting, and text blocks
- Mock document data with heading, paragraph, list, quote, and action blocks
- A document library panel
- A manuscript source panel
- A central document preview/editor workspace
- A mock AI Agent panel with common actions
- A README describing the current work and next steps

## What Is Not Included Yet

- SQLite local database
- Slate.js real rich-text editor
- Real backend API integration
- Real SSE AI streaming
- Login and token management
- Sync queue
- PDF or DOCX export
- Installer packaging and auto-update

These should be added after the app shell and workspace flow are stable.

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
Left: document library and manuscript list
Center: structured document workspace
Right: AI Agent panel and suggested actions
```

## Recommended Next Steps

1. Add SQLite through Electron main-process services.
2. Replace the mock editor with Slate.js.
3. Move shared types into a future repository-level shared package.
4. Add API client modules for auth, manuscripts, documents, tasks, and AI.
5. Implement manuscript-to-document async task integration.
6. Add SSE support for AI Agent streaming output.
7. Add export task integration for PDF and DOCX.
