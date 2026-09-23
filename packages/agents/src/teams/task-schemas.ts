import { z } from 'zod';

export const TeamNameSchema = z.enum(['production', 'debugging', 'deployment']);
export type TeamName = z.infer<typeof TeamNameSchema>;

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'blocked', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ResultStatusSchema = z.enum(['done', 'failed', 'blocked']);
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskAssessmentSchema = z.object({
  level: RiskLevelSchema,
  score: z.number().min(0).max(10), // 0-3: low, 4-7: medium, 8-10: high
  reasons: z.array(z.string()),
  requiresApproval: z.boolean().default(false)
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const TaskSchema = z.object({
  taskId: z.string().describe('Unique ID of the task'),
  parentTaskId: z.string().nullable().optional().describe('Parent task ID if sub-delegated'),
  assignedTeam: TeamNameSchema.describe('Target team responsible for executing the task'),
  taskType: z.string().describe('Categorical type of work (e.g. feature, bugfix, deploy, security)'),
  context: z.record(z.any()).default({}).describe('Payload including files, errors, and parameters'),
  expectedOutput: z.string().describe('Description of the criteria defining task completion'),
  maxIterations: z.number().default(5).describe('Maximum delegation loops before escalating'),
  status: TaskStatusSchema.default('pending'),
  riskLevel: RiskLevelSchema.optional().default('low')
});
export type Task = z.infer<typeof TaskSchema>;

export const ResultSchema = z.object({
  taskId: z.string(),
  status: ResultStatusSchema,
  output: z.record(z.any()).default({}),
  iterationsUsed: z.number(),
  notes: z.string(),
  riskEvaluated: RiskAssessmentSchema.optional()
});
export type Result = z.infer<typeof ResultSchema>;

export const TeamDecisionSchema = z.object({
  action: z.enum(['call_skill', 'sub_delegate', 'complete']).describe('Action chosen by team agent'),
  skillName: z.string().optional().describe('Skill to execute if action is call_skill'),
  skillArgs: z.record(z.any()).optional().describe('Arguments for the skill function'),
  subTask: TaskSchema.optional().describe('Sub-task payload if action is sub_delegate'),
  rationale: z.string().describe('Reasoning explaining why this action was selected')
});
export type TeamDecision = z.infer<typeof TeamDecisionSchema>;
