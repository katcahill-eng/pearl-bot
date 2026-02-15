/**
 * Integration test for the intake conversation flow.
 *
 * Uses real Claude API + in-memory database mock, and mocked Slack.
 * Run with: npx tsx --require ./test-pg-mock.cjs test-intake-flow.ts
 *
 * Tests the user's exact conversation script plus edge cases:
 * - Out-of-order answers (context when asked for target)
 * - Multiple fields in one message
 * - Conference detection and contextual due-date prompts
 * - Field preservation across messages (no overwrites)
 * - Deploy recovery (botWasActive path)
 */

import 'dotenv/config';

// Bypass config validation — we only need ANTHROPIC_API_KEY
// Set dummy values for unused services so config.ts doesn't exit
const DUMMY = 'test-dummy';
for (const key of [
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET',
  'SLACK_MARKETING_CHANNEL_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_PROJECTS_FOLDER_ID', 'MONDAY_API_TOKEN', 'MONDAY_BOARD_ID',
  'MARKETING_LEAD_SLACK_ID', 'DATABASE_URL',
]) {
  if (!process.env[key]) process.env[key] = DUMMY;
}

import { initDb } from './src/lib/db';
import { ConversationManager } from './src/lib/conversation';
import { handleIntakeMessage } from './src/handlers/intake';

// Access the mock pool's reset function (set by test-pg-mock.cjs)
const mockPg = (globalThis as any).__mockPgPool;

// --- Mock Slack ---

interface SentMessage {
  text: string;
  thread_ts?: string;
  blocks?: any[];
}

function createMockSay(): { say: any; messages: SentMessage[] } {
  const messages: SentMessage[] = [];
  const say = async (msg: string | { text: string; thread_ts?: string; blocks?: any[] }) => {
    if (typeof msg === 'string') {
      messages.push({ text: msg });
    } else {
      messages.push(msg);
    }
  };
  return { say, messages };
}

function createMockClient(opts: {
  realName: string;
  title: string;
  userId: string;
  threadMessages?: any[];
}): any {
  return {
    users: {
      info: async () => ({
        user: {
          real_name: opts.realName,
          name: opts.realName.toLowerCase().replace(/\s/g, '.'),
          profile: {
            real_name: opts.realName,
            display_name: opts.realName.split(' ')[0].toLowerCase(),
            title: opts.title,
          },
        },
      }),
    },
    conversations: {
      replies: async (_args: any) => ({
        messages: opts.threadMessages ?? [],
      }),
    },
  };
}

// --- Helpers ---

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function printUser(msg: string) {
  console.log(`\n${COLORS.cyan}${COLORS.bright}  User:${COLORS.reset} ${msg}`);
}

function printBot(messages: SentMessage[]) {
  for (const m of messages) {
    const lines = m.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        console.log(`${COLORS.magenta}  Bot:${COLORS.reset}  ${lines[i]}`);
      } else {
        console.log(`${COLORS.dim}          ${lines[i]}${COLORS.reset}`);
      }
    }
  }
}

function printStep(n: number, desc: string) {
  console.log(`\n${COLORS.yellow}${COLORS.bright}--- Step ${n}: ${desc} ---${COLORS.reset}`);
}

function printCheck(label: string, pass: boolean, detail?: string) {
  const icon = pass ? `${COLORS.green}PASS` : `${COLORS.red}FAIL`;
  const extra = detail ? ` ${COLORS.dim}(${detail})${COLORS.reset}` : '';
  console.log(`${icon} ${label}${COLORS.reset}${extra}`);
  if (!pass) passCount.fail++;
  else passCount.pass++;
}

function printSection(title: string) {
  console.log(`\n${COLORS.blue}${COLORS.bright}${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}${COLORS.reset}`);
}

const passCount = { pass: 0, fail: 0 };

// Create unique message timestamps to avoid dedup collisions
let msgCounter = 0;
function nextMessageTs(): string {
  msgCounter++;
  return `${Date.now() / 1000 + msgCounter}.${String(msgCounter).padStart(6, '0')}`;
}

// --- Test Scenarios ---

