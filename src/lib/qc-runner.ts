import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { QC_SYSTEM_PROMPT, QC_USER_PROMPT } from './qc-prompt';

// --- Types ---

export interface QCIssue {
  category: string;
  originalText: string;
  issue: string;
  suggestedFix: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface QCResult {
  rawOutput: string;
  criticalIssues: QCIssue[];
  importantIssues: QCIssue[];
  minorIssues: QCIssue[];
  positioningStressTest: string;
  bunnyDetection: string;
  brandEssenceToneCheck: string;
  dataProvenanceAudit: string;
  overallAssessment: string;
  summary: string;
  grade: string;
}

// --- JSON Schema for structured response ---

const QC_JSON_SCHEMA = `
Respond ONLY with valid JSON matching this schema (no markdown fences, no explanation outside the JSON):
{
  "criticalIssues": [
    {
      "category": "string (e.g., 'Pillar Accuracy', 'Product Capability', 'Positioning Violation')",
      "originalText": "string (exact quote from the document)",
      "issue": "string (description of the problem)",
      "suggestedFix": "string (corrected version)",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "importantIssues": [ /* same shape as criticalIssues */ ],
  "minorIssues": [ /* same shape as criticalIssues */ ],
  "positioningStressTest": "string (full paragraph)",
  "bunnyDetection": "string (full paragraph with any quoted sentences and rewrites)",
  "brandEssenceToneCheck": "string (full paragraph)",
  "dataProvenanceAudit": "string (table or list of statistics with source status)",
  "overallAssessment": "string (full paragraph)"
}`;

// --- Grade calculation ---

function calculateGrade(criticalCount: number, importantCount: number): string {
  if (criticalCount === 0 && importantCount <= 2) return 'A';
  if (criticalCount === 0 && importantCount <= 5) return 'B';
  if (criticalCount === 1 || importantCount > 5) return 'C';
  if (criticalCount >= 2 && criticalCount <= 3) return 'D';
  return 'F'; // 4+ critical
}

// --- Summary generation ---

function generateSummary(result: QCResult): string {
  const critCount = result.criticalIssues.length;
  const impCount = result.importantIssues.length;
  const minCount = result.minorIssues.length;
  const total = critCount + impCount + minCount;

  if (total === 0) {
    return `Grade ${result.grade}: Document passes QC with no issues found. Content aligns with Pearl brand guidelines and positioning.`;
  }

  const parts: string[] = [`Grade ${result.grade}:`];

  if (critCount > 0) {
    parts.push(`${critCount} critical issue${critCount !== 1 ? 's' : ''} requiring immediate attention.`);
  }
  if (impCount > 0) {
    parts.push(`${impCount} important issue${impCount !== 1 ? 's' : ''} that should be addressed.`);
  }
  if (minCount > 0) {
    parts.push(`${minCount} minor suggestion${minCount !== 1 ? 's' : ''}.`);
  }

  return parts.join(' ');
}

// --- Parse JSON from Claude response ---

function parseQCJson(text: string): Omit<QCResult, 'rawOutput' | 'summary' | 'grade'> | null {
  try {
    // Try to extract JSON from the response — handle markdown fences
    let jsonStr = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1];
    }

    // Try to find JSON object boundaries
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);

    return {
      criticalIssues: Array.isArray(parsed.criticalIssues) ? parsed.criticalIssues : [],
      importantIssues: Array.isArray(parsed.importantIssues) ? parsed.importantIssues : [],
      minorIssues: Array.isArray(parsed.minorIssues) ? parsed.minorIssues : [],
      positioningStressTest: parsed.positioningStressTest ?? '',
      bunnyDetection: parsed.bunnyDetection ?? '',
      brandEssenceToneCheck: parsed.brandEssenceToneCheck ?? '',
      dataProvenanceAudit: parsed.dataProvenanceAudit ?? '',
      overallAssessment: parsed.overallAssessment ?? '',
    };
  } catch {
    return null;
  }
}

// --- Fallback extraction via second Claude call ---

async function extractStructuredFromRaw(
  client: Anthropic,
  rawText: string,
): Promise<Omit<QCResult, 'rawOutput' | 'summary' | 'grade'>> {
  console.log('[qc-runner] JSON parse failed, attempting extraction via second Claude call');

  const extractionPrompt = `The following is a content QC review. Extract the structured data into JSON.

${QC_JSON_SCHEMA}

REVIEW TEXT:
${rawText}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: extractionPrompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from extraction call');
    }

    const parsed = parseQCJson(content.text);
    if (parsed) return parsed;
  } catch (err) {
    console.error('[qc-runner] Extraction call failed:', err);
  }

  // Ultimate fallback — return empty structure with raw text in assessment
  return {
    criticalIssues: [],
    importantIssues: [],
    minorIssues: [],
    positioningStressTest: '',
    bunnyDetection: '',
    brandEssenceToneCheck: '',
    dataProvenanceAudit: '',
    overallAssessment: rawText.slice(0, 2000),
  };
}

// --- Public API ---

/**
 * Run the full QC review on document content.
 * Uses Claude claude-sonnet-4-20250514 for quality with a 60-second timeout for long documents.
 */
export async function runQC(documentContent: string, documentType?: string): Promise<QCResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const contextNote = documentType
    ? `\n\nDOCUMENT TYPE: ${documentType}\n`
    : '';

  const userMessage = `${QC_USER_PROMPT}${contextNote}\n${documentContent}\n\n${QC_JSON_SCHEMA}`;

  console.log(`[qc-runner] Starting QC review (${documentContent.length} chars, type: ${documentType ?? 'unspecified'})`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: QC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from QC review');
  }

  const rawOutput = content.text;

  // Try to parse the JSON response
  let parsed = parseQCJson(rawOutput);

  // If parsing fails, do a second call to extract structure
  if (!parsed) {
    parsed = await extractStructuredFromRaw(client, rawOutput);
  }

  const grade = calculateGrade(parsed.criticalIssues.length, parsed.importantIssues.length);

  const result: QCResult = {
    rawOutput,
    ...parsed,
    grade,
    summary: '', // placeholder — filled below
  };

  result.summary = generateSummary(result);

  console.log(`[qc-runner] QC complete: grade=${grade}, critical=${parsed.criticalIssues.length}, important=${parsed.importantIssues.length}, minor=${parsed.minorIssues.length}`);

  return result;
}
