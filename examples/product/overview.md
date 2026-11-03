# Flowdesk — synthetic product documentation

This fictional product and all repository links below are test fixtures. They do not describe a real service.

## Product scope

Flowdesk automates purchase approval workflows for business customers. It supports configurable approval stages, role-based approvers and an audit trail.
Customer workspaces are separate tenants. The product is operated as a hosted service in the EU.

## Existing capabilities

Users can submit purchase requests, approve or reject them, and export reports as CSV.
The API supports outbound webhooks for approval events. Webhook retries use exponential backoff and stop after 24 hours.
There is no documented SMS delivery capability. This statement records a documentation gap, not proof that SMS is impossible.
