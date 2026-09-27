import { useEffect, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Brand } from "../components/Brand";
import {
  AdminApiError,
  clearAdminKey,
  getStoredAdminKey,
  storeAdminKey,
  getAdminAudit,
  getAdminFailures,
  getAdminFunnel,
  getAdminJobs,
  getAdminReport,
  getAdminVersions,
  type AdminAuditEvent,
  type AdminFailure,
  type AdminFunnelSummary,
  type AdminJob,
  type AdminReport,
  type AdminRelease,
} from "../admin-api";

/**
 * Sprint 6 slice 1 (docs/sprint6-tracks.md decision 23): read-only. There is
 * no suspend/retry control on this page and none should be added here —
 * that is slice 2, and it needs its own server-side authorization, not a
 * button wired to nothing.
 *
 * Behind an operator key (X-API-Key), never the organizer's cookie session —
 * see admin-api.ts's module doc for why this is a separate client rather than
 * a reuse of api.ts.
 */
export default function AdminDashboardPage() {
  const [key, setKeyState] = useState(() => getStoredAdminKey());
  const [inputKey, setInputKey] = useState("");
  const enabled = key.length > 0;

  const report = useQuery({ queryKey: ["admin-report", key], queryFn: () => getAdminReport(key), enabled, retry: false });
  const funnel = useQuery({ queryKey: ["admin-funnel", key], queryFn: () => getAdminFunnel(key), enabled, retry: false });
  const jobs = useQuery({ queryKey: ["admin-jobs", key], queryFn: () => getAdminJobs(key), enabled, retry: false });
  const failures = useQuery({ queryKey: ["admin-failures", key], queryFn: () => getAdminFailures(key), enabled, retry: false });
  const versions = useQuery({ queryKey: ["admin-versions", key], queryFn: () => getAdminVersions(key), enabled, retry: false });
  const audit = useQuery({ queryKey: ["admin-audit", key], queryFn: () => getAdminAudit(key), enabled, retry: false });

  const unauthorized = [report, funnel, jobs, failures, versions, audit].some(
    (query) => query.error instanceof AdminApiError && query.error.status === 401,
  );
  useEffect(() => {
    // The stored key was refused (wrong, or revoked since it was entered):
    // drop it rather than keep re-sending a rejected credential on every
    // refetch, and fall back to the unlock form.
    if (unauthorized) {
      clearAdminKey();
      setKeyState("");
    }
  }, [unauthorized]);

  function unlock(event: React.FormEvent) {
    event.preventDefault();
    storeAdminKey(inputKey);
    setKeyState(inputKey);
  }

  function lock() {
    clearAdminKey();
    setKeyState("");
    setInputKey("");
  }

  if (!enabled) {
    return (
      <div className="product-shell">
        <header className="product-header"><Brand /></header>
        <main className="placeholder-card">
          <p className="eyebrow">Operator only</p>
          <h1>Super-admin dashboard</h1>
          <p>
            This reads every trip&apos;s jobs, funnel activity and audit trail at once — not
            one organizer&apos;s own data. Enter the operator key to continue.
          </p>
          <form className="compact-form" onSubmit={unlock}>
            <label>
              Admin key
              <input
                required
                type="password"
                autoComplete="off"
                value={inputKey}
                onChange={(event) => setInputKey(event.target.value)}
              />
            </label>
            <button className="button wide">Unlock</button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="product-shell">
      <header className="product-header">
        <Brand />
        <nav className="dashboard-nav">
          <span>Super-admin dashboard</span>
          <button className="text-button" onClick={lock}>Lock</button>
        </nav>
      </header>
      <main className="dashboard-main">
        <div className="page-title">
          <div>
            <p className="eyebrow">Read-only · every trip</p>
            <h1>Control-plane dashboard</h1>
          </div>
        </div>
        <ReportSection report={report} />
        <FunnelSection funnel={funnel} title="Funnel (all time)" />
        <JobsSection jobs={jobs} />
        <FailuresSection failures={failures} />
        <VersionsSection versions={versions} />
        <AuditSection audit={audit} />
      </main>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice" role="alert">{children}</div>;
}

function SectionState<T>({ query, label }: { query: UseQueryResult<T, Error>; label: string }): React.ReactNode {
  if (query.isPending) return <p>Loading {label}…</p>;
  if (query.isError) return <Notice>Could not load {label}: {query.error.message}</Notice>;
  return null;
}

function formatRate(rate: number | null): string {
  return rate === null ? "not yet measured" : `${(rate * 100).toFixed(1)}%`;
}

function ReportSection({ report }: { report: UseQueryResult<AdminReport, Error> }) {
  return (
    <section className="workflow-card">
      <h2>Daily report</h2>
      <p className="subtle">
        This dashboard&apos;s primary content, per decision 23: usage and job activity rolled up
        by day. The five assistant-quality rates below are not computed yet — see
        &quot;Not measured yet&quot;.
      </p>
      <SectionState query={report} label="the daily report" />
      {report.data && (
        <>
          <p><strong>{report.data.date}</strong> ({report.data.windowStart} → {report.data.windowEnd})</p>
          <h3>Funnel that day</h3>
          <FunnelTable funnel={report.data.funnel} />
          <h3>Jobs that day</h3>
          {report.data.jobs.byTypeAndState.length === 0
            ? <p>No jobs recorded for this day.</p>
            : <table>
                <thead><tr><th>Job type</th><th>State</th><th>Count</th></tr></thead>
                <tbody>
                  {report.data.jobs.byTypeAndState.map((row) => (
                    <tr key={`${row.jobType}-${row.state}`}><td>{row.jobType}</td><td>{row.state}</td><td>{row.count}</td></tr>
                  ))}
                </tbody>
              </table>}
          <h3>Releases by status</h3>
          <ul>
            {Object.entries(report.data.releases.byStatus).map(([status, count]) => <li key={status}>{status}: {count}</li>)}
          </ul>
          <h3>Not measured yet</h3>
          <p className="subtle">
            These need `control_plane.assistant_events` populated (the Hermes plugin and its
            authenticated ingest route are not built) — this report does not fabricate them.
          </p>
          <ul>{report.data.notMeasuredYet.map((name) => <li key={name}>{name.replaceAll("_", " ")}</li>)}</ul>
        </>
      )}
    </section>
  );
}

function FunnelTable({ funnel }: { funnel: AdminFunnelSummary }) {
  return (
    <table>
      <thead><tr><th>From</th><th>To</th><th>From count</th><th>To count</th><th>Rate</th></tr></thead>
      <tbody>
        {funnel.conversions.map((c) => (
          <tr key={`${c.from}-${c.to}`}>
            <td>{c.from}</td><td>{c.to}</td><td>{c.fromCount}</td><td>{c.toCount}</td><td>{formatRate(c.rate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FunnelSection({ funnel, title }: { funnel: UseQueryResult<AdminFunnelSummary, Error>; title: string }) {
  return (
    <section className="workflow-card">
      <h2>{title}</h2>
      <SectionState query={funnel} label="the funnel" />
      {funnel.data && <>
        <ul>{Object.entries(funnel.data.counts).map(([name, count]) => <li key={name}>{name}: {count}</li>)}</ul>
        <FunnelTable funnel={funnel.data} />
      </>}
    </section>
  );
}

function JobsSection({ jobs }: { jobs: UseQueryResult<{ jobs: AdminJob[] }, Error> }) {
  return (
    <section className="workflow-card">
      <h2>Jobs</h2>
      <SectionState query={jobs} label="jobs" />
      {jobs.data && (jobs.data.jobs.length === 0
        ? <p>No jobs recorded yet.</p>
        : <table>
            <thead><tr><th>Trip</th><th>Type</th><th>State</th><th>Attempt</th><th>Error</th><th>Updated</th></tr></thead>
            <tbody>
              {jobs.data.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.tripSlug}</td><td>{job.jobType}</td><td>{job.state}</td><td>{job.attempt}</td>
                  <td>{job.safeErrorCode ?? "—"}</td><td>{job.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>)}
    </section>
  );
}

function FailuresSection({ failures }: { failures: UseQueryResult<{ failures: AdminFailure[] }, Error> }) {
  return (
    <section className="workflow-card">
      <h2>Redacted failures</h2>
      <SectionState query={failures} label="failures" />
      {failures.data && (failures.data.failures.length === 0
        ? <p>No failures recorded.</p>
        : <table>
            <thead><tr><th>Trip</th><th>Type</th><th>Error</th><th>Result</th><th>Updated</th></tr></thead>
            <tbody>
              {failures.data.failures.map((failure) => (
                <tr key={failure.id}>
                  <td>{failure.tripSlug}</td><td>{failure.jobType}</td><td>{failure.safeErrorCode ?? "—"}</td>
                  <td><code>{JSON.stringify(failure.result)}</code></td><td>{failure.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>)}
    </section>
  );
}

function VersionsSection({ versions }: { versions: UseQueryResult<{ releases: AdminRelease[] }, Error> }) {
  return (
    <section className="workflow-card">
      <h2>Versions</h2>
      <SectionState query={versions} label="versions" />
      {versions.data && (versions.data.releases.length === 0
        ? <p>No releases registered.</p>
        : <table>
            <thead><tr><th>Release</th><th>Status</th><th>Source revision</th><th>Promoted by</th></tr></thead>
            <tbody>
              {versions.data.releases.map((release) => (
                <tr key={release.id}>
                  <td>{release.id}</td><td>{release.status}</td><td>{release.sourceRevision}</td>
                  <td>{release.promotedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>)}
    </section>
  );
}

function AuditSection({ audit }: { audit: UseQueryResult<{ events: AdminAuditEvent[] }, Error> }) {
  return (
    <section className="workflow-card">
      <h2>Audit trail</h2>
      <p className="subtle">Every read on this page writes its own row here — this is also a read of that log.</p>
      <SectionState query={audit} label="the audit trail" />
      {audit.data && (audit.data.events.length === 0
        ? <p>No audit events recorded.</p>
        : <table>
            <thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Occurred</th></tr></thead>
            <tbody>
              {audit.data.events.map((event) => (
                <tr key={event.id}>
                  <td>{event.actorRef}</td><td>{event.action}</td><td>{event.targetRef}</td><td>{event.occurredAt}</td>
                </tr>
              ))}
            </tbody>
          </table>)}
    </section>
  );
}
