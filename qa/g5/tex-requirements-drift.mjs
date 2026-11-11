#!/usr/bin/env node
// Keep doctor.sh's post-build TeX check aligned with Dockerfile.ce's build gate.
// Zero dependencies, no Docker, no network: static comparison of the shipped files.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dockerfile = readFileSync(join(ROOT, 'infra/docker/Dockerfile.ce'), 'utf8');
const doctor = readFileSync(join(ROOT, 'scripts/doctor.sh'), 'utf8');

// Dockerfile build-time kpsewhich gates use one filename per command. Exclude
// the shell_escape configuration query, which is not an academic TeX file.
const buildFiles = [...dockerfile.matchAll(/kpsewhich\s+([^\s;|]+)\s+>[\s\S]{0,20}?\/dev\/null/g)]
  .map((m) => m[1])
  .filter((name) => name !== '--var-value')
  .filter((name) => /\.(?:cls|bst|sty|tfm)$/.test(name));
const doctorMatch = doctor.match(/TEX_REQUIRED='([^']+)'/);
if (!doctorMatch) {
  console.error('INCOMPLETE: doctor.sh has no machine-readable TEX_REQUIRED list');
  process.exit(2);
}
const doctorFiles = doctorMatch[1].trim().split(/\s+/).filter(Boolean);
const unique = (xs) => [...new Set(xs)].sort();
const build = unique(buildFiles);
const checked = unique(doctorFiles);
const missingFromDoctor = build.filter((x) => !checked.includes(x));
const extraInDoctor = checked.filter((x) => !build.includes(x));
console.log(`Dockerfile build gate: ${build.length} file(s): ${build.join(', ')}`);
console.log(`doctor.sh runtime gate: ${checked.length} file(s): ${checked.join(', ')}`);
if (missingFromDoctor.length || extraInDoctor.length) {
  if (missingFromDoctor.length) console.log(`missing from doctor: ${missingFromDoctor.join(', ')}`);
  if (extraInDoctor.length) console.log(`extra in doctor: ${extraInDoctor.join(', ')}`);
  console.log('DRIFT: build and doctor TeX requirements differ');
  process.exit(1);
}
console.log(`OK: both gates require the same ${build.length} file(s)`);
