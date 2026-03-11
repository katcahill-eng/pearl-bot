import ExcelJS from 'exceljs';
import type { QCResult, QCIssue } from './qc-runner';

// --- Styles ---

const RED_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFCE4EC' }, // Light red
};

const YELLOW_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF8E1' }, // Light yellow
};

const BLUE_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE3F2FD' }, // Light blue
};

const GREEN_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8F5E9' }, // Light green
};

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1565C0' }, // Pearl blue
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
  size: 11,
};

const BODY_FONT: Partial<ExcelJS.Font> = {
  size: 10,
};

// --- Helpers ---

function getSeverityFill(severity: string): ExcelJS.Fill {
  switch (severity) {
    case 'Critical':
      return RED_FILL;
    case 'Important':
      return YELLOW_FILL;
    case 'Minor':
      return BLUE_FILL;
    default:
      return GREEN_FILL;
  }
}

function addIssueRows(
  sheet: ExcelJS.Worksheet,
  issues: QCIssue[],
  severity: string,
  startRow: number,
): number {
  let row = startRow;
  for (const issue of issues) {
    const excelRow = sheet.addRow([
      row - startRow + 1,
      severity,
      issue.category,
      issue.originalText,
      issue.category,
      issue.issue,
      issue.suggestedFix,
      issue.confidence,
      'Open',
    ]);
    const fill = getSeverityFill(severity);
    excelRow.eachCell((cell) => {
      cell.fill = fill;
      cell.font = BODY_FONT;
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      };
    });
    row++;
  }
  return row;
}

// --- Public API ---

/**
 * Generate an Excel workbook with QC results.
 * Returns a Buffer suitable for uploading to Slack or Google Drive.
 */
export async function generateQCExcel(
  result: QCResult,
  documentTitle: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pearl MarcomsBot';
  workbook.created = new Date();

  // --- QC Issues sheet ---
  const issuesSheet = workbook.addWorksheet('QC Issues');

  // Columns
  issuesSheet.columns = [
    { header: 'Row #', key: 'rowNum', width: 8 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Section', key: 'section', width: 18 },
    { header: 'Original Copy', key: 'originalCopy', width: 40 },
    { header: 'Issue Category', key: 'issueCategory', width: 20 },
    { header: 'Issue Description', key: 'issueDesc', width: 40 },
    { header: 'Suggested Copy', key: 'suggestedCopy', width: 40 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  // Style header row
  const headerRow = issuesSheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FF0D47A1' } },
    };
  });
  headerRow.height = 24;

  // Freeze header row
  issuesSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const totalIssues =
    result.criticalIssues.length +
    result.importantIssues.length +
    result.minorIssues.length;

  if (totalIssues === 0) {
    // No issues — show a green "No issues found" row
    const noIssueRow = issuesSheet.addRow([
      1,
      'None',
      'N/A',
      'No issues found',
      'N/A',
      'Document passes QC review',
      'N/A',
      'HIGH',
      'Complete',
    ]);
    noIssueRow.eachCell((cell) => {
      cell.fill = GREEN_FILL;
      cell.font = { ...BODY_FONT, italic: true };
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
  } else {
    let currentRow = 2; // Row 1 is header
    currentRow = addIssueRows(issuesSheet, result.criticalIssues, 'Critical', currentRow);
    currentRow = addIssueRows(issuesSheet, result.importantIssues, 'Important', currentRow);
    addIssueRows(issuesSheet, result.minorIssues, 'Minor', currentRow);
  }

  // Auto-filter
  issuesSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(2, totalIssues + 1), column: 9 },
  };

  // --- Summary sheet ---
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Field', key: 'field', width: 30 },
    { header: 'Value', key: 'value', width: 80 },
  ];

  // Style header
  const summaryHeaderRow = summarySheet.getRow(1);
  summaryHeaderRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  summaryHeaderRow.height = 24;

  const summaryData = [
    ['Document', documentTitle],
    ['QC Grade', result.grade],
    ['Critical Issues', String(result.criticalIssues.length)],
    ['Important Issues', String(result.importantIssues.length)],
    ['Minor Issues', String(result.minorIssues.length)],
    ['Total Issues', String(totalIssues)],
    ['', ''],
    ['Overall Assessment', result.overallAssessment],
    ['Positioning Stress Test', result.positioningStressTest],
    ['Bunny Detection', result.bunnyDetection],
    ['Brand Essence / Tone', result.brandEssenceToneCheck],
    ['Data Provenance Audit', result.dataProvenanceAudit],
  ];

  for (const [field, value] of summaryData) {
    const row = summarySheet.addRow([field, value]);
    row.eachCell((cell) => {
      cell.font = BODY_FONT;
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
    // Bold the field label
    row.getCell(1).font = { ...BODY_FONT, bold: true };
  }

  // Grade cell color
  const gradeRow = summarySheet.getRow(3); // Row 3 = QC Grade (row 1 header + row 2 document)
  const gradeCell = gradeRow.getCell(2);
  if (result.grade === 'A' || result.grade === 'B') {
    gradeCell.fill = GREEN_FILL;
  } else if (result.grade === 'C') {
    gradeCell.fill = YELLOW_FILL;
  } else {
    gradeCell.fill = RED_FILL;
  }
  gradeCell.font = { ...BODY_FONT, bold: true, size: 14 };

  // Return as Buffer
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
