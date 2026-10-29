import type { LintResult } from '../storage/lint.js';
import type { ContextDoctorResult } from '../doctor/doctor.js';

const sample = (items: string[]) => items.slice(0, 3).map(item => item.slice(0, 500));
export function compactLint(result: LintResult) {
  return { errors: sample(result.errors), warnings: sample(result.warnings),
    counts: { errors: result.errors.length, warnings: result.warnings.length,
      categories: Object.fromEntries(Object.entries(result.categories).map(([key, values]) => [key, values.length])) },
    detail: 'summary', fullData: 'Run lint --full for all diagnostics.' };
}

export function compactDoctor(result: ContextDoctorResult) {
  return { ...result, diagnostics: result.diagnostics.map(d => ({ ...d, message: d.message.slice(0, 500),
    ...(d.details ? { details: sample(d.details), detailCount: d.details.length } : {}) })),
    ...(result.fixes ? { fixes: result.fixes.slice(0, 5).map(f => ({ id: f.id, title: f.title.slice(0, 500), risk: f.risk })), fixCount: result.fixes.length } : {}),
    detail: 'summary' };
}
