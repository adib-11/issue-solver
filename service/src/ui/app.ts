// Dashboard. Everything from the API is rendered with textContent only; see scripts/no-html-insertion.sh.
import type { AuthCheckState, SetupView as Setup } from "../harness";
import { type Brief, type CommandRuns, type Conventions, type Decision, type Finding, JOB_STATES, type Job, type JobDetail, type RepoView, UNTRUSTED_AUTHOR } from "../jobs";

type JobPage = { jobs: Job[]; page: number; pageSize: number; total: number };

const POLL_MS = 2000;
const focusRing = "rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

type Child = Node | string | null;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]
) {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

const time = (iso: string) => el("time", { dateTime: iso, textContent: new Date(iso).toLocaleString() });
const badge = (job: Job) =>
  el("span", {
    class: "rounded bg-slate-200 px-2 py-0.5 text-xs font-medium whitespace-nowrap",
    textContent: job.skip_reason ? `${job.state}: ${job.skip_reason}` : job.state,
  });

const pre = (text: string) => el("pre", { class: "overflow-x-auto whitespace-pre-wrap break-words text-sm", textContent: text });
const section = (title: string, ...children: Child[]) =>
  el("section", { class: "rounded border border-slate-200 bg-white p-3" }, el("h3", { class: "mb-2 font-medium break-words", textContent: title }), ...children);

const root = document.getElementById("app")!;
const view = { filter: "", page: 1 };
let lastBody = "";
/** Repos whose form has unsaved edits, so polling does not overwrite them. */
const editing = new Set<number>();

function route() {
  const match = location.hash.match(/^#\/jobs\/(\d+)$/);
  return { jobId: match ? Number(match[1]) : undefined, setup: location.hash === "#/setup", repos: location.hash === "#/repos" };
}

function notice(text: string, isError = false) {
  return el("p", {
    class: isError ? "rounded border border-red-300 bg-red-50 p-3 text-red-800" : "p-3 text-slate-600",
    role: isError ? "alert" : "status",
    textContent: text,
  });
}

function renderList(content: HTMLElement, data: JobPage) {
  const filter = el("select", { id: "state-filter", class: `rounded border border-slate-300 bg-white px-2 py-1 ${focusRing}` });
  for (const value of ["", ...JOB_STATES]) filter.append(el("option", { value, textContent: value || "all", selected: value === view.filter }));
  filter.addEventListener("change", () => {
    view.filter = filter.value;
    view.page = 1;
    refresh();
  });

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageButton = (label: string, page: number) => {
    const button = el("button", {
      id: `page-${label.toLowerCase()}`,
      type: "button",
      class: `rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40 ${focusRing}`,
      textContent: label,
      disabled: page < 1 || page > pages,
    });
    button.addEventListener("click", () => {
      view.page = page;
      refresh();
    });
    return button;
  };

  const list = data.jobs.length
    ? el(
        "ul",
        { class: "divide-y divide-slate-200 rounded border border-slate-200 bg-white" },
        ...data.jobs.map((job) =>
          el(
            "li",
            {},
            el(
              "a",
              { id: `job-${job.id}`, href: `#/jobs/${job.id}`, class: `flex flex-col gap-1 p-3 hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3 ${focusRing}` },
              el("span", { class: "shrink-0 text-sm text-slate-500", textContent: `${job.repo_full_name}#${job.issue_number}` }),
              el("span", { class: "min-w-0 flex-1 break-words", textContent: job.issue_title }),
              el("span", { class: "flex items-center gap-2 text-xs text-slate-500" }, badge(job), time(job.created_at)),
            ),
          ),
        ),
      )
    : notice(view.filter ? `No ${view.filter} jobs.` : "No jobs yet. Open issues appear here after the next scan.");

  content.replaceChildren(
    el(
      "div",
      { class: "mb-3 flex flex-wrap items-center justify-between gap-2" },
      el("label", { class: "flex items-center gap-2", htmlFor: "state-filter" }, "State", filter),
      el("span", { class: "text-sm text-slate-600", textContent: `${data.total} jobs` }),
    ),
    list,
    el(
      "nav",
      { class: "mt-3 flex items-center justify-between gap-2", ariaLabel: "Pages" },
      pageButton("Newer", view.page - 1),
      el("span", { class: "text-sm text-slate-600", textContent: `Page ${data.page} of ${pages}` }),
      pageButton("Older", view.page + 1),
    ),
  );
}

const list = (title: string, items: string[]) =>
  el("div", { class: "mt-2" }, el("h4", { class: "font-medium", textContent: title }), el("ul", { class: "list-disc pl-5" }, ...items.map((text) => el("li", { class: "break-words", textContent: text }))));

function renderBrief(brief: Brief) {
  if (brief.outcome === "needs_info") return list("Questions for the issue author", brief.questions);
  return el("div", {}, pre(brief.brief), list("Acceptance criteria", brief.acceptance_criteria), list("Seams", brief.seams));
}

/** The red/green and checks phases' commands, each with where it ran and its exit code. */
function renderRuns(phase: JobDetail["attempts"][number]["phases"][number]) {
  if (phase.name !== "red/green" && phase.name !== "checks") return [];
  const output = phase.output as CommandRuns | null;
  if (!output) return [];
  if (output.skipped) return [el("p", { class: "my-2 break-words", textContent: `Skipped: ${output.skipped}` })];
  return [list("Commands", output.runs.map((r) => `${r.on === "base" ? "on base, with the new tests" : "on the change"}: ${r.command} → exit ${r.exit_code}`))];
}

/** A review axis's findings and the fix phase's decisions; the phases' order shows the rounds. */
function renderReview(phase: JobDetail["attempts"][number]["phases"][number]) {
  if (phase.name === "review/standards" || phase.name === "review/spec") {
    const output = phase.output as { findings: Finding[] } | null;
    if (!output) return [];
    if (!output.findings.length) return [el("p", { class: "my-2 text-slate-600", textContent: "No findings." })];
    return [list("Findings", output.findings.map((f) => `${f.id} (${f.kind}): ${f.rationale} — ${f.quote}`))];
  }
  if (phase.name === "fix") {
    const output = phase.output as { decisions: Decision[] } | null;
    if (!output) return [];
    return [list("Decisions", output.decisions.map((d) => `${d.id}: ${d.decision} — ${d.reason}`))];
  }
  return [];
}

function renderAttempt(attempt: JobDetail["attempts"][number], number: number, allAttempts: JobDetail["attempts"]) {
  const brief = attempt.phases.find((p) => p.name === "brief" && p.output)?.output as Brief | undefined;
  const sourceNumber =
    attempt.resumed_from === null ? null : (allAttempts.findIndex((a) => a.id === attempt.resumed_from) + 1 || attempt.resumed_from);
  const firstNewPhase = attempt.phases.find((p) => p.outcome !== "reused");
  const resumedPhase = firstNewPhase ? (firstNewPhase.name.startsWith("review/") ? "review" : firstNewPhase.name) : "publish";
  return section(
    `Attempt ${number} (${attempt.harness})`,
    el("p", { class: "text-sm text-slate-600" }, "Started ", time(attempt.started_at), ...(attempt.finished_at ? [", finished ", time(attempt.finished_at)] : [])),
    el("p", { class: "my-2 break-words", textContent: attempt.result ?? "Running…" }),
    ...(sourceNumber === null
      ? []
      : [el("p", { class: "my-2 break-words", textContent: `Resumed from attempt ${sourceNumber} at ${resumedPhase}` })]),
    ...[
      ["Pull request", attempt.pr_url],
      ["Branch", attempt.branch_url],
    ].map(([label, href]) =>
      href ? el("p", { class: "my-1 break-words" }, `${label}: `, el("a", { href, rel: "noreferrer", class: `text-blue-700 underline ${focusRing}`, textContent: href })) : null,
    ),
    brief ? el("div", { class: "border-t border-slate-200 py-2" }, renderBrief(brief)) : null,
    ...attempt.commits.map((commit) =>
      el(
        "div",
        { class: "border-t border-slate-200 py-2" },
        el("h4", { class: "font-medium break-words" }, el("code", { textContent: commit.sha.slice(0, 7) }), ` ${commit.message.split("\n")[0]}`),
        pre(commit.stat),
      ),
    ),
    ...attempt.phases.map((phase) =>
      el(
        "details",
        { class: "border-t border-slate-200 py-2" },
        el("summary", { class: `cursor-pointer ${focusRing}`, textContent: `${phase.name}: ${phase.outcome ?? "running"}` }),
        ...renderRuns(phase),
        ...renderReview(phase),
        pre(phase.log || "(no output)"),
      ),
    ),
  );
}

/** A job action button with its hint; stays disabled once the action succeeds, until the job re-renders. */
/** action is both the button's id and the job's API route segment. */
function jobAction(job: JobDetail, action: string, label: string, hint: string) {
  const control = button(action, label);
  const status = el("span", { role: "status", class: "text-sm text-red-800" });
  control.addEventListener("click", async () => {
    control.disabled = true;
    const res = await fetch(`/api/jobs/${job.id}/${action}`, { method: "POST" }).catch(() => null);
    if (!res?.ok) {
      control.disabled = false;
      status.textContent = `${label} failed (${res ? res.status : "network error"}).`;
    }
    refresh();
  });
  return el("div", { class: "mt-3 flex flex-wrap items-center gap-2" }, el("span", { class: "text-sm text-slate-600", textContent: hint }), control, status);
}

function jobPrimaryAction(job: JobDetail): HTMLElement | null {
  if (job.state === "skipped" && job.skip_reason === UNTRUSTED_AUTHOR) {
    return jobAction(job, "run-anyway", "Run anyway", "Read the issue first: its author is not you or a collaborator.");
  }
  if (job.state === "needs_info") {
    return jobAction(job, "retry", "Retry", "Answer the questions by editing the issue, then retry: the brief starts over from the edited issue.");
  }
  if (job.state === "failed") {
    return jobAction(job, "retry", "Retry", `Retry resumes at the ${job.resume_phase ?? "failed"} phase with the saved commits.`);
  }
  return null;
}

function renderJob(content: HTMLElement, job: JobDetail) {
  const action = jobPrimaryAction(job);
  const row = (label: string, value: Child) =>
    el("div", { class: "grid gap-1 py-2 sm:grid-cols-[10rem_1fr]" }, el("dt", { class: "text-slate-500", textContent: label }), el("dd", { class: "break-words" }, value));
  content.replaceChildren(
    el("a", { href: "#/", class: `mb-3 inline-block text-blue-700 underline ${focusRing}`, textContent: "← All jobs" }),
    el("h2", { class: "mb-2 text-lg font-semibold break-words", textContent: job.issue_title }),
    el(
      "dl",
      { class: "divide-y divide-slate-200 rounded border border-slate-200 bg-white px-3" },
      row("State", badge(job)),
      ...(job.phase ? [row("Phase", job.phase)] : []),
      row("Issue", el("a", { href: job.issue_url, rel: "noreferrer", class: `text-blue-700 underline ${focusRing}`, textContent: `${job.repo_full_name}#${job.issue_number}` })),
      row("Created", time(job.created_at)),
      row("Updated", time(job.updated_at)),
    ),
    ...(action ? [action] : []),
    el("div", { class: "mt-3 flex flex-col gap-3" }, ...[...job.attempts].reverse().map((a, i) => renderAttempt(a, job.attempts.length - i, job.attempts))),
  );
}

const button = (id: string, textContent: string) =>
  el("button", { id, type: "button", class: `rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40 ${focusRing}`, textContent });

/** POSTs or PUTs, keeping the button disabled while pending and reporting failure in status. */
async function act(control: HTMLButtonElement | HTMLInputElement, status: HTMLElement, url: string, init: RequestInit, label: string) {
  control.disabled = true;
  status.textContent = `${label}…`;
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init }).catch(() => null);
  control.disabled = false;
  status.textContent = res?.ok ? "" : `${label} failed (${res ? res.status : "network error"}).`;
  await refresh(); // re-renders only when the response changed the setup
}

