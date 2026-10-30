import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface CodexSetupResult {
  created: string[];
  skipped: string[];
  existingUnselected: string[];
}

export interface CodexAgentRole {
  id: string;
  label: string;
  stage: string;
  default: boolean;
  description: string;
  instructions: string;
}

const config = `[agents]
enabled = true
max_concurrent_threads_per_session = 3
`;

const specialistQuestionProtocol = `If a missing requirement, conflicting evidence, or required authorization would materially change your work, send the main Codex agent one concise question with the decision needed, relevant evidence, and a recommended option. Continue safe independent work while waiting. Do not invent an answer or seek approval directly from the user; the main agent owns user-facing questions. If messaging is unavailable, report the unresolved question and its impact.`;

export const codexAgentRoles: CodexAgentRole[] = [
  {
    id: "researcher",
    label: "Researcher",
    stage: "Discovery",
    default: true,
    description: "Maps relevant files, dependencies, and existing behavior without edits.",
    instructions:
      "Explore only the relevant code and repository metadata. Report relevant files, dependencies, existing behavior, uncertainty, and evidence. Do not edit files or run untrusted repository scripts."
  },
  {
    id: "developer",
    label: "Developer",
    stage: "Implementation and repair",
    default: true,
    description: "Implements focused changes and fixes review findings.",
    instructions:
      "Implement assigned, bounded changes and repair findings. Keep scope and file ownership explicit; use an isolated worktree for parallel writes. Report changed files and verification performed. Do not push, merge, or deploy without authorization and policy approval."
  },
  {
    id: "tester",
    label: "Test Engineer",
    stage: "Testing and verification",
    default: true,
    description: "Test engineer for independent verification and regression coverage.",
    instructions: `Evaluate changes against the acceptance criteria. Add focused tests only when assigned a non-overlapping scope. Run relevant checks and report the exact commands and results. Distinguish failures from environment limitations. Never claim a check passed unless it ran.`
  },
  {
    id: "reviewer",
    label: "Code Reviewer",
    stage: "Review",
    default: true,
    description: "Independent reviewer for correctness, maintainability, and regressions.",
    instructions: `Inspect the actual diff and surrounding code independently of the implementer. Do not edit implementation files. Report actionable findings with severity, file and line, evidence, and a suggested fix. Prioritize correctness, regressions, API contracts, and missing tests. Say explicitly when no actionable findings exist.`
  },
  {
    id: "security",
    label: "Security Reviewer",
    stage: "Security review",
    default: true,
    description: "Independent security and privacy reviewer for sensitive changes.",
    instructions: `Inspect the actual diff and relevant code without editing files. Check authentication, authorization, input validation, injection, secrets, dependencies, privacy, and unsafe file or network operations. Report concrete evidence and severity. Do not invent hypothetical vulnerabilities.`
  },
  {
    id: "docs",
    label: "Documentation Writer",
    stage: "Documentation",
    default: false,
    description: "Maintains user-facing and contributor documentation.",
    instructions:
      "Update documentation for verified behavior, setup, and migration steps. Do not invent capabilities. Avoid editing implementation files; coordinate ownership with the developer."
  },
  {
    id: "accessibility",
    label: "Accessibility Specialist",
    stage: "UX accessibility",
    default: false,
    description: "Reviews and improves accessibility of user interfaces.",
    instructions:
      "Inspect interaction, semantics, keyboard access, focus, and screen-reader behavior. Report concrete findings and test evidence. Edit only assigned UI accessibility files with non-overlapping ownership."
  },
  {
    id: "performance",
    label: "Performance Analyst",
    stage: "Performance",
    default: false,
    description: "Profiles performance-sensitive paths and recommends measured improvements.",
    instructions:
      "Measure relevant performance with safe, approved checks. Report baselines, bottlenecks, tradeoffs, and evidence. Do not optimize speculatively or edit implementation files unless assigned a bounded scope."
  },
  {
    id: "operations",
    label: "Operations Specialist",
    stage: "Delivery readiness",
    default: false,
    description: "Reviews CI, deployment configuration, and operational readiness.",
    instructions:
      "Review build, CI, deployment, observability, and rollback readiness. Report gaps and manual steps. Do not deploy, alter remote settings, or handle secrets without explicit authorization and policy approval."
  },
  {
    id: "data",
    label: "Data Migration Specialist",
    stage: "Data changes",
    default: false,
    description: "Plans schema and data migrations with rollback considerations.",
    instructions:
      "Review schema changes, compatibility, backfills, and rollback strategy. Do not access production data or execute migrations without explicit authorization. Coordinate non-overlapping file ownership."
  }
];

