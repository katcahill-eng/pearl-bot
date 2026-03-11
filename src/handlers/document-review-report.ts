import type { QCResult } from '../lib/qc-runner';

/**
 * Build the full report card text for posting as a threaded Slack message.
 * Extracted to a separate module to avoid circular dependencies between
 * document-review.ts and approval.ts.
 */
export function buildFullReportCardText(result: QCResult): string {
  const lines: string[] = [
    ':clipboard: *Full QC Report Card*',
    '',
  ];

  // Critical issues
  if (result.criticalIssues.length > 0) {
    lines.push(':red_circle: *Critical Issues (must fix):*');
    for (let i = 0; i < result.criticalIssues.length; i++) {
      const issue = result.criticalIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Important issues
  if (result.importantIssues.length > 0) {
    lines.push(':warning: *Important Issues (should fix):*');
    for (let i = 0; i < result.importantIssues.length; i++) {
      const issue = result.importantIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Minor issues
  if (result.minorIssues.length > 0) {
    lines.push(':large_blue_circle: *Minor Issues (nice to fix):*');
    for (let i = 0; i < result.minorIssues.length; i++) {
      const issue = result.minorIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Positioning stress test
  if (result.positioningStressTest) {
    lines.push('*Positioning Stress Test:*');
    lines.push(result.positioningStressTest);
    lines.push('');
  }

  // Bunny detection
  if (result.bunnyDetection) {
    lines.push('*Bunny Detection Test:*');
    lines.push(result.bunnyDetection);
    lines.push('');
  }

  // Brand essence tone check
  if (result.brandEssenceToneCheck) {
    lines.push('*Brand Essence / Tone Check:*');
    lines.push(result.brandEssenceToneCheck);
    lines.push('');
  }

  // Data provenance audit
  if (result.dataProvenanceAudit) {
    lines.push('*Data Provenance Audit:*');
    lines.push(result.dataProvenanceAudit);
    lines.push('');
  }

  // Overall assessment
  if (result.overallAssessment) {
    lines.push('*Overall Positioning Assessment:*');
    lines.push(result.overallAssessment);
  }

  // Truncate if too long for Slack (max ~40000 chars per message)
  const fullText = lines.join('\n');
  if (fullText.length > 39000) {
    return fullText.slice(0, 39000) + '\n\n_... report truncated due to length. See Excel file for full details._';
  }

  return fullText;
}