async function runScenario(
  name: string,
  userMessages: string[],
  opts: {
    userId?: string;
    realName?: string;
    title?: string;
    hasExistingConvo?: boolean;
    simulateDeploy?: { afterMessage: number };
    checks?: (args: {
      allBotMessages: SentMessage[][];
      convo: ConversationManager | undefined;
    }) => void;
  } = {},
) {
  const userId = opts.userId ?? 'U_TEST_USER';
  const realName = opts.realName ?? 'Kat Cahill';
  const title = opts.title ?? 'Marketing Manager';
  const threadTs = `${Date.now() / 1000}.${Math.random().toString(36).slice(2, 8)}`;
  const channelId = 'C_TEST_CHANNEL';

  // Reset in-memory mock state for each scenario
  if (mockPg?._reset) mockPg._reset();

  // If testing dup-check flow, create an existing active conversation in another thread
  if (opts.hasExistingConvo) {
    const existingThreadTs = `${Date.now() / 1000 - 100}.existing`;
    const existingConvo = new ConversationManager({
      userId,
      userName: realName,
      channelId,
      threadTs: existingThreadTs,
    });
    existingConvo.markFieldCollected('requester_name', realName);
    await existingConvo.save();
  }

  printSection(name);

  const allBotMessages: SentMessage[][] = [];
  const threadHistory: any[] = []; // Track messages for mock thread history

  for (let i = 0; i < userMessages.length; i++) {
    const text = userMessages[i];
    const messageTs = nextMessageTs();

    // Simulate deploy: cancel conversation in mock DB
    if (opts.simulateDeploy && i === opts.simulateDeploy.afterMessage) {
      printStep(i + 1, `DEPLOY --- conversation cancelled in DB`);
      // Mark all active conversations in this thread as cancelled
      if (mockPg?._conversations) {
        for (const [, row] of mockPg._conversations) {
          if (row.thread_ts === threadTs && ['gathering', 'confirming'].includes(row.status)) {
            row.status = 'cancelled';
          }
        }
      }
    }

    printStep(i + 1, text.length > 60 ? text.substring(0, 60) + '...' : text);
    printUser(text);

    // Build thread history for mock client (includes all prior messages + bot responses)
    const mockClient = createMockClient({
      realName,
      title,
      userId,
      threadMessages: [...threadHistory],
    });

    // Add user message to history
    threadHistory.push({
      user: userId,
      text,
      ts: messageTs,
    });

    const { say, messages } = createMockSay();

    try {
      await handleIntakeMessage({
        userId,
        userName: userId,
        channelId,
        threadTs,
        messageTs,
        text,
        say,
        client: mockClient,
      });
    } catch (err: any) {
      console.log(`${COLORS.red}  ERROR: ${err.message}${COLORS.reset}`);
      if (err.stack) console.log(`${COLORS.dim}${err.stack.split('\n').slice(1, 4).join('\n')}${COLORS.reset}`);
    }

    // Add bot messages to thread history
    for (const m of messages) {
      threadHistory.push({
        bot_id: 'B_TEST_BOT',
        text: m.text,
        ts: nextMessageTs(),
      });
    }

    printBot(messages);
    allBotMessages.push(messages);
  }

  // Load final conversation state
  const finalConvo = await ConversationManager.load(userId, threadTs);
  if (finalConvo) {
    const data = finalConvo.getCollectedData();
    console.log(`\n${COLORS.blue}${COLORS.bright}  Final Conversation State:${COLORS.reset}`);
    console.log(`${COLORS.dim}  Status: ${finalConvo.getStatus()}, Step: ${finalConvo.getCurrentStep()}`);
    console.log(`  Name: ${data.requester_name}`);
    console.log(`  Dept: ${data.requester_department}`);
    console.log(`  Target: ${data.target}`);
    console.log(`  Context: ${data.context_background}`);
    console.log(`  Outcomes: ${data.desired_outcomes}`);
    console.log(`  Deliverables: ${JSON.stringify(data.deliverables)}`);
    console.log(`  Due date: ${data.due_date} (parsed: ${data.due_date_parsed})`);
    console.log(`  Classification: ${finalConvo.getClassification()}${COLORS.reset}`);
  } else {
    console.log(`\n${COLORS.red}  No conversation found after scenario!${COLORS.reset}`);
  }

  // Run checks if provided
  if (opts.checks) {
    console.log(`\n${COLORS.yellow}  Checks:${COLORS.reset}`);
    opts.checks({ allBotMessages, convo: finalConvo ?? undefined });
  }
}

// --- Main ---

