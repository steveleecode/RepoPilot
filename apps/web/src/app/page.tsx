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
  ClipboardCheck,
  Files,
  Home,
  PanelLeft,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { CommandPalette } from "@/components/command-palette";

const navItems = [
  { label: "Overview", icon: Home, active: true },
  { label: "Repository", icon: Files, active: false },
  { label: "Validation", icon: ShieldCheck, active: false },
  { label: "Audits", icon: ClipboardCheck, active: false }
];

export default function HomePage() {
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
            </div>

            <aside className="space-y-5">
              <ScoreDisplay label="Readiness Score" />
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