const AUTH_LABELS: Record<AuthCheckState, string> = { ok: "auth ok", auth: "login needed", quota: "quota exhausted", error: "auth check failed" };

function renderHeader(setup: Setup) {
  const harness = setup.harnesses.find((h) => h.name === setup.harness);
  const auth = !harness ? "not set up" : setup.auth ? AUTH_LABELS[setup.auth.state] : "auth not tested";
  const warn = !harness || setup.auth?.state !== "ok" || setup.paused;
  header.replaceChildren(
    el("span", {}, "Harness: ", el("strong", { textContent: harness ? `${harness.label}, ${auth}` : auth })),
    el("span", {}, "Queue: ", el("strong", { textContent: setup.paused ? `paused. ${setup.paused}` : "running" })),
    el("a", { id: "repos-link", href: "#/repos", class: `text-blue-700 underline ${focusRing}`, textContent: "Repos" }),
    el("a", { id: "setup-link", href: "#/setup", class: `text-blue-700 underline ${focusRing}`, textContent: "Setup" }),
  );
  header.className = `mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border p-2 text-sm ${warn ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`;
}

const DAY_MS = 86_400_000;
function renderSetup(content: HTMLElement, setup: Setup) {
  const status = el("p", { role: "status", class: "text-sm text-red-800" });
  const choices = el("fieldset", { class: "flex flex-wrap gap-4" }, el("legend", { class: "sr-only", textContent: "Harness" }));
  for (const h of setup.harnesses) {
    const radio = el("input", { id: `harness-${h.name}`, type: "radio", name: "harness", value: h.name, checked: h.name === setup.harness, class: focusRing });
    radio.addEventListener("change", () => act(radio, status, "/api/setup", { method: "PUT", body: JSON.stringify({ harness: h.name }) }, "Saving the harness"));
    choices.append(el("label", { class: "flex items-center gap-2", htmlFor: radio.id }, radio, h.label));
  }
  const harness = setup.harnesses.find((h) => h.name === setup.harness);
  const parts: HTMLElement[] = [el("h2", { class: "text-lg font-semibold", textContent: "Setup" })];
  if (setup.paused) parts.push(section("Queue paused", el("p", { class: "text-red-800", textContent: setup.paused })));
  parts.push(section("Choose the harness", choices));
  if (harness) {
    parts.push(section(`Log in to ${harness.label}`, pre(harness.loginHelp)));
    if (setup.credentialSince) {
      const days = Math.floor((Date.now() - Date.parse(setup.credentialSince)) / DAY_MS);
      parts.push(section("Token age", el("p", {}, `In use since `, time(setup.credentialSince), ` (${days} days).`)));
    }
    const test = button("test-auth", "Test auth");
    test.addEventListener("click", () => act(test, status, "/api/setup/test-auth", { method: "POST" }, "Test auth"));
    parts.push(
      section(
        "Test auth",
        el("div", { class: "flex flex-wrap items-center gap-2" }, test, status),
        ...(setup.auth ? [el("p", { class: "mt-2" }, `Last result: ${AUTH_LABELS[setup.auth.state]}, `, time(setup.auth.checkedAt)), pre(setup.auth.log)] : []),
      ),
    );
  } else parts.push(status);
  content.replaceChildren(el("div", { class: "flex flex-col gap-3" }, ...parts));
}

