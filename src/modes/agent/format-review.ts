import type { FetchResult, PullRequestInfo } from '../../shared/types';
import type { AgentInvestigation } from './review-tools';
import type { ValidatedReview } from './findings';

function tableCell(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

export function formatAgentReview(
  pr: PullRequestInfo,
  fetchResult: FetchResult,
  investigation: AgentInvestigation,
  validated: ValidatedReview,
): string {
  const published = validated.comments.length;
  const total = fetchResult.totalFiles;
  const selected = fetchResult.files.length;
  const opened = fetchResult.files.filter((file) =>
    investigation.openedDiffs.includes(file.filename),
  ).length;
  const complete = fetchResult.files.filter((file) =>
    investigation.completedDiffs?.includes(file.filename),
  ).length;
  const partial = selected !== total || fetchResult.truncated || complete !== selected;
  const status =
    published > 0
      ? `ReviewAlly found ${published} actionable ${published === 1 ? 'issue' : 'issues'} in the selected changes.`
      : validated.rejected.length > 0
        ? 'ReviewAlly could not publish the proposed findings; this is not a clean review.'
        : partial
          ? 'No actionable findings in the selected changes; this review is partial.'
          : 'No actionable findings identified in the selected changes.';
  const output = [
    status,
    '',
    '<details>',
    '<summary>Review walkthrough</summary>',
    '',
    '### Changes',
    '',
    '| Changed file | Diff | Summary |',
    '| --- | --- | --- |',
  ];
  const descriptions = new Map(
    investigation.assessment?.fileSummaries?.map((item) => [item.path, item.description]) ?? [],
  );
  for (const file of fetchResult.files) {
    const summary = descriptions.get(file.filename) ?? 'No per-file assessment supplied.';
    output.push(
      `| \`${tableCell(file.filename).replace(/`/g, '\\`')}\` | +${file.additions} / -${file.deletions} | ${tableCell(summary)} |`,
    );
  }
  output.push(
    '',
    '### Review checks',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Scope | ${selected} of ${total} changed files selected${partial ? ' (partial)' : ''} |`,
    `| Patches opened | ${opened} of ${selected} selected files via get_diff; ${complete} paged to end |`,
    `| Findings | ${published} posted; ${validated.rejected.length} rejected after validation |`,
    '| Tests | Not run by ReviewAlly |',
    '',
    '### Assessment',
    '',
    investigation.assessment?.summary.trim() || 'No assessment recorded.',
    '',
    '### Limitations',
    '',
  );
  const limitations = [
    ...(investigation.assessment?.limitations ?? []),
    ...(selected !== total
      ? [`Only ${selected} of ${total} changed files had selected patches.`]
      : []),
    ...(complete !== selected
      ? [`${selected - complete} selected patch(es) were not paged to the end with get_diff.`]
      : []),
    ...(fetchResult.truncatedReason ? [fetchResult.truncatedReason] : []),
    ...(validated.rejected.length > 0
      ? [`${validated.rejected.length} proposed finding(s) failed location or evidence validation.`]
      : []),
    'Static investigation only; ReviewAlly did not execute tests.',
  ];
  for (const limitation of limitations) output.push(`- ${tableCell(limitation)}`);
  output.push(
    '',
    `Reviewed head: \`${pr.headSha}\``,
    '',
    '</details>',
    '',
    '---',
    '_Automated review using ReviewAlly._',
  );
  return output.join('\n');
}
