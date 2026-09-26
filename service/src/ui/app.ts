// Dashboard. Everything from the API is rendered with textContent only; see scripts/no-html-insertion.sh.
import { JOB_STATES, type Job } from "../jobs";

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
const badge = (state: string) =>
  el("span", { class: "rounded bg-slate-200 px-2 py-0.5 text-xs font-medium whitespace-nowrap", textContent: state });

const root = document.getElementById("app")!;
const view = { filter: "", page: 1 };
let lastBody = "";

function route() {
  const match = location.hash.match(/^#\/jobs\/(\d+)$/);
  return match ? { jobId: Number(match[1]) } : { jobId: undefined };
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
              el("span", { class: "flex items-center gap-2 text-xs text-slate-500" }, badge(job.state), time(job.created_at)),
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

function renderJob(content: HTMLElement, job: Job) {
  const row = (label: string, value: Child) =>
    el("div", { class: "grid gap-1 py-2 sm:grid-cols-[10rem_1fr]" }, el("dt", { class: "text-slate-500", textContent: label }), el("dd", { class: "break-words" }, value));
  content.replaceChildren(
    el("a", { href: "#/", class: `mb-3 inline-block text-blue-700 underline ${focusRing}`, textContent: "← All jobs" }),
    el("h2", { class: "mb-2 text-lg font-semibold break-words", textContent: job.issue_title }),
    el(
      "dl",
      { class: "divide-y divide-slate-200 rounded border border-slate-200 bg-white px-3" },
      row("State", badge(job.state)),
      row("Issue", el("a", { href: job.issue_url, rel: "noreferrer", class: `text-blue-700 underline ${focusRing}`, textContent: `${job.repo_full_name}#${job.issue_number}` })),
      row("Created", time(job.created_at)),
      row("Updated", time(job.updated_at)),
    ),
  );
}

const content = el("div", { id: "content" });
root.replaceChildren(el("h1", { class: "mb-4 text-xl font-bold" }, el("a", { href: "#/", class: focusRing, textContent: "auto-solve" })), content);

let latest = 0;
async function refresh(showLoading = false) {
  const request = ++latest;
  const { jobId } = route();
  if (showLoading) {
    lastBody = "";
    content.replaceChildren(notice("Loading…"));
  }
  const query = new URLSearchParams({ page: String(view.page) });
  if (view.filter) query.set("state", view.filter);
  const url = jobId === undefined ? `/api/jobs?${query}` : `/api/jobs/${jobId}`;
  try {
    const res = await fetch(url);
    const body = await res.text();
    if (request !== latest) return; // a newer request (route, filter, or page change) owns the view
    if (!res.ok) throw new Error(res.status === 404 ? "Job not found." : `Request failed (${res.status}).`);
    if (body === lastBody) return; // unchanged: keep the DOM, and keyboard focus with it
    lastBody = body;
    const focusedId = document.activeElement?.id;
    if (jobId === undefined) renderList(content, JSON.parse(body));
    else renderJob(content, JSON.parse(body));
    if (focusedId) document.getElementById(focusedId)?.focus(); // keep keyboard focus across re-renders
  } catch (err) {
    if (request !== latest) return;
    lastBody = "";
    content.replaceChildren(notice(`Could not load: ${(err as Error).message} Retrying…`, true));
  }
}

window.addEventListener("hashchange", () => refresh(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, POLL_MS);
refresh(true);
