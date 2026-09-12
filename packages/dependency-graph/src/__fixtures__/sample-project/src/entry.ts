import { relativeValue } from './relative-target';
import { aliasValue } from '@alias/alias-target';

export async function run() {
  const dynamicMod = await import('./dynamic-target');
  return {
    relative: relativeValue,
    alias: aliasValue,
    dynamic: dynamicMod.dynamicValue
  };
}
