import { probePty } from '../dist/src/pty.js';

const result = await probePty();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
