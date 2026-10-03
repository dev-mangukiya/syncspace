import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createMutex } from 'lib0/mutex';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/**
 * Requests a short-lived ticket from /api/ws-ticket using real bot credentials.
 * No privileged backdoors: uses standard auth cookies + CSRF token.
 */
export async function getBotTicket(baseUrl, email = 'demo-bot@syncspace.internal', password = 'DemoBotSecret2026!') {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Bot login failed (${loginRes.status}): ${text}`);
  }

  const loginData = await loginRes.json();
  const cookies = (loginRes.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');

  const ticketRes = await fetch(`${baseUrl}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      'Cookie': cookies,
      'X-CSRF-Token': loginData.csrf_token,
    },
  });

  if (!ticketRes.ok) {
    const text = await ticketRes.text();
    throw new Error(`Bot ticket request failed (${ticketRes.status}): ${text}`);
  }

  const ticketData = await ticketRes.json();
  return ticketData.ticket;
}

/**
 * Creates and runs a Demo Bot instance in a designated demo workspace.
 */
export async function runDemoBot(options) {
  const {
    httpUrl = 'http://localhost:8080',
    wsUrl = 'ws://localhost:8080',
    workspaceSlug,
    filePath,
    typingDelayMs = 80,
    joinDelayMs = 0,
    seedContentIfGranted = null,
    onStep = null,
    onSynced = null,
  } = options;

  if (joinDelayMs > 0) {
    await new Promise(r => setTimeout(r, joinDelayMs));
  }

  // 1. Obtain ticket under real bot credentials
  const ticket = await getBotTicket(httpUrl);

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const ytext = doc.getText('content');
  const mux = createMutex();

  // Set permanent bot identity and distinct styling in awareness
  awareness.setLocalStateField('user', {
    name: 'Demo Bot',
    color: '#8B5CF6',       // Distinct purple
    colorLight: '#EDE9FE',
    isBot: true,            // Distinct bot flag
  });

  let canSeed = false;
  let hasSeeded = false;
  let isSynced = false;
  let isClosed = false;

  const wsEndpoint = `${wsUrl}/ws/${workspaceSlug}/${encodeURIComponent(filePath)}?ticket=${ticket}`;
  const ws = new WebSocket(wsEndpoint);
  ws.binaryType = 'arraybuffer';

  // Broadcast outgoing Yjs document updates
  doc.on('update', (update, origin) => {
    if (origin === ws || isClosed) return;
    if (ws.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      ws.send(encoding.toUint8Array(encoder));
    }
  });

  // Broadcast outgoing awareness updates
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === ws || isClosed) return;
    if (ws.readyState === WebSocket.OPEN) {
      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      );
      ws.send(encoding.toUint8Array(encoder));
    }
  });

  const completionPromise = new Promise((resolve, reject) => {
    ws.on('open', () => {
      // Send Sync Step 1
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));

      // Send local awareness
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])
      );
      ws.send(encoding.toUint8Array(awarenessEncoder));
    });

    ws.on('message', async (data, isBinary) => {
      if (!isBinary) {
        try {
          const text = data.toString();
          const parsed = JSON.parse(text);
          if (parsed.type === 'seed_grant') {
            canSeed = true;
            if (seedContentIfGranted && !hasSeeded && ytext.length === 0) {
              hasSeeded = true;
              doc.transact(() => {
                ytext.insert(0, seedContentIfGranted);
              });
              onStep?.({ step: 'seed_granted_and_applied', length: ytext.length });
            }
          }
        } catch {}
        return;
      }

      // Binary frame handling
      try {
        const uint8 = new Uint8Array(data);
        const decoder = decoding.createDecoder(uint8);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MSG_SYNC: {
            const syncEncoder = encoding.createEncoder();
            encoding.writeVarUint(syncEncoder, MSG_SYNC);
            syncProtocol.readSyncMessage(decoder, syncEncoder, doc, ws);
            if (encoding.length(syncEncoder) > 1) {
              ws.send(encoding.toUint8Array(syncEncoder));
            }
            if (!isSynced) {
              isSynced = true;
              onSynced?.(ytext.toString());
            }
            break;
          }
          case MSG_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
            break;
          }
        }
      } catch (err) {
        console.error('[DemoBot] Error processing message:', err);
      }
    });

    ws.on('error', (err) => {
      if (!isClosed) reject(err);
    });

    ws.on('close', () => {
      isClosed = true;
    });
  });

  /**
   * Performs realistic character-by-character editing sequence.
   */
  async function performScriptedEdit(plan) {
    // Wait until document is synced
    const startWait = Date.now();
    while (!isSynced && Date.now() - startWait < 5000) {
      await new Promise(r => setTimeout(r, 50));
    }

    const currentText = ytext.toString();
    const {
      targetSnippet = '5 / 9',
      replacementText = '9 / 5',
      appendComment = '# Fixed by Demo Bot',
    } = plan || {};

    let targetIdx = currentText.indexOf(targetSnippet);
    if (targetIdx === -1) {
      // Fallback: append or insert at end if snippet not found
      targetIdx = Math.max(0, currentText.length - 1);
    }

    // 1. Move cursor to target position
    awareness.setLocalStateField('selection', {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, targetIdx),
      head: Y.createRelativePositionFromTypeIndex(ytext, targetIdx),
    });
    onStep?.({ step: 'cursor_moved', index: targetIdx });
    await new Promise(r => setTimeout(r, 300));

    // 2. Select target snippet (visual range selection in Monaco)
    if (currentText.includes(targetSnippet)) {
      awareness.setLocalStateField('selection', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, targetIdx),
        head: Y.createRelativePositionFromTypeIndex(ytext, targetIdx + targetSnippet.length),
      });
      onStep?.({ step: 'range_selected', from: targetIdx, to: targetIdx + targetSnippet.length });
      await new Promise(r => setTimeout(r, 350));

      // 3. Delete target snippet
      doc.transact(() => {
        ytext.delete(targetIdx, targetSnippet.length);
      });
      awareness.setLocalStateField('selection', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, targetIdx),
        head: Y.createRelativePositionFromTypeIndex(ytext, targetIdx),
      });
      onStep?.({ step: 'target_deleted', index: targetIdx });
      await new Promise(r => setTimeout(r, 200));
    }

    // 4. Type replacement text character-by-character
    let currentIdx = targetIdx;
    for (let i = 0; i < replacementText.length; i++) {
      const char = replacementText[i];
      doc.transact(() => {
        ytext.insert(currentIdx, char);
      });
      currentIdx++;
      awareness.setLocalStateField('selection', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, currentIdx),
        head: Y.createRelativePositionFromTypeIndex(ytext, currentIdx),
      });
      onStep?.({ step: 'char_typed', char, index: currentIdx });
      await new Promise(r => setTimeout(r, typingDelayMs));
    }

    // 5. If comment requested, type comment at the end of the line
    if (appendComment) {
      await new Promise(r => setTimeout(r, 250));
      const lineEndMatch = ytext.toString().slice(currentIdx).indexOf('\n');
      const commentPos = lineEndMatch !== -1 ? currentIdx + lineEndMatch : ytext.length;

      let commentIdx = commentPos;
      const fullComment = '  ' + appendComment;
      for (let i = 0; i < fullComment.length; i++) {
        const char = fullComment[i];
        doc.transact(() => {
          ytext.insert(commentIdx, char);
        });
        commentIdx++;
        awareness.setLocalStateField('selection', {
          anchor: Y.createRelativePositionFromTypeIndex(ytext, commentIdx),
          head: Y.createRelativePositionFromTypeIndex(ytext, commentIdx),
        });
        await new Promise(r => setTimeout(r, Math.max(30, typingDelayMs - 20)));
      }
      onStep?.({ step: 'comment_added', comment: appendComment });
    }

    return ytext.toString();
  }

  function disconnect() {
    isClosed = true;
    try {
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'disconnect');
      ws.close();
    } catch {}
  }

  return {
    doc,
    awareness,
    ytext,
    ws,
    canSeed: () => canSeed,
    disconnect,
    performScriptedEdit,
    completionPromise,
  };
}
