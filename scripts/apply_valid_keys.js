const fs = require('fs');
const path = require('path');

const logPath = 'C:/Users/NCN0C/.gemini/antigravity/brain/c41b3dd4-5896-4d62-b91c-2e0504856004/.system_generated/tasks/task-2641.log';
const log = fs.readFileSync(logPath, 'utf-8');
const lines = log.split('\n');

const kpmPath = path.join(__dirname, '../src/main/keyPoolManager.ts');
const kpmCode = fs.readFileSync(kpmPath, 'utf-8');

const match = kpmCode.match(/export const SEED_API_KEYS: string\[\] = \[([\s\S]*?)\n\]/);
if (!match) {
  console.error('Could not find SEED_API_KEYS in keyPoolManager.ts');
  process.exit(1);
}

const keyLines = match[1].match(/'[^']+'/g) || [];
const allSeedKeys = keyLines.map(k => k.replace(/'/g, ''));

const validKeys = [];
const invalidKeys = [];

for (let i = 0; i < allSeedKeys.length; i++) {
  const line = lines.find(l => l.includes(`Testing key [${i + 1}/92]`));
  if (line && line.includes('VALID') && !line.includes('INVALID')) {
    validKeys.push(allSeedKeys[i]);
  } else {
    invalidKeys.push(allSeedKeys[i]);
  }
}

console.log(`Original keys: ${allSeedKeys.length}`);
console.log(`Valid active keys: ${validKeys.length}`);
console.log(`Invalid deleted keys: ${invalidKeys.length}`);

// Replace SEED_API_KEYS in keyPoolManager.ts with ONLY the valid keys
const newSeedBlock = `export const SEED_API_KEYS: string[] = [\n${validKeys.map(k => `  '${k}'`).join(',\n')}\n]`;
const updatedKpmCode = kpmCode.replace(/export const SEED_API_KEYS: string\[\] = \[[\s\S]*?\n\]/, newSeedBlock);
fs.writeFileSync(kpmPath, updatedKpmCode, 'utf-8');

console.log('Successfully updated src/main/keyPoolManager.ts with 66 valid API keys!');
