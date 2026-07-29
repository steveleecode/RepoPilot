import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, FileSearch, GitBranch, Loader2 } from "lucide-react";
import { clsx } from "clsx";

export function StatusBadge({
  status,
  children
}: {
  status: "ready" | "planned" | "unavailable" | "warning";
  children: ReactNode;
}) {
  const tone = {
    ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    planned: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    unavailable: "border-neutral-500/30 bg-neutral-500/10 text-neutral-600 dark:text-neutral-300",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }[status];

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium",
        tone
      )}
    >
      {children}
    </span>
  );
}

export function ScoreDisplay({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex min-h-32 flex-col justify-between rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
        <StatusBadge status="planned">planned</StatusBadge>
      </div>
      <div className="mt-8 flex items-end gap-2">
        <span className="text-5xl font-semibold tracking-normal text-neutral-950 dark:text-neutral-50">
          {typeof value === "number" ? value : "--"}
        </span>
        <span className="pb-2 text-sm text-neutral-500">/100</span>
      </div>
    </div>
  );
}

export function FindingCard({
  title,
  summary,
  status
}: {
  title: string;
  summary: string;
  status: "ready" | "planned" | "unavailable" | "warning";
}) {
  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">{summary}</p>
        </div>
        <StatusBadge status={status}>{status}</StatusBadge>
      </div>
    </article>
  );
}

export function RepositoryHeader({ name, path }: { name: string; path: string }) {
  return (
    <header className="flex flex-col gap-4 border-b border-neutral-200 px-5 py-5 dark:border-neutral-800 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <GitBranch className="size-4" aria-hidden="true" />
          <span>Local workspace</span>
        </div>
        <h1 className="mt-2 truncate text-2xl font-semibold text-neutral-950 dark:text-neutral-50">
          {name}
        </h1>
        <p className="mt-1 truncate text-sm text-neutral-500">{path}</p>
      </div>
      <StatusBadge status="unavailable">analysis unavailable</StatusBadge>
    </header>
  );
}

export function ValidationTimeline({
  items
}: {
  items: Array<{ label: string; status: "ready" | "planned" | "unavailable" }>;
}) {
  const icons = {
    ready: CheckCircle2,
    planned: Clock3,
    unavailable: AlertCircle
  };
  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const Icon = icons[item.status];
        return (
          <li key={item.label} className="flex items-center gap-3 text-sm">
            <Icon className="size-4 text-neutral-500" aria-hidden="true" />
            <span className="flex-1 text-neutral-700 dark:text-neutral-200">{item.label}</span>
            <StatusBadge status={item.status}>{item.status}</StatusBadge>
          </li>
        );
      })}
    </ol>
  );
}

export function EmptyState({
  title,
  description,
  icon = "search"
}: {
  title: string;
  description: string;
  icon?: "search" | "loading";
}) {
  const Icon = icon === "loading" ? Loader2 : FileSearch;
  return (
    <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
      <Icon className="size-6 text-neutral-400" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-semibold text-neutral-950 dark:text-neutral-50">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">{description}</p>
    </div>
  );
}

export function IconButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      className={clsx(
        "inline-flex size-9 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-sm outline-none transition hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-950 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:focus-visible:ring-neutral-100",
        className
      )}
      {...props}
    />
  );
}
