import { prepareStartupSnapshot } from '../system-assistant/model.js';
import { isPathWithin } from './core.js';

/** Explicit target paths only: names and publishers cannot establish ownership. */
export function relatedStartupItems(snapshot, root) {
    const prepared = prepareStartupSnapshot(snapshot);
    const matching = prepared.items.filter(item => isPathWithin(item.targetPath, root));
    return {
        total: matching.length,
        items: matching.slice(0, 20).map(({ name, targetPath, enabled }) => ({ name, targetPath, enabled })),
        warnings: prepared.warnings.slice(0, 20)
    };
}
