#!/usr/bin/env node
import { main } from "../index.mjs";

process.exitCode = await main(process.argv.slice(2));
