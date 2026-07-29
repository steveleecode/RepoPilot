import {
  EmptyState,
  FindingCard,
  RepositoryHeader,
  ScoreDisplay,
  StatusBadge,
  ValidationTimeline
} from "@repopilot/ui";
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  Files,
  Home,
  Settings2,
  PanelLeft,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import path from "node:path";
import { CommandPalette } from "@/components/command-palette";
import { loadRepositoryConfig, resolvePolicy } from "@repopilot/policy";

const navItems = [
  { label: "Overview", icon: Home, active: true },
  { label: "Repository", icon: Files, active: false },
  { label: "Validation", icon: ShieldCheck, active: false },
  { label: "Audits", icon: ClipboardCheck, active: false },
  { label: "Agent Policy", icon: Settings2, active: false }
];

export default async function HomePage() {
  const repositoryRoot = path.resolve(process.cwd(), "../..");
  const repositoryConfig = await loadRepositoryConfig(repositoryRoot);
  const resolvedPolicy = resolvePolicy({ repositoryConfig });
  const policy = resolvedPolicy.execution;

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <div className="grid min-h-screen lg:grid-cols-[248px_1fr]">
        <aside className="hidden border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 lg:block">
          <div className="flex h-16 items-center gap-3 px-5">
            <div className="flex size-8 items-center justify-center rounded-md bg-neutral-950 text-white dark:bg-white dark:text-neutral-950">
              <Sparkles className="size-4" aria-hidden="true" />
            </div>
            <span className="text-sm font-semibold">RepoPilot</span>
          </div>
          <nav aria-label="Primary" className="px-3 py-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.label}
                  href="#"
                  aria-current={item.active ? "page" : undefined}
                  className={`mb-1 flex h-9 items-center gap-3 rounded-md px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-950 dark:focus-visible:ring-neutral-100 ${
                    item.active
                      ? "bg-white text-neutral-950 shadow-sm dark:bg-neutral-900 dark:text-neutral-50"
                      : "text-neutral-600 hover:bg-white dark:text-neutral-300 dark:hover:bg-neutral-900"
                  }`}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </a>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0">
          <div className="flex h-16 items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Open navigation"
                className="inline-flex size-9 items-center justify-center rounded-md border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950 lg:hidden"
              >
                <PanelLeft className="size-4" aria-hidden="true" />
              </button>
              <StatusBadge status="planned">foundation milestone</StatusBadge>
            </div>
            <CommandPalette />
          </div>

          <RepositoryHeader name="RepoPilot" path="Local repository analysis has not run yet" />

          <div className="grid gap-5 p-5 xl:grid-cols-[1fr_360px]">
            <div className="space-y-5">
              <section aria-labelledby="summary-title">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2
                    id="summary-title"
                    className="text-sm font-semibold text-neutral-950 dark:text-neutral-50"
                  >
                    Repository Summary
                  </h2>
                  <StatusBadge status="unavailable">waiting for analyzer</StatusBadge>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <FindingCard
                    title="Languages"
                    summary="Unavailable until deterministic repository analysis is connected to the dashboard."
                    status="unavailable"
                  />
                  <FindingCard
                    title="Package Managers"
                    summary="Planned view for lockfiles and manifest-backed package manager evidence."
                    status="planned"
                  />
                  <FindingCard
                    title="Agent Instructions"
                    summary="Planned view for AGENTS.md findings and instruction-linter output."
                    status="planned"
                  />
                </div>
              </section>

              <section
                aria-labelledby="status-title"
                className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="mb-4 flex items-center gap-2">
                  <Activity className="size-4 text-neutral-500" aria-hidden="true" />
                  <h2 id="status-title" className="text-sm font-semibold">
                    Analysis Status
                  </h2>
                </div>
                <ValidationTimeline
                  items={[
                    { label: "Repository scan", status: "planned" },
                    { label: "Evidence normalization", status: "planned" },
                    { label: "Generation proposal", status: "unavailable" },
                    { label: "Validation run", status: "unavailable" }
                  ]}
                />
              </section>

              <section aria-labelledby="audits-title">
                <h2 id="audits-title" className="mb-3 text-sm font-semibold">
                  Recent Audits
                </h2>
                <EmptyState
                  title="No audits yet"
                  description="Audit history will appear here after RepoPilot can analyze a repository from the CLI or dashboard."
                />
              </section>

              <section
                aria-labelledby="policy-title"
                className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 id="policy-title" className="text-sm font-semibold">
                      Agent Policy
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                      These controls reflect the resolved policy from the version-controlled
                      `.repopilot/config.yaml`. Editing from the dashboard is planned; CLI and
                      config file changes are active now.
                    </p>
                  </div>
                  <StatusBadge status={policy.pushes.enabled ? "warning" : "ready"}>
                    {policy.autonomy}
                  </StatusBadge>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <PolicyGroup title="Execution">
                    <Field label="Autonomy preset" value={policy.autonomy} />
                    <Toggle
                      label="Parallel execution"
                      checked={policy.parallelism.enabled}
                      detail={
                        policy.parallelism.enabled
                          ? "Read-only work may run concurrently; writes require isolated scopes."
                          : "All work runs sequentially."
                      }
                    />
                    <Field
                      label="Maximum parallel workers"
                      value={String(policy.parallelism.max_workers)}
                    />
                    <Field label="Isolation strategy" value={policy.parallelism.strategy} />
                  </PolicyGroup>

                  <PolicyGroup title="Git">
                    <Toggle
                      label="Automatic commits"
                      checked={policy.commits.enabled}
                      detail="Commits are authorized only after configured validation succeeds."
                    />
                    <Field label="Commit frequency" value={policy.commits.strategy} />
                    <Field label="Commit style" value={policy.commits.message_format} />
                    <DangerToggle
                      label="Automatic pushes"
                      checked={policy.pushes.enabled}
                      detail="When enabled, RepoPilot may push validated commits only to agent-owned branches."
                    />
                    <Field
                      label="Allowed branch pattern"
                      value={policy.pushes.allowed_branch_patterns.join(", ")}
                    />
                    <DangerToggle
                      label="Draft pull-request creation"
                      checked={policy.pull_requests.enabled}
                      detail="Pull requests are draft-only in this milestone and never merged automatically."
                    />
                  </PolicyGroup>

                  <PolicyGroup title="Validation">
                    <Field
                      label="Before commit"
                      value={policy.validation.before_commit.join(", ")}
                    />
                    <Field label="Before push" value={policy.validation.before_push.join(", ")} />
                    <Field
                      label="Before pull request"
                      value={policy.validation.before_pull_request.join(", ")}
                    />
                    <Toggle
                      label="Stop on failure"
                      checked={policy.validation.stop_on_failure}
                      detail="Failed validation blocks automated Git actions unless a future override is explicit."
                    />
                  </PolicyGroup>

                  <PolicyGroup title="Approval Gates">
                    <Toggle
                      label="Approve before applying files"
                      checked={policy.approvals.before_apply}
                      detail="Generated file writes pause for human review when enabled."
                    />
                    <Toggle
                      label="Approve before commits"
                      checked={policy.approvals.before_commit}
                      detail="Commit creation pauses for human approval when enabled."
                    />
                    <DangerToggle
                      label="Approve before pushes"
                      checked={policy.approvals.before_push}
                      detail="Remote writes pause for human approval when enabled."
                    />
                    <DangerToggle
                      label="Approve before pull requests"
                      checked={policy.approvals.before_pull_request}
                      detail="Pull-request automation pauses for human approval when enabled."
                    />
                    <DangerToggle
                      label="Always approve destructive operations"
                      checked={policy.approvals.before_destructive_action}
                      detail="Destructive actions are never allowed silently."
                    />
                  </PolicyGroup>
                </div>
              </section>
            </div>

            <aside className="space-y-5">
              <ScoreDisplay label="Readiness Score" />
              <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
                <h2 className="text-sm font-semibold">Policy Sources</h2>
                <ul className="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-300">
                  {resolvedPolicy.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
                <h2 className="text-sm font-semibold">Validation Foundation</h2>
                <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                  Validators exist in the package layer. Dashboard execution is planned and
                  intentionally unavailable in this milestone.
                </p>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

function PolicyGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-normal text-neutral-500">
        {title}
      </legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid gap-1">
      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
      <input
        readOnly
        value={value}
        className="h-9 rounded-md border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-700 outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
      />
    </label>
  );
}

function Toggle({ label, checked, detail }: { label: string; checked: boolean; detail: string }) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <span>
        <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-100">
          {label}
        </span>
        <span className="mt-1 block text-sm leading-5 text-neutral-500">{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mt-1 size-4 accent-neutral-950"
      />
    </label>
  );
}

function DangerToggle({
  label,
  checked,
  detail
}: {
  label: string;
  checked: boolean;
  detail: string;
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 rounded-md border p-3 ${
        checked
          ? "border-amber-300 bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/30"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <span>
        <span className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
          <AlertTriangle className="size-4 text-amber-600" aria-hidden="true" />
          {label}
        </span>
        <span className="mt-1 block text-sm leading-5 text-neutral-500">{detail}</span>
      </span>
      <input type="checkbox" checked={checked} readOnly className="mt-1 size-4 accent-amber-600" />
    </label>
  );
}