const input = "w-full rounded border border-slate-300 px-2 py-1";
function renderRepos(content: HTMLElement, repos: RepoView[]) {
  const parts: HTMLElement[] = [el("h2", { class: "text-lg font-semibold", textContent: "Repos" })];
  if (!repos.length) parts.push(notice("No repos yet. Repos the GitHub App can see appear here after the next scan."));
  for (const repo of repos) {
    const id = (field: string) => `repo-${repo.id}-${field}`;
    const shown: Conventions = repo.override ??
      repo.discovered ?? { setup_command: "", check_commands: [], test_file_command: "", has_tests: false, commit_style: "", notes: "" };
    const field = (name: string, label: string, control: HTMLInputElement | HTMLTextAreaElement) => {
      control.id = id(name);
      control.className = `${input} ${focusRing}`;
      control.addEventListener("input", () => editing.add(repo.id));
      return el("label", { class: "flex flex-col gap-1", htmlFor: control.id }, label, control);
    };
    const setupCommand = el("input", { type: "text", value: shown.setup_command });
    const checks = el("textarea", { rows: 3, value: shown.check_commands.join("\n") });
    const testFile = el("input", { type: "text", value: shown.test_file_command });
    const commitStyle = el("input", { type: "text", value: shown.commit_style });
    const notes = el("textarea", { rows: 3, value: shown.notes });
    const hasTests = el("input", { id: id("has-tests"), type: "checkbox", checked: shown.has_tests, class: focusRing });
    hasTests.addEventListener("change", () => editing.add(repo.id));

    const status = el("span", { role: "status", class: "text-sm text-red-800" });
    const save = button(id("save"), "Save override");
    const clear = button(id("clear"), "Clear override");
    clear.disabled = !repo.override;
    const url = `/api/repos/${repo.id}/override`;
    save.addEventListener("click", () => {
      const conventions: Conventions = {
        setup_command: setupCommand.value.trim(),
        check_commands: checks.value.split("\n").map((c) => c.trim()).filter(Boolean),
        test_file_command: testFile.value.trim(),
        has_tests: hasTests.checked,
        commit_style: commitStyle.value.trim(),
        notes: notes.value.trim(),
      };
      editing.delete(repo.id);
      act(save, status, url, { method: "PUT", body: JSON.stringify(conventions) }, "Saving the override");
    });
    clear.addEventListener("click", () => {
      editing.delete(repo.id);
      act(clear, status, url, { method: "PUT", body: "null" }, "Clearing the override");
    });

    const source = repo.override
      ? "Using your override."
      : repo.discovered_at
        ? el("span", {}, "Using conventions discovered ", time(repo.discovered_at), ".")
        : "Not discovered yet: the first job on this repo discovers them.";
    parts.push(
      section(
        repo.full_name,
        el("p", { class: "mb-2 text-sm text-slate-600" }, source),
        el(
          "div",
          { class: "flex flex-col gap-2" },
          field("setup", "Setup command", setupCommand),
          field("checks", "Check commands, one per line (none means jobs are skipped)", checks),
          field("test-file", "Single test file command ({file} is the path)", testFile),
          el("label", { class: "flex items-center gap-2", htmlFor: hasTests.id }, hasTests, "Has tests"),
          field("commit-style", "Commit style", commitStyle),
          field("notes", "Notes", notes),
          el("div", { class: "flex flex-wrap items-center gap-2" }, save, clear, status),
        ),
      ),
    );
  }
  content.replaceChildren(el("div", { class: "flex flex-col gap-3" }, ...parts));
}

