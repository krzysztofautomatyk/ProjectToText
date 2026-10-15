/**
 * App version, resolved at build time by Vite from package.json.
 * Falls back to '0.8.1' so the bundler never fails on a missing import.
 */
import pkg from '../package.json';

const version = (pkg as { version?: string }).version;
export default version || '0.8.1';
