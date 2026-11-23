#!/usr/bin/env node
// Entry point for the launchers in ~/.config/claude-pod/shims/: claude-pod-shim.js <tool> [args...]
import { shimMain } from '../src/shim.js';

const [tool, ...args] = process.argv.slice(2);
const result = await shimMain(tool, args);
// The command was killed by a signal: die by it too, so a parent (a shell, a test runner) sees that.
if (typeof result === 'object') process.kill(process.pid, result.signal);
else process.exitCode = result;
