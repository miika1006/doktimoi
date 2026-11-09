# Planning and case-fit analysis

Find the product overview and architecture by filename, heading or a targeted
search. Search each requirement or proposed capability separately (terms,
constraints, integrations, access control) so a popular topic cannot crowd out
another; alternate queries in one call describe the same intent. Retrieve the
smallest sufficient evidence, batch independent lookups in one tool call when
useful and reuse still-relevant evidence from the conversation.

## Gap analysis

Keep customer requirements, meeting notes, released capabilities and roadmap
items separate. Classify each requirement as:

- Supported: cite the current capability and its conditions.
- Requires configuration/integration: cite the extension mechanism and the
  remaining work.
- Documented gap: cite the explicit incompatibility or unsupported capability.
- Unknown: documentation is missing, ambiguous or conflicting; state what to
  verify. A failed search never proves lack of support.

Quote the decisive range, not whole documents, with limits, roles,
prerequisites, versions and exceptions. A planned feature is not released, and a
customer requirement is not evidence of support.

## Feature planning and source repositories

Map the feature to documented components, data ownership, integrations and
security rules. Keep repo URLs and code paths from excerpts: they show where to
inspect, not current code behavior. Cite the documentation and label proposals
as proposals. If the task requires implementation verification, read only the
relevant files with the host's read-only repository tools within the user's
scope; never clone or index every linked repository.

When references conflict, retrieve both and explain the conflict, preferring
explicit version/release scope over filenames or scores. The first four results
are not exhaustive: broaden only for unresolved requirements, then list the
remaining uncertainties.
