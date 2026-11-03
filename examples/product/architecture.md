# Architecture and source repositories

All links in this synthetic fixture use example.invalid and must not be fetched.

## Components

| Component | Repository | Responsibility |
| --- | --- | --- |
| Browser application | https://example.invalid/flowdesk/web | UI and purchase request forms; main workflow UI is in src/features/approvals |
| API service | https://example.invalid/flowdesk/api | Authoritative workflow state and access control; workflow handlers are in src/workflows |
| Background worker | https://example.invalid/flowdesk/worker | ERP imports, webhook retries and scheduled jobs |

## State and connectivity

The API is the authoritative store for approval state. The browser must be online to submit or approve a request.
Offline approvals are not supported. The browser does not retain a local copy of confidential request attachments.
Adding offline approvals would require a conflict-resolution design and a security review of local storage.

## Repository boundaries

This documentation repository contains no application source code. Repository links identify places to inspect; they do not prove that a proposed change has been implemented.
