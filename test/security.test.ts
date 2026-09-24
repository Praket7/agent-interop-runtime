import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import { assertSafeId, readSafeProjectText, safeProjectPath } from '../src/security.js';
test('rejects traversal-like identifiers',()=>assert.throws(()=>assertSafeId('../secret')));
test('accepts opaque thread ids',()=>assert.equal(assertSafeId('thread_123:abc'),'thread_123:abc'));
test('blocks common credential files and redacts secrets from allowed text', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'interop-secret-'));
  try {
    await fs.writeFile(path.join(root,'.npmrc'),'//registry.npmjs.org/:_authToken=fake-npm-token');
    await assert.rejects(()=>safeProjectPath(root,'.npmrc'),/Protected file/);
    await fs.writeFile(path.join(root,'settings.txt'),'deploy token=synthetic-secret-value api_key="synthetic phrase secret" done');
    const safePath=await safeProjectPath(root,'settings.txt');
    const content=await readSafeProjectText(safePath);
    assert.match(content,/deploy token=\[REDACTED\]/);
    assert.doesNotMatch(content,/synthetic-secret-value/);
    assert.doesNotMatch(content,/synthetic phrase secret/);
    await fs.writeFile(path.join(root,'image.bin'),Buffer.from([0x89,0x50,0x4e,0x47,0x00]));
    const imagePath=await safeProjectPath(root,'image.bin');
    await assert.rejects(()=>readSafeProjectText(imagePath),/Binary/);
  } finally { await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}); }
});
