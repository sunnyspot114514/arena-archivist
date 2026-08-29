import type { DailyRunBudgetPort } from './types.js';

export class InMemoryDailyRunBudget implements DailyRunBudgetPort {
  private readonly runsByUtcDate = new Map<string, number>();

  constructor(private readonly maxRunsPerDay = 3) {
    if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1) {
      throw new Error('maxRunsPerDay must be a positive integer');
    }
  }

  async tryStart(now: Date): Promise<boolean> {
    const day = now.toISOString().slice(0, 10);
    const runs = this.runsByUtcDate.get(day) ?? 0;
    if (runs >= this.maxRunsPerDay) return false;
    this.runsByUtcDate.set(day, runs + 1);
    return true;
  }
}
