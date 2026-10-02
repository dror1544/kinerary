# Connected Assistants contracts (CA-00)

Status: CA-00 contract draft with dated CA-01 R1 implementation evidence added 2026-10-02. The original 2026-09-27 design and evidence-tree snapshot below are historical; R1 is not a Sprint 6 release gate.

Historical evidence trees (2026-09-27, before CA-01 L1/P1): `integration/sprint-6` at `b70d79e315ccfc00790650205198a2c2126765bc` and current `main` at `fbf38997ec643035e49f690c4e3f2c148d4894f1`, both confirmed against remote branch heads on 2026-09-27. Plan PR #257 is open at `4122abe`. Rows below name their actual branch. The booking/MCP observations apply to both named trees; the control-plane document and converged identity observations apply to Sprint 6 only. Main has not received those Sprint 6 foundations.

## Existing owners and coexistence

| Authority | Observed implementation | Connected Assistants contract |
|---|---|---|
| Identity (Sprint 6) | `control-plane/api/src/password-identity.ts` resolves an email to one `user_id`; `portal.ts` uses active `trip_memberships`. Current main does not yet have this converged resolver. | Reuse users and memberships. No parallel account registry or email-based trip authorization. |
| Account portal (Sprint 6) | `portal.ts` lists membership-scoped trips and owns browser signup, invite and plan-approval routes. Main has an earlier portal implementation. | Extend this surface for grants and account home after handover. A grant never creates membership. |
| Per-trip MCP | `server/trip-mcp/{oauth,tools}.js` is on main (#220) and Sprint 6 (#228) | Keep trip-local OAuth and subdomains during central migration. A trip token is not an account token. #227 remains open and promotion is separately gated. |
| Documents (Sprint 6) | `document-{registry,store,intake,correction}.ts`, `trip_documents` and `source_artifacts` store originals, deliveries, extractions and review. These modules are absent from current main. | Reuse these records. No second document store or correction workflow. PR #116 remains open for VM bootstrap and has its own release decision. |
| Booking originals | `server/server.js` has organizer-scoped upload and authenticated retrieval; public `server/trip-mcp/tools.js` has booking tools but no byte transport | CA-01 must transport original bytes and prove linkage and retrieval independently. |
| Lifecycle (Sprint 6) | `lifecycle.ts`, `plan-approval.ts`, `portal.ts` separate confirmation, approval, provisioning and activation | Connector actions preserve those transitions and report pending work honestly. |

The main config allow-list and trip MCP have Sprint 6 carries. The main document MIME fix has a separate Sprint 6 carry branch; recheck its merge before each code brief. Do not cherry-pick divergent histories wholesale. #163 directs a separate main hotfix investigation; its owner and #227's owner must hand over shared server paths before CA-01 edits them. Claude owns Sprint 6 account, interview, document, relay, model-runner and migration work. Lack of an issue claim is not path ownership.

## Identity and delegated access

1. A central OAuth grant binds one authenticated Kinerary `user_id`, client, audience, explicit trip set and action set. The account subject is resolved through the existing identity path. Client-provided email, conversation memory and trip ID are selectors, never proof of access.
2. Every request intersects current identity, active trip membership and role, the relevant `dashboard_access` or `runtime_access` entitlement, an unrevoked connector grant for that trip, and action permission. Missing or unknown facts deny. A grant does not silently include future trips.
3. Member and organizer rights differ per trip. Role demotion, membership removal or grant revocation narrows existing access tokens immediately. A token for trip A cannot authorize trip B even when one user belongs to both.
4. Consent binds the browser session, CSRF proof, client, audience, trips and actions. Keep the existing trip-local gateway's consent refusal. Central consent needs its own reviewed origin and session design. Do not forward an unrestricted runtime agent key; runtime delegation is short-lived and trip/action-scoped with a second server-side check.
5. Writes carry an idempotency key and expected version. A retry converges; a stale version conflicts rather than overwriting another assistant. Audit entries identify actor, client, grant, trip and outcome without recording credentials.

CA-02 must settle the exact grant schema, token lifetime, consent UI and runtime delegation mechanism with the account and security owners. Current trip-local SQLite OAuth tables are not assumed to be the account grant store.

## Document transport and result contract

Inputs are original bytes, source reference and delivery ID, claimed filename/MIME, explicitly selected destination trip and idempotency key. The server authorizes both source access and destination membership and the appropriate dashboard/runtime entitlement. A folder link or temporary assistant download URL proves neither ownership nor destination. URLs are transport references, not permanent assets; fetching must reject private/internal destinations and unsafe redirects.

Validate a bounded byte count and type from content; store exact bytes, checksum and provenance before extraction. Same bytes in one trip reuse a document while each delivery stays recorded. A replacement is a new version linked to the prior one. Extraction records grounded facts and uncertainty; matching proposes links for review. Existing versioned correction applies approved changes only through its own route and release gate. On Sprint 6, a ready_private correction can reprovision a site; the organizer document route is off by default until the #217 walk and the separate owner decision to switch it on. CA-01 confirmation storage cannot invoke that route or report a pending correction as deployed. Extraction failure leaves the original retrievable. Partial failures resume without duplicate records. Disconnect stops future reads and queued fetches; source deletion does not silently delete retained trip originals.

Return independent states with a stable document and operation ID:

| Field | Allowed result meaning |
|---|---|
| `original` | `stored`, `duplicate` or `failed`; digest and authenticated retrieval reference only for retained bytes |
| `facts` | `pending`, `recorded`, `needs_review` or `failed` |
| `booking_link` | `pending`, `linked`, `no_match`, `rejected` or `failed`, with exact booking ID only if linked |
| `itinerary_link` | `pending`, `linked`, `not_applicable`, `rejected` or `failed` |
| `review` | `pending`, `approved`, `rejected` or `stale`, with the reviewed version |

`complete` requires an authenticated site read of the original and a readback of every requested link on the named booking or plan item. The current `POST /api/bookings/:id/confirmation` returns success after an `UPDATE` without checking whether a booking matched; CA-01 must correct that. Missing or inaccessible booking means linkage fails even if storage succeeded. Tests cover duplicate, replacement, no-booking, partial failure and retry.

Official [OpenAI plugin file documentation](https://developers.openai.com/plugins/reference), checked 2026-09-27, defines top-level `_meta["openai/fileParams"]` inputs with `download_url` and `file_id`; MIME and filename can be absent. Widget file helpers are optional. This is a candidate transfer path, not a proven Kinerary client run. Official [Claude custom connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and [chat upload](https://support.claude.com/en/articles/8241126-upload-files-to-claude) guidance describes remote MCP and chat attachments, but does not establish that attachment bytes reach a custom tool. CA-01 needs a real client spike and an authenticated upload-panel fallback if byte transfer is unavailable.

## Lifecycle and release boundary

The current lifecycle path includes `pending_signup_approval -> draft -> intake_in_progress -> intake_confirmed -> planned -> provisioning_approved -> provisioning -> ready_private -> activation_approved -> active`. Confirmation does not provision or publish. Existing site logins and per-trip MCP remain compatible until separately retired. Telegram Mini App launch data supplies context, not account authentication; private views use existing account sign-in or a reviewed handoff, with retired Telegram SSO still retired. CA-01 does not expand Release A, authorize a live-trip write, or permit release promotion or deployment.

## Decisions and pending handovers

- Reuse global users and memberships instead of a second account registry: identity convergence and portal ownership already live there.
- Keep per-trip MCP while central routes arrive instead of retiring origins immediately: it is already live on one main-derived trip and has a separate release gate.
- Retain exact original bytes in the current registry instead of extracted text or temporary assistant URLs: only the original can prove the site will open the voucher later.
- Require account handoff for Mini App private views instead of Telegram launch authentication: the old SSO route was retired.

The narrow CA-01 handover was recorded on #249 on 2026-09-27 for `server/trip-mcp/**` and the booking-confirmation route region of `server/server.js`; other shared server paths remain excluded. Later slices need handovers for account, interview, document, relay, model-runner and migration paths. PR #116 remains with its author and Claude's release decision. Exact OAuth mechanics and imported-file retention/deletion periods need product/security review; code briefs cannot fill them by guess.

## CA-01 R1 implemented retrieval contract (2026-10-02)

R1 is prepared on feat/ca01-confirmation-readback, based on initiative commit
cc048c6c52a4d3421c0025c55abff0117bde8b88. It has not been integrated into the
initiative branch, Sprint 6, main or production.

get_booking_confirmation accepts only a positive safe-integer booking_id.
Its strict schema rejects additional selectors. It is offered only to current
organizer write grants despite its read-only annotation, preserving the brief's
organizer file-management scope.

The tool resolves conf_file through caller-scoped /api/bookings. It accepts
no caller URL or path. The client validates and encodes the stored basename,
then reads only the confirmation route on the fixed trip listener with a
short-lived JWT for the connected person. Arbitrary attachment URL fetching
requires its own reviewed transport contract.

The binary phase is bounded to 5 MiB and 10 seconds, covering headers and
streamed body. The preceding booking lookup is outside that deadline.
Redirects are refused; both declared and streamed size are checked.
application/pdf and a PDF signature are required; this is a retrieval/type
check, not full PDF validation.

Success returns exact bytes as an embedded application/pdf MCP resource under
a content-addressed urn:sha256 URI, plus booking_id, byte_count and sha256
metadata. No credentials, local paths, public download URL or retained cache
are returned. R1 performs no upload mutation. Lookup and transport exceptions
are sanitized; failed retrieval returns no resource.

Actual-server Unicode filename retrieval exposed an existing shared
Content-Disposition defect outside R1's ownership. The tool reports failure
truthfully. Synthetic safe-Unicode filename guard coverage does not establish
successful retrieval through the real server. The server owner must fix or
explicitly carry that defect before Unicode-original support is claimed.

The independent verifier's 2026-10-02 final suite passed 616/616 tests in
65.3 seconds, with zero skips. The final boundary addendum independently
verified sanitized lookup errors (one selected test passed, six unrelated
cases skipped), with no new finding. These are local synthetic observations;
real ChatGPT/Claude client acceptance and direct attachment transfer remain
unfinished.

The earlier 3 October merge freeze is superseded by
[#249 decision 55](https://github.com/dror1544/kinerary/issues/249#issuecomment-5856293225).
Release A deploys a pinned release/a revision. Ready CA-01 PRs may enter Sprint
6 through normal security/integrator review and owner merge authority;
outstanding OAuth findings and main-via-sprint conditions remain.
