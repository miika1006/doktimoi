# Security

## Data and audit

Purchase requests and attachments are stored in the EU. Audit events are retained for 90 days.
All approval actions require an authenticated user and a tenant-scoped role check.
Attachments must not be stored persistently in browser local storage.

## Approval rules

An approver cannot approve their own purchase request. A delegated approver must satisfy the same tenant and role checks.
Approval policies are enforced by the API, even when the UI hides an action.
