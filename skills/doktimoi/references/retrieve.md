# Planning and case-fit analysis

Locate the product overview and architecture through filenames/headings or a
targeted search. For each requirement or proposed capability, search its terms,
constraints, integrations and access-control implications. Alternate queries in
one call should describe the same intent; use separate searches for independent
requirements so one popular topic cannot crowd out another.

Retrieve the smallest sufficient evidence set, not a fixed number of chunks for
the entire analysis. Batch independent lookups in one host tool call when useful.
Reuse already retrieved, still-relevant evidence within the conversation.

## Gap analysis

Keep customer requirements, meeting notes, released product capabilities and
roadmap items separate. For each requirement report one of:

- Supported: cite a specific current capability and its conditions.
- Requires configuration/integration: cite the supported extension mechanism;
  identify the work still needed.
- Documented gap: cite an explicit incompatibility or unsupported capability.
- Unknown: documentation is missing, ambiguous or conflicting. State what must
  be verified; a failed search alone never proves lack of support.

Quote the decisive source range, not a full document. Include constraints such as
limits, roles, prerequisites, versions and exceptions. A planned feature is not
released functionality. A customer's requirement is not evidence of product support.

## Feature planning and source repositories

Map the feature to documented components, data ownership, integrations and
security rules. Preserve repo URLs and code-path references from source excerpts.
They identify where implementation would be inspected; they do not prove current
code behavior. Cite the documentation and label proposals as proposals.

If implementation verification is required by the active task, use the host's
normal read-only repository tools for the specific relevant files. Follow the
user's access/scope constraints. Do not clone or index every linked repository
merely because a document contains a URL.

When references conflict, retrieve both and explain the conflict. Prefer explicit
version/release scope over guessing from filenames or a search score. Do not
claim exhaustive coverage from the first four results. Broaden only where a
requirement remains unresolved, then finish with the remaining uncertainties.
