# Integrations

## ERP connector

The existing ERP connector imports purchase orders through a REST API. It is read-only: Flowdesk does not write approved orders back to the ERP.
The worker polls once every 15 minutes. The current connector processes at most 500 orders per hour per tenant.
Two-way synchronization is planned but not shipped. See roadmap.md.

## Authentication

Enterprise customers can use SAML 2.0 single sign-on. OpenID Connect (OIDC) login is planned but not currently supported.
API access uses tenant-scoped API keys. Keys can be rotated without interrupting existing workflows.
