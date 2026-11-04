import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, writeRepositoryConfig } from "@repopilot/policy";
import { runCli } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8"
    });
    if (result.status === 0) {
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== (await realpath(root)))
          await rm(line.slice(9), { recursive: true, force: true });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("development CLI", () => {
  it("persists automatic commit/push delivery through authorization pauses and generates each message once", async () => {
    for (const mode of ["commit", "push"] as const) {
      const fixture = await setup();
      for (const [key, value] of [
        ["user.name", "Test"],
        ["user.email", "test@example.com"]
      ])
        expect(spawnSync("git", ["config", key!, value!], { cwd: fixture.root }).status).toBe(0);
      const generator = vi.fn(() => Promise.resolve({ message: "fix: update greeting" }));
      const runtime = {
        commitMessageCodexTurn: generator,
        fetcher: async () =>
          Response.json({
            choices: [{ message: { content: JSON.stringify(await generator()) } }]
          })
      };
      vi.stubEnv("GROQ_API_KEY", "offline-groq-test-key");
      if (mode === "push")
        expect(
          (await command(fixture.root, "policy", "set", "pushes.enabled", "false")).exitCode
        ).toBe(0);
      const first = await runCli(
        [
          "node",
          "repopilot",
          "run",
          "Change greeting",
          "--provider",
          "codex",
          "--develop",
          "--delivery",
          mode,
          "--message-provider",
          mode === "push" ? "groq" : "codex",
          "--repo",
          fixture.root,
          "--json"
        ],
        fixture.root,
        runtime
      );
      const initial = JSON.parse(first.output) as {
        report: { runId: string };
        delivery: { status: string };
      };
      expect(initial.delivery.status).toBe("waiting");
      expect(generator).not.toHaveBeenCalled();
      let second = await runCli(
        [
          "node",
          "repopilot",
          "resume",
          "--develop",
          "--approve",
          "--execute-checks",
          "--repo",
          fixture.root,
          "--json"
        ],
        fixture.root,
        runtime
      );
      if (mode === "push") {
        expect(JSON.parse(second.output)).toMatchObject({
          report: { status: "committed" },
          delivery: { status: "blocked", stage: "pushing", reason: "policy_denied" }
        });
        expect(
          (await command(fixture.root, "policy", "set", "pushes.enabled", "true")).exitCode
        ).toBe(0);
        second = await runCli(
          [
            "node",
            "repopilot",
            "resume",
            "--develop",
            "--approve",
            "--repo",
            fixture.root,
            "--json"
          ],
          fixture.root,
          runtime
        );
      }
      expect(second.exitCode, second.output).toBe(0);
      expect(JSON.parse(second.output)).toMatchObject({
        delivery: { mode, status: "completed", stage: mode === "push" ? "pushed" : "committed" }
      });
      expect(generator).toHaveBeenCalledTimes(1);
      const remote = path.join(fixture.root, ".git", "test-remote");
      const refs = spawnSync("git", ["--git-dir", remote, "for-each-ref"], {
        encoding: "utf8"
      }).stdout;
      expect(Boolean(refs)).toBe(mode === "push");
      const resumed = await command(fixture.root, "resume", initial.report.runId, "--develop");
      expect(resumed.exitCode, resumed.output).toBe(0);
      expect(JSON.parse(resumed.output)).toMatchObject({ delivery: { status: "completed" } });
      expect(generator).toHaveBeenCalledTimes(1);
      const conflict = await command(
        fixture.root,
        "resume",
        initial.report.runId,
        "--develop",
        "--delivery",
        "review"
      );
      expect(conflict.exitCode).not.toBe(0);
    }
  }, 30_000);

  it("reviews and commits all accumulated paths after a narrow repair", async () => {
    const fixture = await setup(true);
    const outcome = await command(
      fixture.root,
      "run",
      "Change greeting and add a note",
      "--provider",
      "codex",
      "--develop",
      "--approve",
      "--execute-checks"
    );
    expect(outcome.exitCode, outcome.output).toBe(0);
    const { report } = JSON.parse(outcome.output) as {
      report: { runId: string; worktree: string };
    };
    const turns = (await readFile(fixture.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; prompt: string });
    expect(turns.map((turn) => turn.stage)).toEqual([
      "planning",
      "implementation",
      "implementation",
      "review"
    ]);
    const review = turns.find((turn) => turn.stage === "review")!;
    expect(review.prompt).toContain('"path":"src/note.txt","action":"create"');
    expect(review.prompt).toContain('"path":"src/greeting.txt","action":"modify"');
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"]
    ])
      expect(spawnSync("git", ["config", key!, value!], { cwd: fixture.root }).status).toBe(0);
    vi.stubEnv("GROQ_API_KEY", "offline-groq-test-key");
    const fetcher = vi.fn<typeof fetch>((_url, options) => {
      const body = JSON.parse(options?.body as string) as {
        messages: [unknown, { content: string }];
      };
      const context = JSON.parse(body.messages[1].content) as {
        changes: { path: string; action: string }[];
      };
      expect(context.changes).toEqual(
        expect.arrayContaining([
          { path: "src/note.txt", action: "create" },
          { path: "src/greeting.txt", action: "modify" }
        ])
      );
      return Promise.resolve(
        Response.json({
          choices: [
            { message: { content: JSON.stringify({ message: "feat: greeting and note" }) } }
          ]
        })
      );
    });
    const result = await runCli(
      [
        "node",
        "repopilot",
        "commit",
        report.runId,
        "--message-provider",
        "groq",
        "--push",
        "--approve",
        "--repo",
        fixture.root,
        "--json"
      ],
      fixture.root,
      { fetcher }
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ result: { push: { remote: "origin" } } });
    expect(
      spawnSync("git", ["show", "HEAD:src/note.txt"], { cwd: report.worktree, encoding: "utf8" })
        .stdout
    ).toBe("A new note\n");
  }, 20_000);

  it("runs planning, implementation, approved apply, validation, and independent review through real child processes", async () => {
    const fixture = await setup();
    const first = await command(
      fixture.root,
      "run",
      "Change the greeting to goodbye",
      "--provider",
      "codex",
      "--develop"
    );
    expect(first.exitCode).toBe(6);
    const initial = JSON.parse(first.output) as {
      report: { runId: string; status: string; worktree: string | null };
    };
    expect(initial.report.status).toBe("awaiting_approval");
    expect(initial.report.worktree).toBeNull();
    const second = await command(
      fixture.root,
      "resume",
      initial.report.runId,
      "--develop",
      "--approve"
    );
    const paused = JSON.parse(second.output) as { report: { status: string; worktree: string } };
    expect(paused.report.status).toBe("awaiting_validation_authorization");
    const third = await command(fixture.root, "resume", "--develop", "--execute-checks");
    expect(third.exitCode).toBe(0);
    const finished = JSON.parse(third.output) as {
      report: {
        runId: string;
        status: string;
        validation: { status: string };
        review: { status: string };
        acceptanceCriteria: { judgment: string; executableVerification: string }[];
      };
    };
    expect(finished.report.runId).toBe(initial.report.runId);
    expect(finished.report.status).toBe("review_ready");
    expect(finished.report.validation.status).toBe("passed");
    expect(finished.report.review.status).toBe("completed");
    expect(finished.report.acceptanceCriteria[0]).toMatchObject({
      judgment: "supported",
      executableVerification: "not_mapped"
    });
    expect(await readFile(path.join(fixture.root, "src/greeting.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(path.join(paused.report.worktree, "src/greeting.txt"), "utf8")).toBe(
      "goodbye\n"
    );
    const turns = (await readFile(fixture.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; pid: number });
    expect(turns.map((turn) => turn.stage)).toEqual(["planning", "implementation", "review"]);
    expect(new Set(turns.map((turn) => turn.pid)).size).toBe(3);
    const status = await command(fixture.root, "status", initial.report.runId);
    expect(JSON.parse(status.output)).toMatchObject({
      development: { status: "review_ready" },
      reportFreshness: "last_recorded"
    });
    const inspect = await command(fixture.root, "inspect", initial.report.runId);
    expect(JSON.parse(inspect.output)).toMatchObject({
      result: {
        review: { metadata: { type: "independent-review" } },
        completion: { metadata: { type: "task-completion" } }
      }
    });
    const fourth = await command(fixture.root, "resume", initial.report.runId, "--develop");
    expect(fourth.exitCode).toBe(0);
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toHaveLength(3);
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"]
    ]) {
      expect(spawnSync("git", ["config", key!, value!], { cwd: fixture.root }).status).toBe(0);
    }
    const committed = await command(
      fixture.root,
      "commit",
      initial.report.runId,
      "--message",
      "fix: greeting",
      "--approve"
    );
    expect(committed.exitCode).toBe(0);
    expect(
      JSON.parse((await command(fixture.root, "status", initial.report.runId)).output)
    ).toMatchObject({ development: { status: "committed" } });
    const resumedCommit = await command(fixture.root, "resume", initial.report.runId, "--develop");
    expect(resumedCommit.exitCode).toBe(0);
    expect(JSON.parse(resumedCommit.output)).toMatchObject({
      report: { status: "committed", nextCommand: null }
    });
    expect(
      (await command(fixture.root, "commit", initial.report.runId, "--message", "fix: greeting"))
        .exitCode
    ).toBe(0);
    const remote = path.join(fixture.root, ".git", "test-remote");
    expect(
      spawnSync("git", ["--git-dir", remote, "for-each-ref"], { encoding: "utf8" }).stdout
    ).toBe("");
    const pushed = await command(fixture.root, "push", initial.report.runId, "--approve");
    expect(pushed.exitCode, pushed.output).toBe(0);
    expect(
      JSON.parse((await command(fixture.root, "status", initial.report.runId)).output)
    ).toMatchObject({
      development: { status: "committed" },
      publishing: { status: "pushed", freshness: "last_recorded", result: { remote: "origin" } }
    });
    expect((await readFile(fixture.log, "utf8")).trim().split("\n")).toHaveLength(3);
    const none = await command(fixture.root, "resume", "--develop");
    expect(none.exitCode).toBe(2);
    expect(none.output).toContain("No unfinished development task");
    await writeFile(
      path.join(paused.report.worktree, "src/greeting.txt"),
      "changed after commit\n"
    );
    const staleCommit = await command(fixture.root, "resume", initial.report.runId, "--develop");
    expect(JSON.parse(staleCommit.output)).toMatchObject({ report: { status: "needs_attention" } });
  }, 20_000);

  it("rejects unsupported providers and misplaced authorization flags before starting work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "repopilot-task-cli-usage-"));
    roots.push(root);
    for (const args of [
      ["run", "Task", "--provider", "gemini", "--develop"],
      ["run", "Task", "--provider", "fake", "--develop"],
      ["plan", "Task", "--provider", "codex", "--develop"],
      ["run", "Task", "--provider", "codex", "--approve"],
      ["run", "--develop"],
      ["resume", "--execute-checks"]
    ])
      expect((await command(root, ...args)).exitCode).toBe(2);
  });
});

