#!/usr/bin/env node
process.env.BASE_URL = process.env.BASE_URL || "";
process.env.PROVIDER1_EMAIL = process.env.PROVIDER1_EMAIL || "";
process.env.PROVIDER1_PASSWORD = process.env.PROVIDER1_PASSWORD || "";
process.env.PROVIDER2_EMAIL = process.env.PROVIDER2_EMAIL || "";
process.env.PROVIDER2_PASSWORD = process.env.PROVIDER2_PASSWORD || "";

for (const key of ["BASE_URL","PROVIDER1_EMAIL","PROVIDER1_PASSWORD","PROVIDER2_EMAIL","PROVIDER2_PASSWORD"]) {
  if (!process.env[key].trim()) {
    console.error("Missing required CI variable: " + key);
    process.exit(2);
  }
}

const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("./e2e-live.js"), "utf8")
  .replace(/const p1Email=await ask\([^;]+;/, 'const p1Email=process.env.PROVIDER1_EMAIL;')
  .replace(/const p1Password=await ask\([^;]+;/, 'const p1Password=process.env.PROVIDER1_PASSWORD;')
  .replace(/const p2Email=await ask\([^;]+;/, 'const p2Email=process.env.PROVIDER2_EMAIL;')
  .replace(/const p2Password=await ask\([^;]+;/, 'const p2Password=process.env.PROVIDER2_PASSWORD;');

const runner = require("node:vm");
runner.runInThisContext(source, {filename:"e2e-live.js"});
