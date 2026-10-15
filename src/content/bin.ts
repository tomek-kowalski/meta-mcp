#!/usr/bin/env node
import { loadDotEnv } from "../config.js";
import { logError } from "../sanitize.js";
import { main } from "./cli.js";

loadDotEnv();
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