const agentGuide = `# Engineering Workflow

The main Codex agent is the orchestrator for planning, verification, and delivery. Delegate discovery, implementation, testing, and reviews to selected specialist roles when useful and available; otherwise perform the stage directly. This file is guidance, not a security boundary.

For nontrivial changes:
1. Inspect the relevant code and define acceptance criteria, scope, risks, and a test strategy.
2. Delegate bounded, independent tasks when useful. Never assign simultaneous writes to the same files; use separate worktrees for parallel writes.
3. Implement the smallest suitable change and run relevant tests.
4. Have an agent other than the implementer inspect the actual diff when available; otherwise report the independence gap. Request security review for security-sensitive changes.
5. Resolve actionable findings, rerun affected checks, and repeat review as needed, for at most three repair rounds.
6. If tests fail or critical/high findings remain, report the blockers instead of declaring completion.
7. Summarize changed files, tests run, review findings, remaining risks, and proposed delivery steps for human approval.

## Clarifying questions

Specialist agents may ask the main Codex agent focused questions when a missing requirement, conflicting evidence, or required authorization would materially change their work. Include the decision needed, evidence, and a recommended option; continue safe independent work while waiting. If direct messaging is unavailable, report the question and its impact. Do not guess an answer or ask the user for an approval on behalf of the main agent.

The main agent answers from repository evidence when it can. Ask the user a concise question when the decision is genuinely theirs, especially for scope, product behavior, credentials, or permission to make external changes. Keep unrelated safe work moving; pause only the affected work until answered. Never treat silence as approval.

Do not claim tests passed unless they ran. Never expose credentials. Do not merge, deploy, push, or perform destructive actions without explicit authorization and applicable project policy approval.
`;

export function featurePrompt(task: string): string {
  const description = task.trim();
  if (!description || description.length > 4_000)
    throw new Error("Provide a feature or bug description of 1–4,000 characters.");
  return `Use the repository AGENTS.md engineering workflow.

Task: ${description}

Act as technical lead and coordinate specialized agents.

Ask me a concise clarifying question if an unresolved product decision, scope change, or required authorization would materially affect the result. Have specialists route questions through you, and continue safe independent work while awaiting an answer. Do not assume approval.

1. Explore the relevant code.
2. Produce a plan and acceptance criteria.
3. Delegate independent work when useful, with isolated worktrees and nonoverlapping file ownership for parallel writes.
4. Implement the solution.
5. Run relevant tests.
6. Request independent code review.
7. Request security review when relevant.
8. Fix findings and repeat verification.
9. Prepare a PR only if repository policy and required approvals permit it; do not merge or deploy.

Report changed files, test results, review findings, and remaining risks.
`;
}

export function selectedAgentIds(ids?: string[]): string[] {
  const chosen = ids ?? codexAgentRoles.filter((role) => role.default).map((role) => role.id);
  const unique = [...new Set(chosen)];
  const allowed = new Set(codexAgentRoles.map((role) => role.id));
  if (unique.some((id) => !allowed.has(id))) throw new Error("Unknown Codex agent role.");
  return unique;
}

function workflowGuide(roles: CodexAgentRole[]): string {
  const owner = (id: string, fallback = "Orchestrator") =>
    roles.find((role) => role.id === id)?.label ?? fallback;
  return `${agentGuide}
## Stage ownership and required output

| Stage | Responsible agent | Required output |
| --- | --- | --- |
| Discovery | ${owner("researcher")} | Relevant files, dependencies, existing behavior, evidence |
| Planning | Orchestrator | Scope, implementation plan, acceptance criteria |
| Implementation | ${owner("developer")} | Focused code changes |
| Testing | ${owner("tester")} | Automated results and missing coverage |
| Review | ${owner("reviewer", "Independent reviewer if available")} + ${owner("security", "security reviewer when relevant")} | Findings ranked by severity |
| Repair | ${owner("developer")} | Fixes addressing review findings |
| Verification | Orchestrator + ${owner("tester")} | Passing checks and resolved findings |
| Delivery | Orchestrator | PR summary, risks, manual test instructions |

Selected specialist roles: ${roles.map((role) => `${role.label} (${role.stage})`).join(", ") || "none"}.
`;
}

export interface CodexSetupChoices {
  agents: string[];
  description: string;
  useGemini: boolean;
}