async function main() {
  console.log(`${COLORS.bright}Pearl Bot Intake Flow - Integration Tests${COLORS.reset}`);
  console.log(`${COLORS.dim}Using real Claude API + in-memory database, mocked Slack${COLORS.reset}\n`);

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === DUMMY) {
    console.error(`${COLORS.red}ERROR: ANTHROPIC_API_KEY is required. Set it in .env or environment.${COLORS.reset}`);
    process.exit(1);
  }

  // Initialize DB (runs CREATE TABLE — no-op with mock)
  await initDb();

  // ============================================================
  // SCENARIO 1: Kat's exact test script (happy path with dup-check)
  // Tests: out-of-order answers, multi-field messages, conference detection
  // ============================================================
  await runScenario(
    'Scenario 1: Full intake - out-of-order answers + multi-field',
    [
      // Msg 1: Dup check triggers because user has existing conversation
      'I need help with a project',
      // Msg 2: Start fresh
      'Start fresh here',
      // Msg 3: Bot asks for target, user gives context instead (out-of-order)
      'I have a webinar series coming up',
      // Msg 4: Now user answers target (with conference mention)
      'Real estate agents at the Inman Conference in San Diego in September',
      // Msg 5: Desired outcomes (mentions existing project keyword)
      'Increase sign-ups to the Early Access Program',
      // Msg 6: Deliverables — multi-part answer with "I don't know" mixed in
      "I need help with my presentation slides. I might need a video and I need help creating the webinar or scheduling the webinar, whatever. I don't know what tools we use.",
      // Msg 7: Due date
      'Sometime in the beginning of September',
    ],
    {
      hasExistingConvo: true,
      checks: ({ allBotMessages, convo }) => {
        // Step 1: Should show dup-check prompt
        const step1 = allBotMessages[0];
        printCheck(
          'Step 1 shows dup-check',
          step1.some((m) => m.text.includes('open request') || m.text.includes('continue there') || m.text.includes('already have')),
          step1[0]?.text.substring(0, 60),
        );

        // Step 2: Should show welcome + name confirmation + first question
        const step2 = allBotMessages[1];
        printCheck(
          'Step 2 shows welcome',
          step2.some((m) => m.text.includes('Thanks for') || m.text.includes('Glad you') || m.text.includes('fresh')),
        );
        printCheck(
          'Step 2 confirms name',
          step2.some((m) => m.text.includes('Kat')),
        );

        // Step 3: Context given out-of-order — should ack and re-ask target
        const step3 = allBotMessages[2];
        printCheck(
          'Step 3 acknowledges context (webinar)',
          step3.some((m) => m.text.toLowerCase().includes('webinar')),
        );

        // Step 4: Target answered — should move forward (not re-ask target)
        const step4 = allBotMessages[3];
        printCheck(
          'Step 4 acknowledges target or moves to next question',
          step4.length > 0,
          step4[step4.length - 1]?.text.substring(0, 60),
        );

        // Step 5: Outcomes answered — should move to deliverables
        const step5 = allBotMessages[4];
        printCheck(
          'Step 5 moves forward',
          step5.length > 0,
          step5[step5.length - 1]?.text.substring(0, 60),
        );

        // Step 6: Deliverables answered (multi-field) — should ask due date
        const step6 = allBotMessages[5];
        printCheck(
          'Step 6 acknowledges deliverables',
          step6.some((m) =>
            m.text.toLowerCase().includes('slide') ||
            m.text.toLowerCase().includes('presentation') ||
            m.text.toLowerCase().includes('video') ||
            m.text.toLowerCase().includes('deliverable'),
          ),
        );

        // Step 7: Due date answered — should NOT send welcome or re-ask target
        const step7 = allBotMessages[6];
        printCheck(
          'Step 7 does NOT send a welcome message',
          !step7.some((m) => m.text.includes('Thanks for reaching out') || m.text.includes('Glad you reached out')),
        );
        printCheck(
          'Step 7 does NOT re-ask target',
          !step7.some((m) => m.text.toLowerCase().includes('who is the target audience')),
          step7[step7.length - 1]?.text.substring(0, 80),
        );

        // Final state checks
        if (convo) {
          const data = convo.getCollectedData();
          printCheck('Final: target is populated', data.target !== null && data.target !== '');
          printCheck('Final: context is populated', data.context_background !== null && data.context_background !== '');
          printCheck('Final: outcomes is populated', data.desired_outcomes !== null && data.desired_outcomes !== '');
          printCheck('Final: deliverables is populated', data.deliverables.length > 0);
          printCheck('Final: due date is populated', data.due_date !== null && data.due_date !== '');
          printCheck(
            'Final: target NOT overwritten by later messages',
            data.target !== null && (data.target.toLowerCase().includes('real estate') || data.target.toLowerCase().includes('agent')),
            `target="${data.target?.substring(0, 40)}"`,
          );
        }
      },
    },
  );

  // ============================================================
  // SCENARIO 2: Deploy mid-conversation recovery
  // ============================================================
  await runScenario(
    'Scenario 2: Deploy mid-conversation - field recovery',
    [
      'I need help with a project',
      'Real estate agents at the Inman Conference',
      'Increase early access signups',
      // Deploy happens here — conversation is cancelled in DB
      'I need a slide deck and some social posts',
    ],
    {
      simulateDeploy: { afterMessage: 3 },
      checks: ({ allBotMessages, convo }) => {
        const step4 = allBotMessages[3];
        printCheck(
          'Post-deploy: bot responds (not silent)',
          step4.length > 0,
        );
        printCheck(
          'Post-deploy: no welcome message sent',
          !step4.some((m) => m.text.includes('Thanks for reaching out') || m.text.includes('Glad you reached out')),
        );
        if (convo) {
          const data = convo.getCollectedData();
          printCheck(
            'Post-deploy: name preserved',
            data.requester_name !== null && data.requester_name !== '',
            data.requester_name ?? 'null',
          );
        }
      },
    },
  );

  // ============================================================
  // SCENARIO 3: Multi-field single message (everything at once)
  // The first message starts the welcome flow; the SECOND message
  // contains all the info and should extract multiple fields.
  // ============================================================
  await runScenario(
    'Scenario 3: Everything in one message',
    [
      'I need help with a marketing project',
      "I'm from the BD team and I need a one-pager PDF and 3 social posts for HVAC contractors about our new certification program. We want to drive 50 new partner sign-ups by end of March.",
    ],
    {
      checks: ({ allBotMessages, convo }) => {
        if (convo) {
          const data = convo.getCollectedData();
          let fieldsCollected = 0;
          if (data.requester_department) fieldsCollected++;
          if (data.target) fieldsCollected++;
          if (data.context_background) fieldsCollected++;
          if (data.desired_outcomes) fieldsCollected++;
          if (data.deliverables.length > 0) fieldsCollected++;
          if (data.due_date) fieldsCollected++;
          printCheck(
            `Multi-field: extracted ${fieldsCollected}+ fields from one message`,
            fieldsCollected >= 4,
            `dept=${data.requester_department}, target=${data.target?.substring(0, 20)}, deliverables=${data.deliverables.length}`,
          );
        }
      },
    },
  );

  // ============================================================
  // SCENARIO 4: Multi-field extraction from a mid-conversation message
  // ============================================================
  await runScenario(
    'Scenario 4: Multi-field extraction from single message',
    [
      'Hi I need some marketing help',
      'I need a flyer for an open house event targeting homeowners, due next Friday',
    ],
    {
      checks: ({ convo }) => {
        if (convo) {
          const data = convo.getCollectedData();
          printCheck(
            'Deliverables extracted',
            data.deliverables.length > 0,
            JSON.stringify(data.deliverables),
          );
          printCheck(
            'Target extracted',
            data.target !== null && data.target !== '',
            data.target ?? 'null',
          );
          printCheck(
            'Due date extracted',
            data.due_date !== null && data.due_date !== '',
            data.due_date ?? 'null',
          );
        }
      },
    },
  );

  // ============================================================
  // SCENARIO 5: IDK / skip / discuss handling
  // ============================================================
  await runScenario(
    'Scenario 5: IDK and skip patterns',
    [
      'I need help with a marketing campaign',
      "I don't know",
      'skip',
    ],
    {
      checks: ({ allBotMessages }) => {
        const step2 = allBotMessages[1];
        printCheck(
          'IDK gets guidance (not "I didn\'t catch that")',
          !step2.some((m) => m.text.includes("didn't quite catch")),
          step2[0]?.text.substring(0, 60),
        );
        const step3 = allBotMessages[2];
        printCheck(
          'Skip advances to next question',
          step3.length > 0,
          step3[0]?.text.substring(0, 60),
        );
      },
    },
  );

  // ============================================================
  // SCENARIO 6: Empty and nudge messages
  // ============================================================
  await runScenario(
    'Scenario 6: Nudge after silence',
    [
      'I need a social media campaign for our Q2 launch',
      'hello',
    ],
    {
      checks: ({ allBotMessages }) => {
        const step2 = allBotMessages[1];
        printCheck(
          'Nudge "hello" resumes conversation (not treated as answer)',
          step2.some((m) =>
            m.text.includes("I'm here") ||
            m.text.includes('pick up') ||
            m.text.includes('still here') ||
            m.text.includes('left off'),
          ),
          step2[0]?.text.substring(0, 60),
        );
      },
    },
  );

  // --- Summary ---
  console.log(`\n${COLORS.bright}${'='.repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.green}  PASSED: ${passCount.pass}${COLORS.reset}`);
  if (passCount.fail > 0) {
    console.log(`${COLORS.red}  FAILED: ${passCount.fail}${COLORS.reset}`);
  }
  console.log(`${COLORS.bright}${'='.repeat(60)}${COLORS.reset}\n`);

  if (passCount.fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