async function command(root: string, ...args: string[]) {
  return runCli(["node", "repopilot", ...args, "--repo", root, "--json"], root);
}

async function setup(repair = false) {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-task-cli-"));
  const tools = await mkdtemp(path.join(tmpdir(), "repopilot-task-codex-"));
  roots.push(root, tools);
  const log = path.join(tools, "turns.jsonl");
  const plan = {
    summary: "Change greeting",
    tasks: [
      {
        id: "greeting",
        objective: "Change greeting to goodbye",
        dependencies: [],
        expectedScopes: ["src"],
        readSet: ["src"],
        writeSet: ["src"],
        validationCommandIds: [],
        completionCriteria: ["Greeting says goodbye"]
      }
    ],
    risks: [],
    questions: []
  };
  const changes = {
    summary: "Change greeting",
    changes: [
      {
        action: "modify",
        path: "src/greeting.txt",
        content: "goodbye\n",
        evidencePaths: ["src/greeting.txt"]
      }
    ]
  };
  const review = {
    summary: "Independent source review supports the criterion",
    findings: [],
    criteria: [
      {
        id: "criterion-1",
        status: "supported",
        evidence: [{ file: "src/greeting.txt", line: 1, description: "The greeting says goodbye." }]
      }
    ]
  };
  const initialChanges = {
    summary: "Greeting and note",
    changes: [
      { ...changes.changes[0], content: "goodbye  \n" },
      { action: "create", path: "src/note.txt", content: "A new note\n", evidencePaths: [] }
    ]
  };
  const binary = path.join(tools, "codex");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thread_" + process.pid;
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") output({id: msg.id, result: {}});
  else if (msg.method === "account/read") output({id: msg.id, result: {account: {type: "test"}}});
  else if (msg.method === "thread/start" || msg.method === "thread/resume") output({id: msg.id, result: {thread: {id: threadId}}});
  else if (msg.method === "turn/start") {
    const props = msg.params.outputSchema.properties;
    const stage = props.tasks ? "planning" : props.findings ? "review" : "implementation";
    const previous = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map(JSON.parse) : [];
    const firstImplementation = !previous.some((turn) => turn.stage === "implementation");
    const result = stage === "planning" ? ${JSON.stringify(plan)} : stage === "review" ? ${JSON.stringify(review)} : ${repair} && firstImplementation ? ${JSON.stringify(initialChanges)} : ${JSON.stringify(changes)};
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({stage, pid: process.pid, prompt: msg.params.input[0].text}) + "\\n");
    output({id: msg.id, result: {turn: {id: "turn"}}});
    output({method: "item/agentMessage/delta", params: {threadId, turnId: "turn", delta: JSON.stringify(result)}});
    output({method: "turn/completed", params: {threadId, turn: {id: "turn", status: "completed"}}});
  }
});
`
  );
  await chmod(binary, 0o755);
  vi.stubEnv("PATH", `${tools}${path.delimiter}${process.env.PATH ?? ""}`);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/greeting.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), ".repopilot/runs/\nnode_modules/\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]
  ]) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8"
    });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const config = defaultConfig("safe");
  config.execution.validation.before_commit = [];
  config.execution.commits.enabled = true;
  config.execution.commits.strategy = "after_feature";
  config.execution.pushes.enabled = true;
  config.execution.pushes.strategy = "after_feature";
  config.execution.validation.before_push = [];
  if (repair) config.execution.failure_handling.retry_limit = 2;
  await writeRepositoryConfig(root, config);
  const remote = path.join(root, ".git", "test-remote");
  expect(spawnSync("git", ["init", "--bare", "-q", remote]).status).toBe(0);
  expect(spawnSync("git", ["remote", "add", "origin", remote], { cwd: root }).status).toBe(0);
  return { root, log };
}
