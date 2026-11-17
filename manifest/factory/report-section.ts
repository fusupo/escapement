/**
 * The validation report's section in a factory PR body (§4.8). The host
 * writes the narrative; the runner owns everything between the markers and
 * replaces only that on later updates.
 */

export const SECTION_BEGIN = "<!-- escapement:factory-report:begin -->";
export const SECTION_END = "<!-- escapement:factory-report:end -->";

/** The parts of a final report (and its revisions) the section shows. */
export type ReportView = {
  run_id: string;
  attempt: number;
  revision?: number;
  outcome: string | null;
  head_sha: string;
  target_ref: string;
  target_sha: string;
  contract_digest: string;
  validation_scope: string;
  tier: { proposed: string; actual: string; reasons: string[] };
  evidence: { id: string; executed: string; supports_criterion: string | null; procedure_adequate?: string | null }[];
  findings: { id: string; severity: string; detail: string; location?: string }[];
  flags: string[];
  manual_outcomes?: { evidence_id: string; outcome: string; note: string; recorder: string }[];
};

export type CriterionView = { id: string; text: string; evidence: { id: string; type: string }[] };

/** One attempt of the run, for the section's history (§6.2: the PR shows every try). */
export type AttemptSummary = {
  attempt: number;
  status: string;
  outcome: string | null;
  failed_phase: string | null;
  error_cause: string | null;
  error_reason: string | null;
  /** Blocking findings the attempt ended with. */
  blocking: number;
};

function attemptWhy(a: AttemptSummary): string {
  if (a.status === "interrupted") return "interrupted (the runner stopped mid-attempt)";
  if (a.outcome === "error") return `${a.error_cause ?? "error"}: ${a.error_reason ?? "no reason recorded"}`;
  if (a.outcome === "fail") {
    const where = a.failed_phase ?? "review";
    return `${where}: ${a.blocking} blocking finding${a.blocking === 1 ? "" : "s"}`;
  }
  return "";
}

const OUTCOME_LABEL: Record<string, string> = {
  pass: "✅ pass",
  pending_manual: "⏳ pending manual checks",
  fail: "❌ fail",
  blocked: "⛔ blocked",
  error: "⚠️ error",
};

/**
 * Text from a report (reviewer findings, criterion text, notes) made safe
 * for one table cell or list line: it can't close or forge a marker, break
 * the table, or run on. `<` and `>` are escaped everywhere, not only in
 * markers: GitHub drops anything that looks like an HTML tag, such as the
 * `<ai@relica.io>` of a commit identity in a manual note (#65).
 */
export function cell(text: string, max = 300): string {
  let t = String(text)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

const short = (sha: string) => sha.slice(0, 10);

export function renderSection(report: ReportView, criteria: CriterionView[], branch: string, history: AttemptSummary[] = []): string {
  const lines: string[] = [SECTION_BEGIN, "## Factory validation report", ""];
  const outcome = report.outcome ?? "none";
  lines.push(`**Outcome:** ${OUTCOME_LABEL[outcome] ?? cell(outcome)}`);
  lines.push("");
  const rev = report.revision && report.revision > 1 ? `, report revision ${report.revision}` : "";
  lines.push(`- **Run:** \`${cell(report.run_id)}\`, attempt ${report.attempt}${rev}`);
  const reasons = report.tier.reasons.length ? `: ${report.tier.reasons.map((r) => cell(r, 160)).join("; ")}` : "";
  lines.push(`- **Risk tier:** ${cell(report.tier.actual)} (proposed ${cell(report.tier.proposed)})${reasons}`);
  lines.push(
    `- **Validated:** \`${cell(branch)}\` at \`${short(report.head_sha)}\` against \`${cell(report.target_ref)}\` at \`${short(report.target_sha)}\` (${report.validation_scope === "branch" ? "the branch, not the merge result" : cell(report.validation_scope)})`,
  );
  lines.push(`- **Contract:** \`${cell(report.contract_digest)}\``);
  lines.push("");

  if (history.length > 1) {
    lines.push("**Attempts**", "", "| Attempt | Outcome | Why |", "|---|---|---|");
    for (const a of history) {
      const outcome = a.status === "interrupted" ? "interrupted" : (a.outcome ?? a.status);
      lines.push(`| ${a.attempt} | ${OUTCOME_LABEL[outcome] ?? cell(outcome)} | ${cell(attemptWhy(a), 200) || "-"} |`);
    }
    lines.push("");
  }

  const results = new Map(report.evidence.map((e) => [e.id, e]));
  lines.push("| Criterion | Evidence | Result | Supports |", "|---|---|---|---|");
  for (const c of criteria) {
    for (const e of c.evidence) {
      const r = results.get(e.id);
      const judged = e.type === "manual" ? r?.procedure_adequate : r?.supports_criterion;
      lines.push(`| ${cell(`${c.id} ${c.text}`, 160)} | \`${cell(e.id)}\` (${cell(e.type)}) | ${cell(r?.executed ?? "missing")} | ${cell(judged ?? "-")} |`);
    }
  }

  const manual = report.evidence.filter((e) => e.executed === "pending_manual");
  const recorded = report.manual_outcomes ?? [];
  if (manual.length || recorded.length) {
    lines.push("", "**Manual checks**", "");
    const done = new Map(recorded.map((m) => [m.evidence_id, m]));
    const ids = [...new Set([...manual.map((e) => e.id), ...recorded.map((m) => m.evidence_id)])];
    for (const id of ids) {
      const m = done.get(id);
      lines.push(m ? `- \`${cell(id)}\`: ${cell(m.outcome)}, ${cell(m.note, 200)} (${cell(m.recorder, 60)})` : `- \`${cell(id)}\`: awaiting a human (\`factory record-manual\`)`);
    }
  }

  for (const severity of ["blocking", "advisory"]) {
    const found = report.findings.filter((f) => f.severity === severity);
    if (!found.length) continue;
    lines.push("", `**${severity === "blocking" ? "Blocking findings" : "Advisory findings"}**`, "");
    for (const f of found.slice(0, 20)) {
      lines.push(`- \`${cell(f.id, 80)}\`${f.location ? ` at \`${cell(f.location, 120)}\`` : ""}: ${cell(f.detail, 240)}`);
    }
    if (found.length > 20) lines.push(`- … and ${found.length - 20} more in the report`);
  }
  if (report.flags.length) {
    lines.push("", `**Flags:** ${report.flags.slice(0, 20).map((f) => `\`${cell(f, 80)}\``).join(", ")}`);
  }
  lines.push(SECTION_END);
  return lines.join("\n");
}

/**
 * Put `section` into `body`: replace the existing section between the
 * markers, or append it after a blank line. Text outside the markers is
 * kept as the host wrote it.
 */
export function withSection(body: string, section: string): string {
  const begin = body.indexOf(SECTION_BEGIN);
  const end = begin === -1 ? -1 : body.indexOf(SECTION_END, begin);
  if (begin !== -1 && end !== -1) {
    return body.slice(0, begin) + section + body.slice(end + SECTION_END.length);
  }
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}