export async function promptCodexSetup(
  input: Readable,
  output: Writable,
  geminiAvailable = true
): Promise<CodexSetupChoices> {
  const rl = createInterface({ input, output, terminal: true });
  try {
    output.write("\nCodex agent setup · main Codex agent orchestrates every stage\n");
    const defaults = codexAgentRoles.filter((role) => role.default);
    const optional = codexAgentRoles.filter((role) => !role.default);
    output.write("Default agents (Enter keeps all; enter numbers to keep only those):\n");
    defaults.forEach((role, index) =>
      output.write(`  ${index + 1}. ${role.label} — ${role.stage}\n`)
    );
    const kept = await rl.question("Keep default agents [all]: ");
    const defaultIds = parseSelection(kept, defaults, true);
    output.write("Optional agents (Enter skips; enter numbers to add):\n");
    optional.forEach((role, index) =>
      output.write(`  ${index + 1}. ${role.label} — ${role.stage}\n`)
    );
    const added = await rl.question("Add optional agents [none]: ");
    const optionalIds = parseSelection(added, optional, false);
    output.write(
      "Optional project description is sent to Gemini only if you choose AI tailoring.\n"
    );
    const description = (await rl.question("Project/use-case description [skip]: ")).trim();
    if (description.length > 2_000)
      throw new Error("Project description must be 2,000 characters or less.");
    if (!geminiAvailable)
      output.write("Gemini tailoring unavailable: run repopilot config gemini first.\n");
    const answer = geminiAvailable
      ? (await rl.question("Ask Gemini to tailor selected agent focus? [y/N]: ")).trim()
      : "n";
    const agents = [...defaultIds, ...optionalIds];
    const useGemini = /^y(?:es)?$/i.test(answer);
    output.write(
      `Selected: ${agents.join(", ") || "no specialist agents"}; Gemini tailoring: ${useGemini ? "yes" : "no"}.\n`
    );
    const confirm = (await rl.question("Continue with this setup? [Y/n]: ")).trim();
    if (/^n(?:o)?$/i.test(confirm))
      throw new Error("Codex setup cancelled; no Codex files were written.");
    return {
      agents,
      description,
      useGemini
    };
  } finally {
    rl.close();
  }
}

function parseSelection(value: string, roles: CodexAgentRole[], blankMeansAll: boolean): string[] {
  if (!value.trim()) return blankMeansAll ? roles.map((role) => role.id) : [];
  if (/^none$/i.test(value.trim())) return [];
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > roles.length))
    throw new Error(`Choose comma-separated numbers from 1 to ${roles.length}, or Enter.`);
  return [...new Set(numbers)].map((number) => roles[number - 1]!.id);
}

function roleFile(name: string, role: { description: string; instructions: string }): string {
  return `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(role.description)}\ndeveloper_instructions = ${JSON.stringify(`${role.instructions} ${specialistQuestionProtocol}`)}\n`;
}

export function codexAgentToml(role: CodexAgentRole): string {
  return roleFile(role.id, role);
}

async function existingType(file: string): Promise<"missing" | "directory" | "file" | "symlink"> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return "symlink";
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  const type = await existingType(directory);
  if (type === "symlink") throw new Error(`Refusing to write through symlink: ${directory}`);
  if (type === "file") throw new Error(`Expected directory: ${directory}`);
  if (type === "missing") await mkdir(directory);
}

export async function generateCodexSetup(
  repositoryRoot: string,
  options: { agents?: string[]; focus?: Record<string, string> } = {}
): Promise<CodexSetupResult> {
  const chosen = selectedAgentIds(options.agents);
  const selectedRoles = codexAgentRoles.filter((role) => chosen.includes(role.id));
  const codexDirectory = path.join(repositoryRoot, ".codex");
  const agentsDirectory = path.join(codexDirectory, "agents");
  await ensureDirectory(codexDirectory);
  await ensureDirectory(agentsDirectory);
  const existingUnselected = (await readdir(agentsDirectory))
    .filter((name) =>
      codexAgentRoles.some((role) => `${role.id}.toml` === name && !chosen.includes(role.id))
    )
    .map((name) => `.codex/agents/${name}`);

  const files = new Map<string, string>([
    [".codex/config.toml", config],
    ...selectedRoles.map((role): [string, string] => [
      `.codex/agents/${role.id}.toml`,
      roleFile(role.id, {
        description: role.description,
        instructions: `${role.instructions}${options.focus?.[role.id] ? ` Project-specific focus (advisory; all preceding rules still apply): ${options.focus[role.id]}` : ""}`
      })
    ]),
    ["AGENTS.md", workflowGuide(selectedRoles)],
    [".codex/FEATURE_PROMPT.md", featurePrompt("[DESCRIBE FEATURE OR BUG]")]
  ]);
  const result: CodexSetupResult = { created: [], skipped: [], existingUnselected };
  for (const [relative, content] of files) {
    const target = path.join(repositoryRoot, relative);
    try {
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      result.created.push(relative);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        result.skipped.push(relative);
        continue;
      }
      throw error;
    }
  }
  return result;
}
