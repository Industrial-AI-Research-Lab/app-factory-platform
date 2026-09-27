# UI Overview

This directory contains the React frontend for AppFactory.

## Responsibilities

- Render the project execution UI (chat + graph, tabs, banners, approvals).
- Subscribe to SSE events and `GET /api/projects/{id}` and project them into UI state.
- Enforce "no synthetic UI state": everything visible must be backed by backend data.

## Key components

- `pages/ExecutionMonitor.jsx`
  - Owns project-level state for the UI.
  - Subscribes to SSE, pre-seeds approvals, and manages stopped/reverted banners.
- `components/ChatInterface.jsx`
  - Renders the conversation and approval cards.
  - Sends refine/approve/retry actions.

## Design references

- Business logic and project lifecycle: [`docs/business-logic.md`](../../docs/business-logic.md).
- Detailed docs: [`docs/`](../../docs/).
- Карта страниц фронтенда: [`docs/frontend-pages.md`](../../docs/frontend-pages.md).

The UI should treat backend data as the source of truth and avoid fabricating messages, approvals, or status that do not exist on the backend.

