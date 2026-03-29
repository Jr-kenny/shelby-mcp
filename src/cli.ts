#!/usr/bin/env node
import { startServer } from "./index.js";

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
