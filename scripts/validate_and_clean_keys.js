const https = require('https');
const path = require('path');
const Database = require('better-sqlite3');

function httpRequest(url, method = 'GET', data = null) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ error: 'Timeout' });
    });

    if (data) req.write(data);
    req.end();
  });
}

async function testKeyWithModel(apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Halo' }] }]
  });
  return await httpRequest(url, 'POST', payload);
}

async function listAvailableModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  return await httpRequest(url, 'GET');
}

async function main() {
  console.log('=== JARVIS API KEY VALIDATOR & CLEANER ===');

  // 1. Get keys from database and code
  const dbPath = path.join(__dirname, '../jarvis-data/jarvis_memory.db');
  let db;
  let allKeys = [];

  try {
    db = new Database(dbPath);
    const rows = db.prepare('SELECT api_key FROM api_keys').all();
    allKeys = rows.map(r => r.api_key);
    console.log(`Found ${allKeys.length} keys in SQLite database.`);
  } catch (err) {
    console.warn('Could not read SQLite database directly:', err.message);
  }

  // Also read from keyPoolManager.ts
  const kpmCode = require('fs').readFileSync(path.join(__dirname, '../src/main/keyPoolManager.ts'), 'utf-8');
  const keyMatches = kpmCode.match(/['"](AQ\.[a-zA-Z0-9_\-]+|AIza[a-zA-Z0-9_\-]+)['"]/g) || [];
  const seedKeys = keyMatches.map(k => k.replace(/['"]/g, ''));
  
  // Combine unique keys
  const uniqueKeys = Array.from(new Set([...allKeys, ...seedKeys]));
  console.log(`Total unique keys to validate: ${uniqueKeys.length}`);

  // 2. Find available models using first responsive key
  console.log('\nTesting available models on Gemini API endpoint...');
  let workingKeyForModelList = null;

  for (const k of uniqueKeys.slice(0, 15)) {
    const listRes = await listAvailableModels(k);
    if (listRes.status === 200 && listRes.data?.models) {
      workingKeyForModelList = k;
      const modelNames = listRes.data.models.map(m => m.name.replace('models/', ''));
      console.log('Available Gemini Models on API:');
      console.log(modelNames.filter(m => m.includes('gemini') || m.includes('flash') || m.includes('3')).join(', '));
      break;
    }
  }

  // Target model specified by user: gemini-3.1-flash-lite
  const targetModel = 'gemini-3.1-flash-lite';
  console.log(`\nValidating all ${uniqueKeys.length} keys against model "${targetModel}"...`);

  const validKeys = [];
  const invalidKeys = [];

  for (let i = 0; i < uniqueKeys.length; i++) {
    const key = uniqueKeys[i];
    process.stdout.write(`Testing key [${i + 1}/${uniqueKeys.length}] (${key.substring(0, 10)}...)... `);
    
    // First test with target model
    let res = await testKeyWithModel(key, targetModel);
    
    // If 404 on model, test fallback model to see if key itself is valid
    if (res.status === 404 && res.data?.error?.message?.includes('not found')) {
      // Test with general model if 3.1 is not on this endpoint
      res = await testKeyWithModel(key, 'gemini-2.0-flash');
    }

    if (res.status === 200 && res.data?.candidates) {
      console.log('✅ VALID');
      validKeys.push(key);
    } else {
      const errDetail = res.data?.error?.message || res.error || `Status ${res.status}`;
      console.log(`❌ INVALID (${errDetail})`);
      invalidKeys.push({ key, error: errDetail });
    }
  }

  console.log(`\n=== VALIDATION RESULTS ===`);
  console.log(`✅ Valid Keys: ${validKeys.length}`);
  console.log(`❌ Invalid Keys: ${invalidKeys.length}`);

  // 3. Clean invalid keys from database
  if (db) {
    console.log('\nCleaning invalid keys from database...');
    const deleteStmt = db.prepare('DELETE FROM api_keys WHERE api_key = ?');
    const updateValidStmt = db.prepare(`
      INSERT INTO api_keys (id, api_key, status, success_calls, failed_calls, rate_limit_count, consecutive_errors)
      VALUES (?, ?, 'ACTIVE', 1, 0, 0, 0)
      ON CONFLICT(api_key) DO UPDATE SET status = 'ACTIVE', consecutive_errors = 0
    `);

    db.transaction(() => {
      for (const inv of invalidKeys) {
        deleteStmt.run(inv.key);
      }
      for (const val of validKeys) {
        const id = require('crypto').randomUUID();
        updateValidStmt.run(id, val);
      }
      // Update app_config default model to gemini-3.1-flash-lite
      db.prepare(`
        INSERT INTO app_config (key, value) VALUES ('model', 'gemini-3.1-flash-lite')
        ON CONFLICT(key) DO UPDATE SET value = 'gemini-3.1-flash-lite'
      `).run();
    })();
    console.log('Database updated successfully.');
    db.close();
  }

  // Return summary JSON
  require('fs').writeFileSync(
    path.join(__dirname, 'validation_summary.json'),
    JSON.stringify({ validKeys, invalidCount: invalidKeys.length, targetModel }, null, 2)
  );
}

main().catch(console.error);
