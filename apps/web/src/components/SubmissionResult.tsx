import type { LanguageVariant, Submission } from "@bekor/contracts";
import { formatDateTime, formatJson, submissionLabel, submissionTone } from "../format";
import { isTerminal, POLL_LIMIT_MS } from "../queries";
import { Badge, Spinner } from "./ui";

interface Props {
  submission: Submission;
  /** Public tests of the matching variant, used to show inputs for public cases. */
  variant?: LanguageVariant | undefined;
  /** Current editor buffer; when it differs from the judged source the user is told. */
  currentSource?: string | undefined;
  onLoadSource?: ((source: string) => void) | undefined;
  onRefresh?: (() => void) | undefined;
}

export function judgedSource(submission: Submission): string | undefined {
  return submission.files ? Object.values(submission.files)[0] : undefined;
}

export function SubmissionResult({
  submission,
  variant,
  currentSource,
  onLoadSource,
  onRefresh,
}: Props) {
  const terminal = isTerminal(submission);
  const stale = !terminal && Date.now() - Date.parse(submission.createdAt) > POLL_LIMIT_MS;
  const source = judgedSource(submission);
  const edited = source !== undefined && currentSource !== undefined && source !== currentSource;
  const modeLabel = submission.mode === "run" ? "Run (public tests)" : "Submit (all tests)";

  return (
    <section className="result" aria-live="polite" aria-busy={!terminal}>
      <header className="result-header">
        <div>
          <Badge tone={submissionTone(submission)}>{submissionLabel(submission)}</Badge>{" "}
          <span className="muted">
            {modeLabel} · {formatDateTime(submission.createdAt)}
          </span>
        </div>
        {submission.status === "completed" && (
          <strong>
            {submission.passedCount}/{submission.totalCount} tests passed
          </strong>
        )}
      </header>

      {!terminal && !stale && (
        <p className="muted">
          <Spinner label="Judging" />{" "}
          {submission.status === "queued" ? "Waiting for a judge…" : "Running your code…"}
        </p>
      )}
      {stale && (
        <div className="notice">
          <p>
            Still judging after several minutes. The result will appear in your history when it
            finishes.
          </p>
          {onRefresh && (
            <button type="button" onClick={onRefresh}>
              Check again
            </button>
          )}
        </div>
      )}
      {submission.status === "infrastructure_error" && (
        <div className="notice notice-warn">
          <p>
            The judging service failed. This is a server problem, not a problem with your code, and
            it does not count against you. Try again in a moment.
          </p>
        </div>
      )}

      {edited && (
        <div className="notice">
          <p>You have edited the code since this was judged; the result is for the earlier code.</p>
          {onLoadSource && source !== undefined && (
            <button type="button" onClick={() => onLoadSource(source)}>
              Load judged code into editor
            </button>
          )}
        </div>
      )}

      {submission.diagnostic && <pre className="diagnostic">{submission.diagnostic}</pre>}

      {submission.publicResults.length > 0 && (
        <ol className="cases">
          {submission.publicResults.map((result) => {
            const test = variant?.publicTests[result.caseIndex];
            return (
              <li key={result.caseIndex} className={result.passed ? "case-pass" : "case-fail"}>
                <div className="case-title">
                  <span aria-hidden="true">{result.passed ? "✓" : "✗"}</span> Example{" "}
                  {result.caseIndex + 1}: {result.passed ? "passed" : "failed"}
                </div>
                {!result.passed && (
                  <dl className="case-details">
                    {test && (
                      <>
                        <dt>Input</dt>
                        <dd>
                          <code>{test.args.map(formatJson).join(", ")}</code>
                        </dd>
                        <dt>Expected</dt>
                        <dd>
                          <code>{formatJson(test.expected)}</code>
                        </dd>
                      </>
                    )}
                    {result.actual !== undefined && (
                      <>
                        <dt>Actual</dt>
                        <dd>
                          <code>{formatJson(result.actual)}</code>
                        </dd>
                      </>
                    )}
                    {result.diagnostic && (
                      <>
                        <dt>Output</dt>
                        <dd>
                          <pre>{result.diagnostic}</pre>
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {submission.mode === "submit" &&
        submission.status === "completed" &&
        submission.totalCount > submission.publicResults.length && (
          <p className="muted">
            {submission.totalCount - submission.publicResults.length} additional server tests are
            reported only as part of the total.
          </p>
        )}
    </section>
  );
}
