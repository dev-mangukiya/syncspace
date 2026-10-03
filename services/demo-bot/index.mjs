#!/usr/bin/env node
import { createClient } from 'redis';
import { runDemoBot } from './bot.mjs';

const HTTP_URL = process.env.WS_SERVER_HTTP_URL || process.env.WS_SERVER_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_SERVER_WS_URL || HTTP_URL.replace('http', 'ws');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

console.log('═══════════════════════════════════════════════════════════════');
console.log(' SYNCPACE DEMO BOT SERVICE (GHOST COLLABORATOR)');
console.log(` Target Server: ${HTTP_URL}`);
console.log(` Redis URL:     ${REDIS_URL}`);
console.log('═══════════════════════════════════════════════════════════════');

const activeBotRooms = new Set();

async function handleDemoTrigger(event) {
  const { workspace_slug, short_id, file_path, visitor } = event;
  const roomIdentifier = short_id || workspace_slug;
  const key = `${roomIdentifier}:${file_path}`;

  if (activeBotRooms.has(key)) {
    console.log(`[DemoBot] Already active in room ${key}, skipping trigger.`);
    return;
  }

  activeBotRooms.add(key);
  console.log(`[DemoBot] Visitor "${visitor}" entered demo room ${key}. Bot joining in 2.5s...`);

  try {
    const bot = await runDemoBot({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      workspaceSlug: roomIdentifier,
      filePath: file_path,
      joinDelayMs: 2500, // joins within a few seconds
      typingDelayMs: 90,
      onStep: (step) => {
        if (step.step === 'range_selected') {
          console.log(`[DemoBot] [${key}] Selecting target bug (${step.from}..${step.to})`);
        } else if (step.step === 'comment_added') {
          console.log(`[DemoBot] [${key}] Completed scripted edit: ${step.comment}`);
        }
      }
    });

    console.log(`[DemoBot] Joined ${key} successfully. Starting scripted fix sequence...`);
    await bot.performScriptedEdit({
      targetSnippet: '5 / 9',
      replacementText: '9 / 5',
      appendComment: '# Fixed by Demo Bot',
    });
    console.log(`[DemoBot] Scripted edits complete in room ${key}. Bot remains connected as active collaborator.`);
  } catch (err) {
    console.error(`[DemoBot] Failed to execute bot in room ${key}:`, err.message);
    activeBotRooms.delete(key);
  }
}

async function start() {
  // Check CLI arguments for manual trigger: --workspace <slug> --file <path>
  const wsArgIdx = process.argv.indexOf('--workspace');
  const fileArgIdx = process.argv.indexOf('--file');

  if (wsArgIdx !== -1 && fileArgIdx !== -1) {
    const slug = process.argv[wsArgIdx + 1];
    const file = process.argv[fileArgIdx + 1];
    console.log(`[DemoBot] Manual CLI invocation for workspace=${slug}, file=${file}`);
    await handleDemoTrigger({ workspace_slug: slug, file_path: file, visitor: 'cli-user' });
    return;
  }

  // Redis listener mode
  try {
    const subscriber = createClient({ url: REDIS_URL });
    subscriber.on('error', (err) => console.error('[DemoBot Redis Error]', err));
    await subscriber.connect();

    console.log('[DemoBot] Subscribed to Redis channel "syncspace:demo:triggers". Listening for visitors...\n');
    await subscriber.subscribe('syncspace:demo:triggers', (message) => {
      try {
        const event = JSON.parse(message);
        if (event.type === 'demo_visitor_joined') {
          handleDemoTrigger(event);
        }
      } catch (err) {
        console.error('[DemoBot] Error parsing trigger message:', err);
      }
    });
  } catch (err) {
    console.warn(`[DemoBot] Redis connection failed (${err.message}). Service running in on-demand mode only.`);
  }
}

start().catch(err => {
  console.error('[DemoBot] Fatal error:', err);
  process.exit(1);
});
