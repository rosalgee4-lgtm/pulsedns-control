import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolveSourceFile(join(workspaceRoot, specifier.slice(2)));
    if (!target) throw new Error(`Unable to resolve test alias: ${specifier}`);
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = resolveSourceFile(fileURLToPath(new URL(specifier, context.parentURL)));
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}

function resolveSourceFile(base) {
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(isFile);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
