# Connected Assistants contracts (CA-00)

Status: design review draft for #248, 2026-09-27. This is a contract for later slices, not a claim that the implementation exists or a Sprint 6 release gate.

Evidence trees: `integration/sprint-6` at `b70d79e315ccfc00790650205198a2c2126765bc` and current `main` at `fbf38997ec643035e49f690c4e3f2c148d4894f1`, both confirmed against remote branch heads on 2026-09-27. Plan PR #257 is open at `4122abe`. Rows below name their actual branch. The booking/MCP observations apply to both named trees; the control-plane document and converged identity observations apply to Sprint 6 only. Main has not received those Sprint 6 foundations.

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

Before code edits, CA-01 needs the #227/#163/Sprint 6 owners' handover for `server/trip-mcp/**` and `server/server.js`. Later slices need handovers for account, interview, document, relay, model-runner and migration paths. PR #116 remains with its author and Claude's release decision. Exact OAuth mechanics and imported-file retention/deletion periods need product/security review; code briefs cannot fill them by guess.
