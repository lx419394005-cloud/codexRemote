const WebSocket = require('ws');

const TOKEN = 'test123';
const BRIDGE_URL = `ws://127.0.0.1:8080/?token=${TOKEN}`;

let nextId = 1;
const pending = new Map();

function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    ws.send(JSON.stringify({ method, id, params }));
    pending.set(id, { resolve, reject, method });
  });
}

function run() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    let step = 0;
    const results = [];

    function pass(msg) {
      console.log(`✅ ${msg}`);
      results.push(msg);
    }
    function fail(msg) {
      console.error(`❌ ${msg}`);
      results.push(msg);
    }

    // Register message handler FIRST, before open/send
    let gotAgentMessage = false;
    let gotTurnCompleted = false;
    let timeout = null;

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      if (data.id !== undefined) {
        const req = pending.get(data.id);
        if (req) {
          pending.delete(data.id);
          if (data.error) req.reject(new Error(data.error.message));
          else req.resolve(data.result);
        }
        return;
      }

      const method = data.method;
      const p = data.params || {};

      switch (method) {
        case 'thread/started':
          pass(`notification: thread/started (id=${p.thread?.id})`);
          break;
        case 'turn/started':
          pass(`notification: turn/started (id=${p.turn?.id})`);
          break;
        case 'item/started':
          console.log(`  📦 item/started: type=${p.item?.type}`);
          break;
        case 'item/agentMessage/delta':
          if (!gotAgentMessage) {
            gotAgentMessage = true;
            pass(`notification: item/agentMessage/delta (text="${p.text?.slice(0, 50)}...")`);
          }
          break;
        case 'item/completed':
          console.log(`  ✅ item/completed: type=${p.item?.type}`);
          break;
        case 'turn/completed':
          gotTurnCompleted = true;
          pass(`notification: turn/completed (status=${p.turn?.status})`);
          if (timeout) clearTimeout(timeout);
          console.log(`\n📊 Results: ${results.filter(r => r.startsWith('✅')).length}/${results.length} passed`);
          ws.close();
          resolve(results);
          break;
        case 'thread/status/changed':
          break;
        default:
          console.log(`  🔔 ${method}: ${JSON.stringify(p).slice(0, 100)}`);
      }
    });

    ws.on('open', async () => {
      console.log('🔗 Connected to Bridge');

      try {
        // Step 1: Initialize
        console.log('\n--- Step 1: Initialize ---');
        const initResult = await send(ws, 'initialize', {
          clientInfo: { name: 'test_client', title: 'Test', version: '0.1.0' }
        });
        pass(`initialize: userAgent = ${initResult.userAgent}`);

        // initialized is a notification (no id), send directly
        ws.send(JSON.stringify({ method: 'initialized' }));
        pass('initialized notification sent');

        // Step 2: List threads
        console.log('\n--- Step 2: List threads ---');
        const listResult = await send(ws, 'thread/list', { limit: 5 });
        pass(`thread/list: found ${listResult.data?.length || 0} threads`);

        // Step 3: Start a new thread
        console.log('\n--- Step 3: Start thread ---');
        const startResult = await send(ws, 'thread/start', {
          model: 'o3',
          cwd: process.env.HOME || '/tmp',
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
        const threadId = startResult.thread?.id;
        pass(`thread/start: id = ${threadId}`);

        // Step 4: Send a turn
        console.log('\n--- Step 4: Send turn ---');
        const turnResult = await send(ws, 'turn/start', {
          threadId,
          input: [{ type: 'text', text: 'Say hello in one word.' }]
        });
        pass(`turn/start: turnId = ${turnResult.turn?.id}`);

        // Wait for notifications
        console.log('\n--- Waiting for notifications (max 30s) ---');
        timeout = setTimeout(() => {
          console.log('\n⏰ Timeout reached');
          console.log(`\n📊 Results: ${results.filter(r => r.startsWith('✅')).length}/${results.length} passed`);
          ws.close();
          resolve(results);
        }, 30000);
      } catch (e) {
        fail(`Error: ${e.message}`);
        if (timeout) clearTimeout(timeout);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (err) => {
      fail(`WebSocket error: ${err.message}`);
      reject(err);
    });

    ws.on('close', () => {
      console.log('🔌 Connection closed');
    });
  });
}

run().then((results) => {
  const passed = results.filter(r => r.startsWith('✅')).length;
  const total = results.length;
  console.log(`\n${passed}/${total} tests passed`);
  process.exit(passed === total ? 0 : 1);
}).catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