const header = el("div", { id: "status", role: "status" });
const content = el("div", { id: "content" });
root.replaceChildren(el("h1", { class: "mb-2 text-xl font-bold" }, el("a", { href: "#/", class: focusRing, textContent: "auto-solve" })), header, content);

let latest = 0;
let lastHeader = "";
async function refreshHeader() {
  const res = await fetch("/api/setup").catch(() => null);
  const body = res?.ok ? await res.text() : "";
  if (!body || body === lastHeader) return;
  lastHeader = body;
  renderHeader(JSON.parse(body));
}

async function refresh(showLoading = false) {
  const request = ++latest;
  const { jobId, setup, repos } = route();
  if (!setup) refreshHeader(); // the setup page's own response renders the header
  if (repos && editing.size) return; // keep unsaved edits
  if (showLoading) {
    lastBody = "";
    content.replaceChildren(notice("Loading…"));
  }
  const query = new URLSearchParams({ page: String(view.page) });
  if (view.filter) query.set("state", view.filter);
  const url = setup ? "/api/setup" : repos ? "/api/repos" : jobId === undefined ? `/api/jobs?${query}` : `/api/jobs/${jobId}`;
  try {
    const res = await fetch(url);
    const body = await res.text();
    if (request !== latest) return; // a newer request (route, filter, or page change) owns the view
    if (!res.ok) throw new Error(res.status === 404 ? "Job not found." : `Request failed (${res.status}).`);
    if (setup && body !== lastHeader) {
      lastHeader = body;
      renderHeader(JSON.parse(body));
    }
    if (body === lastBody) return; // unchanged: keep the DOM, and keyboard focus with it
    lastBody = body;
    const focusedId = document.activeElement?.id;
    if (setup) renderSetup(content, JSON.parse(body));
    else if (repos) renderRepos(content, JSON.parse(body));
    else if (jobId === undefined) renderList(content, JSON.parse(body));
    else renderJob(content, JSON.parse(body));
    if (focusedId) document.getElementById(focusedId)?.focus(); // keep keyboard focus across re-renders
  } catch (err) {
    if (request !== latest) return;
    lastBody = "";
    content.replaceChildren(notice(`Could not load: ${(err as Error).message} Retrying…`, true));
  }
}

window.addEventListener("hashchange", () => {
  editing.clear();
  refresh(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, POLL_MS);
refresh(true);
