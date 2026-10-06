// Keep the download's notices aligned with the actual installed production graph.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locations = [...Object.entries(lock.packages).filter(([name, entry]) => name.startsWith('node_modules/') && !entry.dev).map(([name]) => name), 'node_modules/electron'];
const packages = new Map();
for (const relative of locations) {
  const directory = path.join(root, relative), filename = path.join(directory, 'package.json');
  if (!fs.existsSync(filename)) continue; // Optional binaries for another platform are not shipped.
  const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const identity = `${metadata.name}@${metadata.version}`;
  if (packages.has(identity)) continue;
  const licenses = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:licen[sc]e|notice|copying)(?:[._-]|$)/i.test(entry.name))
    .map(entry => ({ name: entry.name, text: fs.readFileSync(path.join(directory, entry.name), 'utf8').trim() }));
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || metadata.homepage || '';
  const license = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type || 'See bundled license files';
  packages.set(identity, { identity, license, repository, licenses });
}
const lines = [`Black Cat Reseller ${app.version} — third-party notices`, '',
  'This application includes open-source components under their own licenses.',
  'The list below is generated from the installed Windows production dependencies, plus Electron.',
  'Chromium notices are included in LICENSES.chromium.html with the Electron distribution.',
  'Individual dependency license files remain with their packages.', '',
  ...[...packages.values()].sort((a, b) => a.identity.localeCompare(b.identity)).flatMap(entry => [
    `${entry.identity} | ${entry.license}`, entry.repository, ...entry.licenses.flatMap(license => ['', `--- ${license.name} ---`, license.text]), '',
  ]),
  'SEPARATELY DOWNLOADED OPTIONAL / WORKER COMPONENTS', '',
  'Photo worker setup downloads CPython (Python Software Foundation License), and the packages listed in worker/requirements.txt from their upstream distributions. Their included notices remain in the installed runtime. pyzbar uses the LGPL ZBar library; Playwright downloads Chromium with its notices.',
  'Optional local AI setup downloads llama.cpp b10218 (MIT, https://github.com/ggml-org/llama.cpp), NVIDIA CUDA runtime redistributables (https://docs.nvidia.com/cuda/eula/index.html), and Qwen3.5-4B model files (Apache-2.0, https://huggingface.co/Qwen/Qwen3.5-4B). The pinned community quantizations and hashes are recorded in config/local-vision.json and config/local-vision-q6-benchmark.json. These machine assets are not bundled in this installer.', '',
];
const destination = path.join(root, 'THIRD_PARTY_NOTICES.txt'), text = lines.join('\n').replace(/[ \t]+$/gm, '');
if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== text) fs.writeFileSync(destination, text);
console.log(`Notices checked for ${packages.size} installed component versions.`);
