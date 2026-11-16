#!/usr/bin/env node
// Flags, per answer, whether the qualifications earlier reviews found fragile are stated; a screen for manual review, not a grade.
import fs from 'node:fs';
import path from 'node:path';

const CHECKS = {
  statefulSetGate: /StatefulSetAutoDeletePVC|feature gate/i,
  etcdDefaultUnencrypted: /(?:not|un)encrypted|plain ?text|stored unencrypted|without encryption/i,
  hpaNotReadyZero: /not[- ]yet[- ]ready|not ready/i,
  countdownLine1008: /pod-v1\.md[^\n]{0,40}?(?:1008|100[0-7][-–]10(?:0[89]|[1-9]\d))/,
  cniEnforcement: /network plugin|CNI/i,
  createPodSecretAccess: /creat(?:e|ing) (?:a )?Pods?/i,
};

for (const dir of process.argv.slice(2)) {
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.answer.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const flags = Object.entries(CHECKS).map(([name, pattern]) => `${pattern.test(text) ? '+' : '-'}${name}`);
    console.log(`${path.basename(dir)}/${file}`.padEnd(60), flags.join(' '));
  }
}
